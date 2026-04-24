import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatMessage, DebugInfo, Part } from '../types/a2a';
import { sendChat, streamChat } from '../api/client';

interface UseChatOptions {
  agentRpcUrl: string | null;
  apiKey: string;
  proxyUrl?: string;
  noProxy?: string;
  streaming: boolean;
  onError?: (msg: string) => void;
}

interface UseChatReturn {
  messages: ChatMessage[];
  contextId: string | null;
  isBusy: boolean;
  sendParts: (parts: Part[]) => Promise<void>;
  clearMessages: () => void;
}

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useChat({ agentRpcUrl, apiKey, proxyUrl, noProxy, streaming, onError }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [contextId, setContextId] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const contextIdRef = useRef<string | null>(null);
  // Stable snapshot of messages readable synchronously inside callbacks,
  // bypassing React's async state batching — critical for building history
  // before addMessage() triggers a re-render.
  const messagesRef = useRef<ChatMessage[]>([]);
  // Per-page-load session ID: used as contextId fallback so concurrent users
  // hitting the same stateless agent never share a conversation chain.
  const sessionId = useRef<string>(crypto.randomUUID());

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages(prev => {
      const next = [...prev, msg];
      messagesRef.current = next;
      return next;
    });
  }, []);

  const updateMessage = useCallback((id: string, updater: (m: ChatMessage) => ChatMessage) => {
    setMessages(prev => {
      const next = prev.map(m => m.id === id ? updater(m) : m);
      messagesRef.current = next;
      return next;
    });
  }, []);

  // Reset context when the agent changes so the new agent never receives
  // a contextId that belongs to a different agent's conversation.
  useEffect(() => {
    contextIdRef.current = null;
    setContextId(null);
    messagesRef.current = [];
    sessionId.current = crypto.randomUUID();
  }, [agentRpcUrl]);

  const sendParts = useCallback(async (parts: Part[]) => {
    if (!agentRpcUrl || isBusy) return;

    // Use the contextId returned by the agent, or fall back to the per-session
    // UUID so that concurrent users on a stateless agent stay isolated and
    // the first message already carries a stable contextId (the backend uses
    // it to group all turns of the same conversation via find_by_context_id).
    const effectiveContextId = contextIdRef.current ?? sessionId.current;

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      parts,
      timestamp: new Date(),
    };
    addMessage(userMsg);
    setIsBusy(true);

    try {
      if (streaming) {
        const agentMsgId = generateId();
        const agentMsg: ChatMessage = {
          id: agentMsgId,
          role: 'agent',
          parts: [],
          streaming: true,
          timestamp: new Date(),
        };
        addMessage(agentMsg);

        const requestPayload = { method: 'message/stream', agentUrl: agentRpcUrl, contextId: effectiveContextId, parts };
        const gen = streamChat(agentRpcUrl, parts, effectiveContextId, apiKey || undefined, proxyUrl || undefined, noProxy || undefined);
        const accumulated: Part[] = [];
        const rawEvents: Record<string, unknown>[] = [];

        for await (const chunk of gen) {
          if (chunk.context_id) {
            contextIdRef.current = chunk.context_id;
            setContextId(chunk.context_id);
          }
          if (chunk.rawEvent) rawEvents.push(chunk.rawEvent);
          if (chunk.parts && chunk.parts.length > 0) {
            accumulated.push(...chunk.parts);
            updateMessage(agentMsgId, m => ({ ...m, parts: [...accumulated] }));
          }
          if (chunk.done) {
            const debug: DebugInfo = { request: requestPayload, response: { events: rawEvents } };
            updateMessage(agentMsgId, m => ({ ...m, streaming: false, debug }));
            break;
          }
        }
        updateMessage(agentMsgId, m => ({ ...m, streaming: false }));
      } else {
        const result = await sendChat(agentRpcUrl, parts, effectiveContextId, apiKey || undefined, proxyUrl || undefined, noProxy || undefined);
        if (result.context_id) {
          contextIdRef.current = result.context_id;
          setContextId(result.context_id);
        }
        const agentMsg: ChatMessage = {
          id: generateId(),
          role: 'agent',
          parts: result.parts,
          debug: result.debug,
          timestamp: new Date(),
        };
        addMessage(agentMsg);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Show in toast
      onError?.(errMsg);
      // Also show inline in chat
      const errChatMsg: ChatMessage = {
        id: generateId(),
        role: 'system',
        parts: [{ kind: 'text', text: `⚠ ${errMsg}` }],
        error: errMsg,
        timestamp: new Date(),
      };
      addMessage(errChatMsg);
    } finally {
      setIsBusy(false);
    }
  }, [agentRpcUrl, streaming, isBusy, addMessage, updateMessage]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    messagesRef.current = [];
    setContextId(null);
    contextIdRef.current = null;
    sessionId.current = crypto.randomUUID();
  }, []);

  return { messages, contextId, isBusy, sendParts, clearMessages };
}
