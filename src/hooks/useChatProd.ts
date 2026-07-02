import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatMessage, DebugInfo, Part } from '../types/a2a';
import { sendChatProd, streamChatProd } from '../api/prodClient';

// Client-side timeout: if no SSE chunk arrives within this window, abort.
const CLIENT_STREAM_TIMEOUT_MS = 180_000; // 180 s — aligned with server proxy and Python test

interface UseChatProdOptions {
  agentName: string | null;
  streaming: boolean;
  onError?: (msg: string) => void;
  onSessionExpired?: (authMode: string) => void;
}

interface UseChatProdReturn {
  messages: ChatMessage[];
  isBusy: boolean;
  sendParts: (parts: Part[]) => Promise<void>;
  clearMessages: () => void;
}

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useChatProd({ agentName, streaming, onError, onSessionExpired }: UseChatProdOptions): UseChatProdReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const contextIdRef = useRef<string | null>(null);
  const sessionId = useRef<string>(crypto.randomUUID());
  const abortRef = useRef<AbortController | null>(null);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages(prev => [...prev, msg]);
  }, []);

  const updateMessage = useCallback((id: string, updater: (m: ChatMessage) => ChatMessage) => {
    setMessages(prev => prev.map(m => m.id === id ? updater(m) : m));
  }, []);

  // Cancel any in-flight stream when agent changes or component unmounts
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    contextIdRef.current = null;
    sessionId.current = crypto.randomUUID();
    setMessages([]);
    setIsBusy(false);
  }, [agentName]);

  const handleError = useCallback((err: unknown) => {
    const e = err as { sessionExpired?: boolean; authMode?: string; message?: string; name?: string };
    if (e.sessionExpired) {
      onSessionExpired?.(e.authMode ?? 'user');
    } else if (e.name === 'AbortError') {
      // Cancelled by us (agent change / unmount / timeout) — surface a friendly message
      onError?.('Request cancelled: agent did not respond in time.');
    } else {
      onError?.(e.message ?? String(err));
    }
  }, [onError, onSessionExpired]);

  const sendParts = useCallback(async (parts: Part[]) => {
    if (!agentName || isBusy) return;

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const effectiveContextId = contextIdRef.current ?? sessionId.current;
    const userMsg: ChatMessage = { id: generateId(), role: 'user', parts, timestamp: new Date() };
    addMessage(userMsg);
    setIsBusy(true);

    try {
      if (streaming) {
        const agentMsgId = generateId();
        addMessage({ id: agentMsgId, role: 'agent', parts: [], streaming: true, timestamp: new Date() });

        const accumulated: Part[] = [];
        const rawEvents: Record<string, unknown>[] = [];
        const requestPayload = { method: 'message/stream', agentName, contextId: effectiveContextId, parts };

        // Client-side no-data watchdog: if no chunk arrives within CLIENT_STREAM_TIMEOUT_MS, abort.
        let watchdog = setTimeout(() => controller.abort(), CLIENT_STREAM_TIMEOUT_MS);
        const resetWatchdog = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => controller.abort(), CLIENT_STREAM_TIMEOUT_MS);
        };

        let reachedFinal = false;
        try {
          const gen = streamChatProd(agentName, parts, effectiveContextId, controller.signal);
          for await (const chunk of gen) {
            resetWatchdog();
            if (chunk.context_id) contextIdRef.current = chunk.context_id;
            if (chunk.rawEvent) rawEvents.push(chunk.rawEvent);
            if (chunk.parts.length > 0) {
              accumulated.push(...chunk.parts);
              updateMessage(agentMsgId, m => ({ ...m, parts: [...accumulated] }));
            }
            if (chunk.done) {
              reachedFinal = true;
              const debug: DebugInfo = { request: requestPayload, response: { events: rawEvents } };
              updateMessage(agentMsgId, m => ({ ...m, streaming: false, debug }));
              break;
            }
          }
        } finally {
          clearTimeout(watchdog);
          // The SSE body ended (clean EOF or our own watchdog abort) without ever
          // sending a final status — the connection was cut somewhere between us
          // and the agent while the task was still running. Distinguish that from
          // a genuinely empty-but-complete response ("_Task completed._") so the
          // user isn't left staring at a bubble that just stopped with no
          // explanation (the previous behavior for both cases).
          if (!reachedFinal) {
            const errMsg = 'Connessione interrotta: l\'agente non ha inviato una risposta finale.';
            onError?.(errMsg);
            updateMessage(agentMsgId, m => ({
              ...m,
              streaming: false,
              parts: m.parts.length > 0 ? m.parts : [{ kind: 'text', text: `⚠ ${errMsg}` }],
              error: errMsg,
            }));
          } else {
            updateMessage(agentMsgId, m => ({
              ...m,
              streaming: false,
              // If the agent completed but sent no visible parts (e.g. a pure
              // status-update with no message/artifact payload), show a minimal
              // notice so the bubble is never left silently empty.
              parts: m.parts.length > 0
                ? m.parts
                : [{ kind: 'text', text: '_Task completed._' }],
            }));
          }
        }

      } else {
        const result = await sendChatProd(agentName, parts, effectiveContextId);
        if (result.context_id) contextIdRef.current = result.context_id;
        addMessage({ id: generateId(), role: 'agent', parts: result.parts, debug: result.debug, timestamp: new Date() });
      }
    } catch (err) {
      handleError(err);
      if (!(err instanceof Error && err.name === 'AbortError')) {
        addMessage({
          id: generateId(),
          role: 'system',
          parts: [{ kind: 'text', text: `⚠ ${(err as Error).message}` }],
          error: String(err),
          timestamp: new Date(),
        });
      }
    } finally {
      setIsBusy(false);
    }
  }, [agentName, streaming, isBusy, addMessage, updateMessage, handleError]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    contextIdRef.current = null;
    sessionId.current = crypto.randomUUID();
  }, []);

  return { messages, isBusy, sendParts, clearMessages };
}
