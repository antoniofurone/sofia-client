import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/requireAuth';
import { config } from '../config';
import type { SfAgentConfig, SfAgentAccess } from '../types';

const router = Router();

// ---------------------------------------------------------------------------
// RPC URL cache
// sf_agents_config stores the agent BASE URL (e.g. http://localhost:8013).
// The actual JSON-RPC endpoint is card.url from /.well-known/agent.json.
// We resolve it once and cache for 5 minutes to avoid a round-trip on every message.
// ---------------------------------------------------------------------------
interface RpcCacheEntry { rpcUrl: string; cachedAt: number }
const rpcUrlCache = new Map<string, RpcCacheEntry>();
const RPC_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveRpcUrl(baseUrl: string, apiKey: string | null): Promise<string> {
  const cached = rpcUrlCache.get(baseUrl);
  if (cached && Date.now() - cached.cachedAt < RPC_CACHE_TTL_MS) {
    return cached.rpcUrl;
  }

  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (apiKey) headers['X-API-Key'] = apiKey;

  for (const path of ['/.well-known/agent.json', '/.well-known/agent-card.json']) {
    try {
      const r = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const card = await r.json() as Record<string, unknown>;
        const rpcUrl = (card['url'] as string | undefined) ?? baseUrl;
        rpcUrlCache.set(baseUrl, { rpcUrl, cachedAt: Date.now() });
        return rpcUrl;
      }
    } catch {
      // agent card not available — fall through to next path or fallback
    }
  }

  // Agent card not found: use the base URL as-is and cache the fallback
  rpcUrlCache.set(baseUrl, { rpcUrl: baseUrl, cachedAt: Date.now() });
  return baseUrl;
}

// ---------------------------------------------------------------------------
// Inject user/caller metadata into the A2A JSON-RPC payload.
//
// App mode   → user_id = caller_user_id, app_name, profile = caller_profile
// User mode  → user_id = login user_id, profile from sf_agents_access
// None mode  → nothing injected (userId will be undefined)
// ---------------------------------------------------------------------------
function injectMetadata(
  payload: Record<string, unknown>,
  userId: string | undefined,
  profile: Record<string, unknown> | null | undefined,
  appName: string | null | undefined,
): Record<string, unknown> {
  if (!userId) return payload;

  const params = (payload.params ?? {}) as Record<string, unknown>;
  const message = (params.message ?? {}) as Record<string, unknown>;
  const existing = (message.metadata ?? {}) as Record<string, unknown>;

  return {
    ...payload,
    params: {
      ...params,
      message: {
        ...message,
        metadata: {
          ...existing,
          user_id: userId,
          ...(appName  ? { app_name: appName }  : {}),
          ...(profile  ? { profile }             : {}),
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Resolve agent config + access for the requesting session.
//
// App mode:
//   - access check uses appAuthUserId (the sf_user credential)
//   - profile comes from the session (caller_profile supplied by the app)
//
// User mode:
//   - access check uses userId (login user_id)
//   - profile comes from sf_agents_access row for that user + agent
//
// None mode:
//   - no access check, no profile
// ---------------------------------------------------------------------------
async function resolveAgent(agentName: string, req: Request): Promise<{
  url: string;
  apiKey: string | null;
  profile: Record<string, unknown> | null;
  appName: string | null;
} | null> {
  const configRow = await pool.query<SfAgentConfig>(
    'SELECT url, api_key FROM sf_agents_config WHERE agent_name = $1',
    [agentName]
  );
  if (!configRow.rows.length) return null;

  const { url, api_key } = configRow.rows[0];
  let profile: Record<string, unknown> | null = null;
  const appName: string | null = req.session.appName ?? null;

  if (config.AUTH_MODE === 'app') {
    // Access check uses caller_user_id (session.userId).
    // Profile comes from the session (caller_profile supplied by the calling app).
    const userId = req.session.userId;
    if (userId) {
      const accessRow = await pool.query(
        'SELECT 1 FROM sf_agents_access WHERE agent_name = $1 AND user_id = $2',
        [agentName, userId]
      );
      if (!accessRow.rows.length) return null;
    }
    profile = req.session.profile ?? null;

  } else if (config.AUTH_MODE === 'user') {
    // Access check uses login user_id (session.userId).
    // Profile comes from sf_agents_access for that user + agent.
    const userId = req.session.userId;
    if (!userId) return null;
    const accessRow = await pool.query<SfAgentAccess>(
      'SELECT profile FROM sf_agents_access WHERE agent_name = $1 AND user_id = $2',
      [agentName, userId]
    );
    if (!accessRow.rows.length) return null;
    profile = accessRow.rows[0].profile;
  }
  // AUTH_MODE === 'none': skip all checks

  return { url, apiKey: api_key, profile, appName };
}

// ---------------------------------------------------------------------------
// POST /api/proxy/send  — non-streaming
// Body: { agentName: string; payload: Record<string, unknown> }
// ---------------------------------------------------------------------------
router.post('/send', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { agentName, payload } = req.body as {
    agentName?: string;
    payload?: Record<string, unknown>;
  };

  if (!agentName || !payload) {
    res.status(400).json({ error: 'agentName and payload are required' });
    return;
  }

  try {
    const agent = await resolveAgent(agentName, req);
    if (!agent) {
      res.status(config.AUTH_MODE !== 'none' ? 403 : 404).json({ error: 'Agent not found or access denied' });
      return;
    }

    const rpcUrl = await resolveRpcUrl(agent.url, agent.apiKey);
    const enriched = injectMetadata(payload, req.session.userId, agent.profile, agent.appName);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (agent.apiKey) headers['X-API-Key'] = agent.apiKey;

    const upstream = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(enriched),
    });

    const body = await upstream.json();
    res.status(upstream.status).json(body);
  } catch (err) {
    console.error('[proxy] send error:', err);
    res.status(502).json({ error: err instanceof Error ? err.message : 'Upstream error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/proxy/stream  — SSE streaming relay
// Body: { agentName: string; payload: Record<string, unknown> }
// ---------------------------------------------------------------------------
router.post('/stream', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { agentName, payload } = req.body as {
    agentName?: string;
    payload?: Record<string, unknown>;
  };

  if (!agentName || !payload) {
    res.status(400).json({ error: 'agentName and payload are required' });
    return;
  }

  try {
    const agent = await resolveAgent(agentName, req);
    if (!agent) {
      res.status(config.AUTH_MODE !== 'none' ? 403 : 404).json({ error: 'Agent not found or access denied' });
      return;
    }

    const rpcUrl = await resolveRpcUrl(agent.url, agent.apiKey);
    const enriched = injectMetadata(payload, req.session.userId, agent.profile, agent.appName);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (agent.apiKey) headers['X-API-Key'] = agent.apiKey;

    const upstream = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(enriched),
    });

    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstream.body.getReader();
    req.on('close', () => reader.cancel());

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.error('[proxy] stream error:', err);
    if (!res.headersSent) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Upstream error' });
    } else {
      res.end();
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/proxy/card?agentName=<name>
// Fetches the agent card (/.well-known/agent.json) via the backend
// so the frontend doesn't need to know the agent URL.
// ---------------------------------------------------------------------------
router.get('/card', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { agentName } = req.query as { agentName?: string };
  if (!agentName) {
    res.status(400).json({ error: 'agentName required' });
    return;
  }

  try {
    const agent = await resolveAgent(agentName, req);
    if (!agent) {
      res.status(403).json({ error: 'Agent not found or access denied' });
      return;
    }

    const base = agent.url.replace(/\/+$/, '');
    const headers: Record<string, string> = {};
    if (agent.apiKey) headers['X-API-Key'] = agent.apiKey;

    for (const path of ['/.well-known/agent.json', '/.well-known/agent-card.json']) {
      const r = await fetch(`${base}${path}`, { headers });
      if (r.ok) {
        const card = await r.json();
        res.json(card);
        return;
      }
    }
    res.status(404).json({ error: 'Agent card not found' });
  } catch (err) {
    console.error('[proxy] card error:', err);
    res.status(502).json({ error: err instanceof Error ? err.message : 'Upstream error' });
  }
});

export default router;
