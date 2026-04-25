import type { Part } from '../types/a2a';
import { normalizePart, extractContextId, jsonRpcPayload, buildMessage } from './clientUtils';

// ---------------------------------------------------------------------------
// Production API client — routes all A2A traffic through the Express backend.
// The backend resolves agent URLs, injects credentials and user metadata.
// ---------------------------------------------------------------------------

export async function sendChatProd(
  agentName: string,
  parts: Part[],
  contextId?: string,
): Promise<{ parts: Part[]; context_id: string; debug: { request: Record<string, unknown>; response: Record<string, unknown> } }> {
  const payload = jsonRpcPayload('message/send', buildMessage(parts, contextId));
  const res = await fetch('/api/proxy/send', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName, payload }),
  });

  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error('Session expired'), { sessionExpired: true, authMode: data.authMode });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const data: Record<string, unknown> = await res.json();
  return {
    parts: extractPartsFromA2A(data),
    context_id: extractContextId(data) ?? contextId ?? '',
    debug: { request: payload, response: data },
  };
}

export async function* streamChatProd(
  agentName: string,
  parts: Part[],
  contextId?: string,
): AsyncGenerator<{ parts: Part[]; context_id: string; done: boolean; rawEvent?: Record<string, unknown> }> {
  const payload = jsonRpcPayload('message/stream', buildMessage(parts, contextId));
  const res = await fetch('/api/proxy/stream', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ agentName, payload }),
  });

  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error('Session expired'), { sessionExpired: true, authMode: data.authMode });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentContextId = contextId ?? '';

  const parseLine = (line: string) => {
    if (!line.startsWith('data:')) return null;
    const raw = line.slice(5).trim();
    if (!raw) return null;
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw); } catch { return null; }

    const result = (event['result'] ?? {}) as Record<string, unknown>;
    const cid = (result['contextId'] ?? result['context_id']) as string | undefined;
    if (cid) currentContextId = cid;

    const isFinal =
      (result['final'] as boolean | undefined) === true ||
      (result['status'] as Record<string, unknown> | undefined)?.['state'] === 'completed' ||
      (result['status'] as Record<string, unknown> | undefined)?.['state'] === 'failed';

    const kind = result['kind'] as string | undefined;
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

    if (outParts.length > 0 || isFinal) {
      return { parts: outParts, context_id: currentContextId, done: isFinal, rawEvent: event };
    }
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
        const parsed = parseLine(line);
        if (parsed) { yield parsed; if (parsed.done) return; }
      }
    }
  }
  for (const line of buffer.split('\n')) {
    const parsed = parseLine(line);
    if (parsed) yield parsed;
  }
}

export async function fetchAgentCardProd(agentName: string) {
  const res = await fetch(`/api/proxy/card?agentName=${encodeURIComponent(agentName)}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to fetch agent card: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Internal helpers (same logic as client.ts, extracted for reuse)
// ---------------------------------------------------------------------------
function extractPartsFromA2A(responseJson: Record<string, unknown>): Part[] {
  const error = responseJson['error'] as Record<string, unknown> | undefined;
  if (error) return [{ kind: 'text', text: `[A2A Error ${error['code'] ?? ''}]: ${error['message'] ?? ''}` }];

  const result = (responseJson['result'] ?? {}) as Record<string, unknown>;
  if (!result || Object.keys(result).length === 0) {
    return [{ kind: 'text', text: JSON.stringify(responseJson, null, 2) }];
  }

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
