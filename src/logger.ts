import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'cp-legal-mcp' },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact fields that could accidentally carry sensitive data into logs.
  // Applies to any depth in the logged object.
  redact: {
    paths: [
      'password', 'token', 'access_token', 'refresh_token', 'client_secret',
      'authorization', 'cookie', 'set-cookie', 'x-api-key', 'apiKey', 'api_key',
      'code_verifier', 'code_challenge', 'encryption_key', 'session_secret',
      'recovery_token', 'MCP_AUTH_TOKENS', 'DATABASE_URL',
    ],
    censor: '[REDACTED]',
  },
  transport:
    config.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
