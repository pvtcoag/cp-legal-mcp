import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { createMcpHandler } from './server.js';

const app = express();
app.use(express.json());

// Health check — used by Railway healthcheck and monitoring
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'cp-legal-mcp',
    timestamp: new Date().toISOString(),
  });
});

// MCP endpoint — all three HTTP methods required by the Streamable HTTP transport spec
const mcpHandler = createMcpHandler();
app.post('/mcp', mcpHandler);
app.get('/mcp', mcpHandler);
app.delete('/mcp', mcpHandler);

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, hfEnabled: config.HF_ENABLED },
    'cp-legal-mcp listening',
  );
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});
