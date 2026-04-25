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

// API routes
app.use('/api/auth', authRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/proxy', proxyRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true, mode: config.MODE }));

// Serve the built React SPA in production
// __dirname = server/dist/  →  ../../dist = <root>/dist
if (config.NODE_ENV !== 'development') {
  const distDir = path.resolve(__dirname, '../../dist');
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(config.PORT, () => {
  console.log(`[sofia-server] Running on port ${config.PORT} | mode=${config.MODE} | auth=${config.AUTH_MODE}`);
});
