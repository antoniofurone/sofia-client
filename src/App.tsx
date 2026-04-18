import { useState, useCallback } from 'react';
import { ConnectBar } from './components/ConnectBar';
import { AgentCard } from './components/AgentCard';
import { MessageList } from './components/MessageList';
import { InputArea } from './components/InputArea';
import { ErrorToast } from './components/ErrorToast';
import { SettingsBar } from './components/SettingsBar';
import { useAgent } from './hooks/useAgent';
import { useChat } from './hooks/useChat';
import { useSettings } from './hooks/useSettings';
import type { Part } from './types/a2a';

export default function App() {
  const [streaming, setStreaming] = useState(true);
  const [toastError, setToastError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const showError = useCallback((msg: string) => setToastError(msg), []);

  const { proxyUrl, noProxy, update } = useSettings();

  const { card, agentRpcUrl, apiKey, isConnecting, connect, disconnect } = useAgent({ onError: showError });
  const { messages, isBusy, sendParts, clearMessages } = useChat({
    agentRpcUrl,
    apiKey,
    proxyUrl,
    noProxy,
    streaming,
    onError: showError,
  });

  const handleConnect = (url: string, key: string) => connect(url, key, proxyUrl || undefined, noProxy || undefined);

  const handleSend = async (parts: Part[]) => {
    await sendParts(parts);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">
          <span className="app-logo-icon">✦</span>
          <span className="app-logo-text">Sofia Client</span>
          <span className="app-logo-sub">A2A Protocol</span>
        </div>
        <div className="app-header-actions">
          <button
            className={`btn btn--ghost btn--icon${showSettings ? ' btn--active' : ''}`}
            onClick={() => setShowSettings(s => !s)}
            title="Settings"
          >
            ⚙️{proxyUrl && <span className="proxy-dot" title={`Proxy: ${proxyUrl}`} />}
          </button>
          {messages.length > 0 && (
            <button className="btn btn--ghost btn--clear" onClick={clearMessages}>
              🗑 Clear
            </button>
          )}
        </div>
      </header>

      <div className="app-body">
        <ConnectBar
          isConnecting={isConnecting}
          isConnected={!!card}
          streaming={streaming}
          onConnect={handleConnect}
          onToggleStreaming={() => setStreaming((s: boolean) => !s)}
        />

        {showSettings && (
          <SettingsBar
            proxyUrl={proxyUrl}
            noProxy={noProxy}
            onSave={(p, n) => update({ proxyUrl: p, noProxy: n })}
          />
        )}

        {card && (
          <AgentCard card={card} onDisconnect={disconnect} />
        )}

        <MessageList messages={messages} />

        <InputArea
          onSend={handleSend}
          isBusy={isBusy}
          disabled={!agentRpcUrl}
        />
      </div>

      <ErrorToast
        message={toastError}
        onDismiss={() => setToastError(null)}
      />
    </div>
  );
}
