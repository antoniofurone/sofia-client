import express from 'express';
import path from 'path';
import cors from 'cors';
import { config } from './config';
import { sessionMiddleware } from './middleware/session';
import authRouter from './routes/auth';
import agentsRouter from './routes/agents';
import proxyRouter from './routes/proxy';

const app = express();

// Trust proxy (needed for secure cookies behind nginx/reverse proxy)
app.set('trust proxy', 1);

app.use(cors({
  origin: config.NODE_ENV === 'development' ? 'http://localhost:5173' : false,
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(sessionMiddleware);

// Base path support: when deployed behind a path-based load balancer (e.g. /a),
// set BASE_PATH=/a at runtime. Leave empty when served at the domain root.
const bp = config.BASE_PATH; // e.g. '/a' or ''

// API routes
app.use(`${bp}/api/auth`, authRouter);
app.use(`${bp}/api/agents`, agentsRouter);
app.use(`${bp}/api/proxy`, proxyRouter);

// Health check
app.get(`${bp}/api/health`, (_req, res) => res.json({ ok: true, mode: config.MODE }));

// Serve the built React SPA in production
// __dirname = server/dist/  →  ../../dist = <root>/dist
if (config.NODE_ENV !== 'development') {
  const distDir = path.resolve(__dirname, '../../dist');
  app.use(bp || '/', express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(config.PORT, () => {
  console.log(`[sofia-server] Running on port ${config.PORT} | mode=${config.MODE} | auth=${config.AUTH_MODE}`);
});
