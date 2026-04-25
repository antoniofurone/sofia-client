import type { A2AMessage, AgentCard, Part } from '../types/a2a';
import { uuid, jsonRpcPayload, buildMessage, normalizePart, extractContextId } from './clientUtils';

// ---------------------------------------------------------------------------
// Debug client — talks directly to agents (via Vite proxy in dev,
// or directly in production debug builds).
// ---------------------------------------------------------------------------

function agentFetch(
  targetUrl: string,
  init: RequestInit = {},
  apiKey?: string,
  proxyUrl?: string,
  noProxy?: string,
): Promise<Response> {
  const extraHeaders: Record<string, string> = {};
  if (apiKey) extraHeaders['X-API-Key'] = apiKey;

  if (import.meta.env.DEV) {
    if (proxyUrl) extraHeaders['x-a2a-proxy-url'] = proxyUrl;
    if (noProxy)  extraHeaders['x-a2a-no-proxy']  = noProxy;
    return fetch('/a2a-proxy', {
      ...init,
      headers: { ...(init.headers ?? {}), ...extraHeaders, 'x-a2a-target': encodeURIComponent(targetUrl) },
    });
  }
  return fetch(targetUrl, {
    ...init,
    headers: { ...(init.headers ?? {}), ...extraHeaders },
  });
}

function extractParts(responseJson: Record<string, unknown>): Part[] {
  const error = responseJson['error'] as Record<string, unknown> | undefined;
  if (error) return [{ kind: 'text', text: `[A2A Error ${error['code'] ?? ''}]: ${error['message'] ?? ''}` }];

  const result = (responseJson['result'] ?? {}) as Record<string, unknown>;
  if (!result || Object.keys(result).length === 0) return [{ kind: 'text', text: JSON.stringify(responseJson, null, 2) }];

  const collected: Part[] = [];
  for (const p of (result['parts'] as Record<string, unknown>[] | undefined) ?? []) collected.push(normalizePart(p));
  const msg = result['message'] as Record<string, unknown> | undefined;
  for (const p of (msg?.['parts'] as Record<string, unknown>[] | undefined) ?? []) collected.push(normalizePart(p));
  for (const artifact of (result['artifacts'] as Record<string, unknown>[] | undefined) ?? []) {
    for (const p of (artifact['parts'] as Record<string, unknown>[] | undefined) ?? []) collected.push(normalizePart(p));
  }
  if (collected.length === 0) {
    const history = (result['history'] as Record<string, unknown>[] | undefined) ?? [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]['role'] === 'agent') {
        for (const p of (history[i]['parts'] as Record<string, unknown>[] | undefined) ?? []) collected.push(normalizePart(p));
        break;
      }
    }
  }
  return collected.length ? collected : [{ kind: 'text', text: JSON.stringify(result, null, 2) }];
}

export async function fetchAgentCard(baseUrl: string, apiKey?: string, proxyUrl?: string, noProxy?: string): Promise<AgentCard> {
  const base = baseUrl.replace(/\/$/, '');
  for (const path of ['/.well-known/agent.json', '/.well-known/agent-card.json']) {
    const res = await agentFetch(`${base}${path}`, {}, apiKey, proxyUrl, noProxy);
    if (res.ok) {
      const card: AgentCard = await res.json();
      if (card.url && !card.url.startsWith('http')) card.url = `${base}${card.url}`;
      return card;
    }
  }
  throw new Error('Agent card not found (/.well-known/agent.json)');
}

export async function sendChat(
  agentRpcUrl: string,
  parts: Part[],
  contextId?: string,
  apiKey?: string,
  proxyUrl?: string,
  noProxy?: string,
  history?: A2AMessage[],
): Promise<{ parts: Part[]; context_id: string; debug: { request: Record<string, unknown>; response: Record<string, unknown> } }> {
  const payload = jsonRpcPayload('message/send', buildMessage(parts, contextId, history));
  const res = await agentFetch(agentRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, apiKey, proxyUrl, noProxy);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data: Record<string, unknown> = await res.json();
  return { parts: extractParts(data), context_id: extractContextId(data) ?? contextId ?? '', debug: { request: payload, response: data } };
}

export async function* streamChat(
  agentRpcUrl: string,
  parts: Part[],
  contextId?: string,
  apiKey?: string,
  proxyUrl?: string,
  noProxy?: string,
  history?: A2AMessage[],
): AsyncGenerator<{ parts: Part[]; context_id: string; done: boolean; rawEvent?: Record<string, unknown> }> {
  const payload = jsonRpcPayload('message/stream', buildMessage(parts, contextId, history));
  const res = await agentFetch(agentRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
  }, apiKey, proxyUrl, noProxy);

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentContextId = contextId ?? '';

  const parseSseLine = (line: string) => {
    if (!line.startsWith('data:')) return null;
    const raw = line.slice(5).trim();
    if (!raw) return null;
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw); } catch { return null; }

    const result = (event['result'] ?? {}) as Record<string, unknown>;
    const kind = result['kind'] as string | undefined;
    const cid = (result['contextId'] ?? result['context_id']) as string | undefined;
    if (cid) currentContextId = cid;

    const isFinal =
      (result['final'] as boolean | undefined) === true ||
      (result['status'] as Record<string, unknown> | undefined)?.['state'] === 'completed' ||
      (result['status'] as Record<string, unknown> | undefined)?.['state'] === 'failed';

    let outParts: Part[] = [];
    if (kind === 'artifact-update') {
      const artifact = (result['artifact'] ?? {}) as Record<string, unknown>;
      outParts = ((artifact['parts'] as Record<string, unknown>[] | undefined) ?? []).map(normalizePart);
    } else if (kind === 'message' || !kind) {
      outParts = ((result['parts'] as Record<string, unknown>[] | undefined) ?? []).map(normalizePart);
      for (const artifact of (result['artifacts'] as Record<string, unknown>[] | undefined) ?? []) {
        outParts.push(...((artifact['parts'] as Record<string, unknown>[] | undefined) ?? []).map(normalizePart));
      }
    }

    if (outParts.length > 0 || isFinal) return { parts: outParts, context_id: currentContextId, done: isFinal, rawEvent: event };
    return null;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        const parsed = parseSseLine(line);
        if (parsed) { yield parsed; if (parsed.done) return; }
      }
    }
  }
  for (const line of buffer.split('\n')) {
    const parsed = parseSseLine(line);
    if (parsed) yield parsed;
  }
}

// Re-export shared utilities for convenience
export { uuid, jsonRpcPayload, buildMessage, normalizePart, extractContextId };
