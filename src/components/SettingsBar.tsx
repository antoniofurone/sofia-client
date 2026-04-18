import { useState, useEffect } from 'react';

interface Props {
  proxyUrl: string;
  noProxy: string;
  onSave: (proxyUrl: string, noProxy: string) => void;
}

const IS_DEV = import.meta.env.DEV;

export function SettingsBar({ proxyUrl, noProxy, onSave }: Props) {
  const [draftProxy, setDraftProxy] = useState(proxyUrl);
  const [draftNoProxy, setDraftNoProxy] = useState(noProxy);

  // Sync from external (e.g. first load from localStorage)
  useEffect(() => setDraftProxy(proxyUrl), [proxyUrl]);
  useEffect(() => setDraftNoProxy(noProxy), [noProxy]);

  const isDirty = draftProxy.trim() !== proxyUrl || draftNoProxy.trim() !== noProxy;
  const isActive = !!proxyUrl;

  const save = () => onSave(draftProxy.trim(), draftNoProxy.trim());
  const clear = () => { setDraftProxy(''); setDraftNoProxy(''); onSave('', ''); };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
  };

  return (
    <div className="settings-bar">

      {/* Proxy URL */}
      <div className="settings-row">
        <label className="settings-label">🌐 HTTP Proxy</label>
        <div className="settings-input-wrap">
          <input
            className="settings-proxy-input"
            type="url"
            placeholder="http://proxy.example.com:8080"
            value={draftProxy}
            onChange={e => setDraftProxy(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        {isActive && !isDirty && (
          <span className="settings-active-badge">active</span>
        )}
      </div>

      {/* No Proxy */}
      <div className="settings-row">
        <label className="settings-label">🚫 No Proxy</label>
        <div className="settings-input-wrap">
          <input
            className="settings-proxy-input"
            type="text"
            placeholder="localhost, 127.0.0.1, .internal"
            value={draftNoProxy}
            onChange={e => setDraftNoProxy(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoComplete="off"
            disabled={!draftProxy}
          />
        </div>
      </div>

      {/* Actions + hint */}
      <div className="settings-footer">
        <p className="settings-hint">
          {IS_DEV
            ? 'Applied server-side via Vite proxy. No proxy: comma-separated hostnames, supports .suffix wildcards.'
            : '⚠ No effect in production builds — configure your system or agent-side proxy.'}
        </p>
        <div className="settings-actions">
          {isActive && !isDirty && (
            <button className="btn btn--ghost btn--sm" onClick={clear}>
              Clear all
            </button>
          )}
          {isDirty && (
            <button className="btn btn--primary btn--sm" onClick={save}>
              Save
            </button>
          )}
        </div>
      </div>

    </div>
  );
}
