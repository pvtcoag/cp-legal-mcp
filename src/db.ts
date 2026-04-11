import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

// DB is optional — if DATABASE_URL is not set, matter tracking is silently disabled.
export function isDbEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}

export async function initDb(): Promise<void> {
  if (!isDbEnabled()) {
    logger.info('DATABASE_URL not set — matter tracking disabled');
    return;
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Required for Railway PostgreSQL
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'DB pool error');
  });

  // Create schema on first boot — idempotent
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matter_queries (
      id          SERIAL PRIMARY KEY,
      matter_ref  TEXT        NOT NULL,
      user_id     TEXT,
      tool_name   TEXT        NOT NULL,
      query_text  TEXT        NOT NULL,
      jurisdiction TEXT,
      result_count INTEGER    DEFAULT 0,
      top_results  JSONB      DEFAULT '[]',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mq_matter_ref  ON matter_queries(matter_ref);
    CREATE INDEX IF NOT EXISTS idx_mq_created_at  ON matter_queries(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mq_user_id     ON matter_queries(user_id);
  `);

  logger.info('DB initialised — matter tracking enabled');
}

export interface QueryLogEntry {
  matter_ref: string;
  user_id: string | undefined;
  tool_name: string;
  query_text: string;
  jurisdiction?: string;
  result_count: number;
  top_results: Array<{ title: string; citation?: string; url: string }>;
}

// Fire-and-forget safe: caller should .catch() this
export async function logMatterQuery(entry: QueryLogEntry): Promise<void> {
  if (!pool) return;

  await pool.query(
    `INSERT INTO matter_queries
       (matter_ref, user_id, tool_name, query_text, jurisdiction, result_count, top_results)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.matter_ref,
      entry.user_id ?? null,
      entry.tool_name,
      entry.query_text,
      entry.jurisdiction ?? null,
      entry.result_count,
      JSON.stringify(entry.top_results),
    ],
  );
}

export interface MatterHistoryRow {
  id: number;
  matter_ref: string;
  user_id: string | null;
  tool_name: string;
  query_text: string;
  jurisdiction: string | null;
  result_count: number;
  top_results: Array<{ title: string; citation?: string; url: string }>;
  created_at: string;
}

export async function getMatterHistory(
  matter_ref: string,
  limit: number = 50,
): Promise<MatterHistoryRow[]> {
  if (!pool) return [];

  const result = await pool.query<MatterHistoryRow>(
    `SELECT id, matter_ref, user_id, tool_name, query_text, jurisdiction,
            result_count, top_results, created_at
     FROM matter_queries
     WHERE matter_ref = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [matter_ref, limit],
  );

  return result.rows;
}
