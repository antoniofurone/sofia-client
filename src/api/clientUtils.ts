import type { Part, A2AMessage } from '../types/a2a';

export function uuid(): string {
  return crypto.randomUUID();
}

export function jsonRpcPayload(method: string, params: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: uuid(), method, params };
}

export function buildMessage(parts: Part[], contextId?: string, history?: A2AMessage[]) {
  const msg: Record<string, unknown> = { messageId: uuid(), role: 'user', parts };
  if (contextId) msg['contextId'] = contextId;
  const params: Record<string, unknown> = { message: msg };
  if (history && history.length > 0) params['history'] = history;
  return params;
}

export function normalizePart(p: Record<string, unknown>): Part {
  const kind = (p['kind'] ?? p['type'] ?? 'text') as string;
  if (kind === 'text') return { kind: 'text', text: (p['text'] as string) ?? '', mimeType: p['mimeType'] as string | undefined };
  if (kind === 'file') return { kind: 'file', file: (p['file'] as Part extends { kind: 'file' } ? Part['file'] : never) ?? {} };
  if (kind === 'data') return { kind: 'data', data: (p['data'] as Record<string, unknown>) ?? {}, mimeType: p['mimeType'] as string | undefined };
  return { kind: 'text', text: JSON.stringify(p, null, 2) };
}

export function extractContextId(responseJson: Record<string, unknown>): string | undefined {
  const result = (responseJson['result'] ?? {}) as Record<string, unknown>;
  return (
    (result['contextId'] as string | undefined) ??
    (result['context_id'] as string | undefined) ??
    ((result['message'] as Record<string, unknown> | undefined)?.['contextId'] as string | undefined)
  );
}

/**
 * Accumulates the parts of a streamed chunk into `acc` (mutated in place).
 * A2A TaskArtifactUpdateEvent.append=true means the chunk continues the
 * previous artifact content: consecutive text parts are concatenated instead of
 * being rendered as separate paragraphs (token-by-token streaming).
 * The last element is replaced, not mutated, since earlier snapshots of `acc`
 * may still be held by React state.
 */
export function appendParts(acc: Part[], incoming: Part[], append?: boolean): void {
  for (let i = 0; i < incoming.length; i++) {
    const part = incoming[i];
    const last = acc[acc.length - 1];
    if (i === 0 && append && last && last.kind === 'text' && part.kind === 'text') {
      acc[acc.length - 1] = { ...last, text: last.text + part.text };
    } else {
      acc.push(part);
    }
  }
}
