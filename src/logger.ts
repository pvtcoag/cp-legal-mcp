import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'cp-legal-mcp' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    config.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
