import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.string().default('8080').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // AusLaw upstream
  AUSLAW_BASE_URL: z.string().url('AUSLAW_BASE_URL must be a valid URL'),
  AUSLAW_TIMEOUT_MS: z.string().default('30000').transform(Number),

  // Admin — comma-separated user identities permitted to use admin tools
  ADMIN_USERS: z.string().default('admin'),

  // OAuth — public base URL of this service (no trailing slash)
  OAUTH_ISSUER: z.string().url().default('https://api.example.com'),

  // Static OAuth client ID for Claude Web (enter this same value in claude.ai settings).
  // Leave unset if only using mcp-remote (which does dynamic registration automatically).
  OAUTH_CLIENT_ID: z.string().optional(),

  // Client secret for the static OAuth client. Claude Web sends this in POST /oauth/token.
  // Must match the value entered in claude.ai remote MCP settings.
  OAUTH_CLIENT_SECRET: z.string().optional(),

  // Isaacus — legal AI reranking
  ISAACUS_API_KEY: z.string().min(1, 'ISAACUS_API_KEY is required'),

  // Matter tracking — optional default applied when no matter_ref is passed in a tool call.
  // Useful for firms that want all queries automatically tagged (e.g. set to "general-research").
  DEFAULT_MATTER_REF: z.string().max(100).optional(),

  // Optional 32+ character key for future encrypted config storage.
  ENCRYPTION_KEY: z.string().min(32).optional(),

  // Session secret for HMAC-signed cookies (falls back to MCP_AUTH_TOKENS if not set).
  // Explicit SESSION_SECRET is recommended for production.
  SESSION_SECRET: z.string().optional(),

  // Recovery token — allows admin access via login page when other credentials are unavailable.
  // Remove this env var after recovering access.
  RECOVERY_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration error:\n${issues}`);
  }
  return result.data;
}

export const config = loadConfig();
