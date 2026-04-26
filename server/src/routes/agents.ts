import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/requireAuth';
import { config } from '../config';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/agents
// Returns the list of agents accessible to the current user.
// - AUTH_MODE=none : all agents in sf_agents_config
// - AUTH_MODE=app|user : only agents in sf_agents_access for this user
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    let rows: { agent_name: string; url: string }[];

    if (config.AUTH_MODE === 'none') {
      const result = await pool.query<{ agent_name: string; url: string }>(
        'SELECT agent_name, url FROM sf_agents_config ORDER BY agent_name'
      );
      rows = result.rows;
    } else {
      // Both app and user mode: session.userId is the identity for access checks.
      // app mode  → session.userId = caller_user_id
      // user mode → session.userId = login user_id
      const result = await pool.query<{ agent_name: string; url: string }>(
        `SELECT c.agent_name, c.url
         FROM sf_agents_config c
         JOIN sf_agents_access a ON a.agent_name = c.agent_name
         WHERE a.user_id = $1
         ORDER BY c.agent_name`,
        [req.session.userId]
      );
      rows = result.rows;
    }

    // Never expose api_key to the frontend
    res.json(rows);
  } catch (err) {
    console.error('[agents] list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
