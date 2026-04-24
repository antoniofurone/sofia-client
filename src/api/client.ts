import type { A2AMessage, AgentCard, Part } from '../types/a2a'

// ---------------------------------------------------------------------------
// Proxy helpers
// In dev (vite) we route through the built-in proxy plugin to avoid CORS.
// In production the browser calls the agent directly — make sure the agent
// has CORS headers (most hosted A2A agents do).
// ---------------------------------------------------------------------------

const DEV = import.meta.env.DEV

/** Build fetch options that target the agent directly or via the dev proxy. */
function agentFetch(
  targetUrl: string,
  init: RequestInit = {},
  apiKey?: string,
  proxyUrl?: string,
  noProxy?: string,
): Promise<Response> {
  const extraHeaders: Record<string, string> = {};
  if (apiKey) extraHeaders['X-API-Key'] = apiKey;

  if (DEV) {
    // proxyUrl and noProxy are forwarded to the Vite plugin, applied server-side
    if (proxyUrl) extraHeaders['x-a2a-proxy-url'] = proxyUrl;
    if (noProxy)  extraHeaders['x-a2a-no-proxy']  = noProxy;
    return fetch('/a2a-proxy', {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...extraHeaders,
        'x-a2a-target': encodeURIComponent(targetUrl),
      },
    })
  }
  // In production the browser calls the agent directly.
  // Proxy cannot be applied here — configure a system/network-level proxy instead.
  return fetch(targetUrl, {
    ...init,
    headers: { ...(init.headers ?? {}), ...extraHeaders },
  })
}

// ---------------------------------------------------------------------------
// A2A helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID()
}

function jsonRpcPayload(method: string, params: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: uuid(), method, params }
}

function buildMessage(parts: Part[], contextId?: string, history?: A2AMessage[]) {
  const msg: Record<string, unknown> = {
    messageId: uuid(),
    role: 'user',
    parts,
  }
  if (contextId) msg['contextId'] = contextId
  const params: Record<string, unknown> = { message: msg }
  if (history && history.length > 0) params['history'] = history
  return params
}

// ---------------------------------------------------------------------------
// Part normalisation — handles slight variations between A2A implementations
// ---------------------------------------------------------------------------

function normalizePart(p: Record<string, unknown>): Part {
  const kind = (p['kind'] ?? p['type'] ?? 'text') as string
  if (kind === 'text') {
    return { kind: 'text', text: (p['text'] as string) ?? '', mimeType: p['mimeType'] as string | undefined }
  }
  if (kind === 'file') {
    return { kind: 'file', file: (p['file'] as Part extends { kind: 'file' } ? Part['file'] : never) ?? {} }
  }
  if (kind === 'data') {
    return { kind: 'data', data: (p['data'] as Record<string, unknown>) ?? {}, mimeType: p['mimeType'] as string | undefined }
  }
  // unknown part type — wrap as text
  return { kind: 'text', text: JSON.stringify(p, null, 2) }
}

function extractParts(responseJson: Record<string, unknown>): Part[] {
  const error = responseJson['error'] as Record<string, unknown> | undefined
  if (error) {
    return [{ kind: 'text', text: `[A2A Error ${error['code'] ?? ''}]: ${error['message'] ?? ''}` }]
  }

  const result = (responseJson['result'] ?? {}) as Record<string, unknown>
  if (!result || Object.keys(result).length === 0) {
    return [{ kind: 'text', text: JSON.stringify(responseJson, null, 2) }]
  }

  const collected: Part[] = []

  // 1. Direct parts on result (Message response)
  for (const p of (result['parts'] as Record<string, unknown>[] | undefined) ?? []) {
    collected.push(normalizePart(p))
  }

  // 2. Nested message.parts
  const msg = result['message'] as Record<string, unknown> | undefined
  for (const p of (msg?.['parts'] as Record<string, unknown>[] | undefined) ?? []) {
    collected.push(normalizePart(p))
  }

  // 3. Task artifacts
  for (const artifact of (result['artifacts'] as Record<string, unknown>[] | undefined) ?? []) {
    for (const p of (artifact['parts'] as Record<string, unknown>[] | undefined) ?? []) {
      collected.push(normalizePart(p))
    }
  }

  // 4. History — last agent message
  if (collected.length === 0) {
    const history = (result['history'] as Record<string, unknown>[] | undefined) ?? []
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]['role'] === 'agent') {
        for (const p of (history[i]['parts'] as Record<string, unknown>[] | undefined) ?? []) {
          collected.push(normalizePart(p))
        }
        break
      }
    }
  }

  if (collected.length === 0) {
    return [{ kind: 'text', text: JSON.stringify(result, null, 2) }]
  }
  return collected
}

function extractContextId(responseJson: Record<string, unknown>): string | undefined {
  const result = (responseJson['result'] ?? {}) as Record<string, unknown>
  return (
    (result['contextId'] as string | undefined) ??
    (result['context_id'] as string | undefined) ??
    ((result['message'] as Record<string, unknown> | undefined)?.['contextId'] as string | undefined)
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchAgentCard(baseUrl: string, apiKey?: string, proxyUrl?: string, noProxy?: string): Promise<AgentCard> {
  const base = baseUrl.replace(/\/$/, '')
  // Try both well-known paths
  for (const path of ['/.well-known/agent.json', '/.well-known/agent-card.json']) {
    const res = await agentFetch(`${base}${path}`, {}, apiKey, proxyUrl, noProxy)
    if (res.ok) {
      const card: AgentCard = await res.json()
      // Ensure card.url is absolute
      if (card.url && !card.url.startsWith('http')) {
        card.url = `${base}${card.url}`
      }
      return card
    }
  }
  throw new Error('Agent card not found (/.well-known/agent.json)')
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
  const payload = jsonRpcPayload('message/send', buildMessage(parts, contextId, history))
  const res = await agentFetch(agentRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, apiKey, proxyUrl, noProxy)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  const data: Record<string, unknown> = await res.json()
  return {
    parts: extractParts(data),
    context_id: extractContextId(data) ?? contextId ?? '',
    debug: { request: payload, response: data },
  }
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
  const payload = jsonRpcPayload('message/stream', buildMessage(parts, contextId, history))
  const res = await agentFetch(agentRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
  }, apiKey, proxyUrl, noProxy)

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentContextId = contextId ?? ''

  const parseSseLine = (line: string): { parts: Part[]; context_id: string; done: boolean; rawEvent?: Record<string, unknown> } | null => {
    if (!line.startsWith('data:')) return null
    const raw = line.slice(5).trim()
    if (!raw) return null

    let event: Record<string, unknown>
    try { event = JSON.parse(raw) } catch { return null }

    const result = (event['result'] ?? {}) as Record<string, unknown>
    const kind = result['kind'] as string | undefined

    // Update contextId
    const cid = (result['contextId'] ?? result['context_id']) as string | undefined
    if (cid) currentContextId = cid

    const isFinal =
      (result['final'] as boolean | undefined) === true ||
      (result['status'] as Record<string, unknown> | undefined)?.['state'] === 'completed' ||
      (result['status'] as Record<string, unknown> | undefined)?.['state'] === 'failed'

    let outParts: Part[] = []

    if (kind === 'artifact-update') {
      const artifact = (result['artifact'] ?? {}) as Record<string, unknown>
      for (const p of (artifact['parts'] as Record<string, unknown>[] | undefined) ?? []) {
        outParts.push(normalizePart(p))
      }
    } else if (kind === 'message' || !kind) {
      for (const p of (result['parts'] as Record<string, unknown>[] | undefined) ?? []) {
        outParts.push(normalizePart(p))
      }
      for (const artifact of (result['artifacts'] as Record<string, unknown>[] | undefined) ?? []) {
        for (const p of (artifact['parts'] as Record<string, unknown>[] | undefined) ?? []) {
          outParts.push(normalizePart(p))
        }
      }
    }

    if (outParts.length > 0 || isFinal) {
      return { parts: outParts, context_id: currentContextId, done: isFinal, rawEvent: event }
    }
    return null
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      for (const line of block.split('\n')) {
        const parsed = parseSseLine(line)
        if (parsed) {
          yield parsed
          if (parsed.done) return
        }
      }
    }
  }

  // flush remaining
  for (const line of buffer.split('\n')) {
    const parsed = parseSseLine(line)
    if (parsed) yield parsed
  }
}
