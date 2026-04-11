import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { logger } from './logger.js';
import { createMcpHandler } from './server.js';
import { warmup } from './hf-client.js';

const app = express();
app.use(express.json());

// Rate limiting — 60 requests per minute per IP
app.use(
  '/mcp',
  rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
  }),
);

// Health check — used by Railway healthcheck and monitoring
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'cp-legal-mcp',
    timestamp: new Date().toISOString(),
  });
});

// Bearer token auth middleware — only active when MCP_AUTH_TOKEN is set
function authGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!config.MCP_AUTH_TOKEN) {
    next();
    return;
  }
  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== config.MCP_AUTH_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// MCP endpoint — all three HTTP methods required by the Streamable HTTP transport spec
const mcpHandler = createMcpHandler();
app.post('/mcp', authGuard, mcpHandler);
app.get('/mcp', authGuard, mcpHandler);
app.delete('/mcp', authGuard, mcpHandler);

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, hfEnabled: config.HF_ENABLED },
    'cp-legal-mcp listening',
  );
  // Warm up HF model in background — reduces first-request latency
  warmup();
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});
