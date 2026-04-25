import { useState, useCallback } from 'react';
import { MessageList } from './components/MessageList';
import { InputArea } from './components/InputArea';
import { AgentCard } from './components/AgentCard';
import { AgentSelector } from './components/AgentSelector';
import { LoginForm } from './components/LoginForm';
import { ErrorToast } from './components/ErrorToast';
import { SettingsBar } from './components/SettingsBar';
import { useAuth } from './hooks/useAuth';
import { useChatProd } from './hooks/useChatProd';
import { useSettings } from './hooks/useSettings';
import { fetchAgentCardProd } from './api/prodClient';
import type { AgentCard as AgentCardType } from './types/a2a';
import type { Part } from './types/a2a';

export function AppProd() {
  const auth = useAuth();
  const { proxyUrl, noProxy, update } = useSettings();

  const [streaming, setStreaming] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  // agentCard is optional extra info; the chip uses selectedAgent as primary key
  const [agentCard, setAgentCard] = useState<AgentCardType | null>(null);
  const [showAgentCard, setShowAgentCard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toastError, setToastError] = useState<string | null>(null);
  const [sessionExpiredMsg, setSessionExpiredMsg] = useState<string | null>(null);

  const showError = useCallback((msg: string) => setToastError(msg), []);

  const handleSessionExpired = useCallback((authMode: string) => {
    if (authMode === 'app') {
      setSessionExpiredMsg('Session expired');
    } else {
      auth.refresh();
    }
  }, [auth]);

  const { messages, isBusy, sendParts, clearMessages } = useChatProd({
    agentName: selectedAgent,
    streaming,
    onError: showError,
    onSessionExpired: handleSessionExpired,
  });

  const handleSelectAgent = useCallback(async (name: string) => {
    setSelectedAgent(name);
    setAgentCard(null);
    setShowAgentCard(false);
    // Agent card is fetched for extra info (version, skills…) but is optional.
    // The chip in the header appears as soon as selectedAgent is set.
    try {
      const card = await fetchAgentCardProd(name);
      setAgentCard(card);
    } catch {
      // Not all agents expose /.well-known/agent.json — proceed without it.
    }
  }, []);

  const handleDisconnectAgent = useCallback(() => {
    setSelectedAgent(null);
    setAgentCard(null);
    setShowAgentCard(false);
  }, []);

  const handleSend = async (parts: Part[]) => { await sendParts(parts); };

  // ── User auth mode: show login if not authenticated ──────────────────────
  if (auth.authMode === 'user' && !auth.loading && !auth.authenticated) {
    return <LoginForm onLogin={auth.login} />;
  }

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (auth.loading) {
    return (
      <div className="app" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="send-spinner" style={{ width: 24, height: 24 }} />
      </div>
    );
  }

  // ── Session expired overlay (app-to-app mode) ─────────────────────────────
  if (sessionExpiredMsg) {
    return (
      <div className="login-overlay">
        <div className="login-card" style={{ textAlign: 'center', gap: 16 }}>
          <span style={{ fontSize: 32 }}>⏱</span>
          <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>Session Expired</p>
          <p style={{ fontSize: 14, color: 'var(--muted)' }}>
            Your session has expired due to inactivity. Please reload the page.
          </p>
          <button className="btn btn--primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  // The chip label: prefer agentCard.name (pretty name from agent), fall back to selectedAgent key
  const chipLabel = agentCard?.name ?? selectedAgent;
  const chipVersion = agentCard?.version;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">
          <span className="app-logo-icon">✦</span>
          <span className="app-logo-text">Sofia Chat</span>
        </div>

        <div className="app-header-actions">
          {/* Chip appears as soon as an agent is selected, with or without card */}
          {selectedAgent && (
            <button
              className={`header-agent-chip${showAgentCard ? ' header-agent-chip--active' : ''}`}
              onClick={() => setShowAgentCard(v => !v)}
              title={agentCard ? 'Agent details' : selectedAgent}
            >
              <span className="header-agent-dot" />
              <span className="header-agent-name">{chipLabel}</span>
              {chipVersion && <span className="header-agent-version">v{chipVersion}</span>}
              {agentCard && <span className="header-agent-chevron">{showAgentCard ? '▲' : '▼'}</span>}
            </button>
          )}

          {selectedAgent && (
            <button className="btn--disconnect" onClick={handleDisconnectAgent} title="Disconnect agent">✕</button>
          )}

          {auth.authenticated && auth.userId && (
            <span className="header-user-badge" title={`Profile: ${JSON.stringify(auth.profile ?? {})}`}>
              {auth.appName
                ? <>{auth.appName}<span className="header-user-sep">/</span>{auth.userId}</>
                : auth.userId}
            </span>
          )}

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

          {auth.authenticated && auth.authMode === 'user' && (
            <button className="btn btn--ghost btn--clear" onClick={auth.logout} title="Sign out">
              Sign out
            </button>
          )}
        </div>
      </header>

      <div className="app-body">
        {/* Agent selector bar — shows when no agent is connected yet */}
        {!selectedAgent && (
          <div className="prod-agent-bar">
            <AgentSelector
              selectedAgent={selectedAgent}
              onSelect={handleSelectAgent}
              disabled={isBusy}
            />
            <button
              className={`btn btn--stream ${streaming ? 'btn--stream-on' : ''}`}
              onClick={() => setStreaming(s => !s)}
              title={streaming ? 'Streaming on' : 'Streaming off'}
            >
              ⚡ {streaming ? 'Stream ON' : 'Stream OFF'}
            </button>
          </div>
        )}

        {showSettings && (
          <SettingsBar
            proxyUrl={proxyUrl}
            noProxy={noProxy}
            onSave={(p, n) => update({ proxyUrl: p, noProxy: n })}
          />
        )}

        {/* Agent detail panel — only when card is available and expanded */}
        {agentCard && showAgentCard && (
          <AgentCard card={agentCard} onDisconnect={handleDisconnectAgent} headerless />
        )}

        <MessageList messages={messages} />

        <InputArea
          onSend={handleSend}
          isBusy={isBusy}
          disabled={!selectedAgent}
        />
      </div>

      <ErrorToast message={toastError} onDismiss={() => setToastError(null)} />
    </div>
  );
}
