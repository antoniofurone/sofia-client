import { useState, useCallback } from 'react';

const STORAGE_KEY = 'sofia_settings_v1';

interface Settings {
  proxyUrl: string;
  noProxy: string;
}

const DEFAULTS: Settings = { proxyUrl: '', noProxy: '' };

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return DEFAULTS;
}

interface UseSettingsReturn {
  proxyUrl: string;
  noProxy: string;
  update: (patch: Partial<Settings>) => void;
}

export function useSettings(): UseSettingsReturn {
  const [settings, setSettings] = useState<Settings>(load);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { proxyUrl: settings.proxyUrl, noProxy: settings.noProxy, update };
}
