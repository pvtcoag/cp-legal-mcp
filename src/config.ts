import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.string().default('8080').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // AusLaw upstream
  AUSLAW_BASE_URL: z.string().url('AUSLAW_BASE_URL must be a valid URL'),
  AUSLAW_TIMEOUT_MS: z.string().default('30000').transform(Number),

  // HuggingFace
  HF_API_TOKEN: z.string().min(1, 'HF_API_TOKEN is required'),
  HF_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  HF_RERANK_MODEL: z.string().default('isaacus/emubert'),
  HF_RERANK_TOP_K: z.string().default('10').transform(Number),
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
