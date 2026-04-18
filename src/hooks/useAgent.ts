import { useState, useCallback } from 'react';
import type { AgentCard } from '../types/a2a';
import { fetchAgentCard } from '../api/client';

interface UseAgentOptions {
  onError?: (msg: string) => void;
}

interface UseAgentReturn {
  card: AgentCard | null;
  agentRpcUrl: string | null;
  apiKey: string;
  isConnecting: boolean;
  connect: (baseUrl: string, apiKey: string, proxyUrl?: string, noProxy?: string) => Promise<void>;
  disconnect: () => void;
}

export function useAgent({ onError }: UseAgentOptions = {}): UseAgentReturn {
  const [card, setCard] = useState<AgentCard | null>(null);
  const [agentRpcUrl, setAgentRpcUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);

  const connect = useCallback(async (baseUrl: string, key: string, proxyUrl?: string, noProxy?: string) => {
    setIsConnecting(true);
    setCard(null);
    setAgentRpcUrl(null);
    setApiKey(key);
    try {
      const agentCard = await fetchAgentCard(baseUrl, key, proxyUrl || undefined, noProxy || undefined);
      setCard(agentCard);
      setAgentRpcUrl(agentCard.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onError?.(msg);
      setCard(null);
      setAgentRpcUrl(null);
      setApiKey('');
    } finally {
      setIsConnecting(false);
    }
  }, [onError]);

  const disconnect = useCallback(() => {
    setCard(null);
    setAgentRpcUrl(null);
    setApiKey('');
  }, []);

  return { card, agentRpcUrl, apiKey, isConnecting, connect, disconnect };
}
