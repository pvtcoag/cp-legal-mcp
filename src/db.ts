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

    CREATE TABLE IF NOT EXISTS judgment_cache (
      url           TEXT PRIMARY KEY,
      canonical_url TEXT,
      title         TEXT,
      citation      TEXT,
      body_text     TEXT        NOT NULL,
      char_count    INTEGER,
      fetched_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_jc_fetched_at ON judgment_cache(fetched_at DESC);

    CREATE TABLE IF NOT EXISTS judgment_embeddings (
      url         TEXT PRIMARY KEY,
      embedding   JSONB        NOT NULL,
      dimensions  INTEGER      NOT NULL DEFAULT 1792,
      model       TEXT         NOT NULL DEFAULT 'kanon-2-embedder',
      created_at  TIMESTAMPTZ  DEFAULT NOW()
    );

    ALTER TABLE matter_queries ADD COLUMN IF NOT EXISTS api_tokens_used INTEGER DEFAULT 0;
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
  api_tokens_used?: number;
}

// Fire-and-forget safe: caller should .catch() this
export async function logMatterQuery(entry: QueryLogEntry): Promise<void> {
  if (!pool) return;

  await pool.query(
    `INSERT INTO matter_queries
       (matter_ref, user_id, tool_name, query_text, jurisdiction, result_count, top_results, api_tokens_used)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.matter_ref,
      entry.user_id ?? null,
      entry.tool_name,
      entry.query_text,
      entry.jurisdiction ?? null,
      entry.result_count,
      JSON.stringify(entry.top_results),
      entry.api_tokens_used ?? 0,
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
  api_tokens_used: number;
  created_at: string;
}

export async function getMatterHistory(
  matter_ref: string,
  limit: number = 50,
): Promise<MatterHistoryRow[]> {
  if (!pool) return [];

  const result = await pool.query<MatterHistoryRow>(
    `SELECT id, matter_ref, user_id, tool_name, query_text, jurisdiction,
            result_count, top_results, api_tokens_used, created_at
     FROM matter_queries
     WHERE matter_ref = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [matter_ref, limit],
  );

  return result.rows;
}

// ── Admin queries (admin-only) ─────────────────────────────────────────────

export interface MatterSummaryRow {
  matter_ref: string;
  query_count: number;
  users: string[];
  tools_used: string[];
  first_activity: string;
  last_activity: string;
}

export async function listMattersForUser(userId: string): Promise<MatterSummaryRow[]> {
  if (!pool) return [];
  const result = await pool.query<MatterSummaryRow>(`
    SELECT
      matter_ref,
      COUNT(*)::int                              AS query_count,
      ARRAY_AGG(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS users,
      ARRAY_AGG(DISTINCT tool_name)              AS tools_used,
      MIN(created_at)                            AS first_activity,
      MAX(created_at)                            AS last_activity
    FROM matter_queries
    WHERE user_id = $1 OR user_id IS NULL
    GROUP BY matter_ref
    ORDER BY last_activity DESC
  `, [userId]);
  return result.rows;
}

export async function listMatters(): Promise<MatterSummaryRow[]> {
  if (!pool) return [];
  const result = await pool.query<MatterSummaryRow>(`
    SELECT
      matter_ref,
      COUNT(*)::int                              AS query_count,
      ARRAY_AGG(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS users,
      ARRAY_AGG(DISTINCT tool_name)              AS tools_used,
      MIN(created_at)                            AS first_activity,
      MAX(created_at)                            AS last_activity
    FROM matter_queries
    GROUP BY matter_ref
    ORDER BY last_activity DESC
  `);
  return result.rows;
}

// ── Judgment cache ────────────────────────────────────────────────────────────

export interface CachedJudgment {
  url: string;
  canonical_url: string | null;
  title: string | null;
  citation: string | null;
  body_text: string;
  char_count: number;
  fetched_at: string;
}

/** Returns a cached judgment if it exists and is younger than 30 days. */
export async function getCachedJudgment(url: string): Promise<CachedJudgment | null> {
  if (!pool) return null;
  const result = await pool.query<CachedJudgment>(
    `SELECT url, canonical_url, title, citation, body_text, char_count, fetched_at
     FROM judgment_cache
     WHERE url = $1 AND fetched_at > NOW() - INTERVAL '30 days'`,
    [url],
  );
  return result.rows[0] ?? null;
}

/** Upsert a judgment into the cache. Silently no-ops when DB is unavailable. */
export async function upsertJudgmentCache(
  entry: Omit<CachedJudgment, 'fetched_at'>,
): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO judgment_cache (url, canonical_url, title, citation, body_text, char_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (url) DO UPDATE SET
       canonical_url = EXCLUDED.canonical_url,
       title         = EXCLUDED.title,
       citation      = EXCLUDED.citation,
       body_text     = EXCLUDED.body_text,
       char_count    = EXCLUDED.char_count,
       fetched_at    = NOW()`,
    [
      entry.url,
      entry.canonical_url,
      entry.title,
      entry.citation,
      entry.body_text,
      entry.char_count,
    ],
  );
}

// ── Judgment embeddings ───────────────────────────────────────────────────────

export interface EmbeddingEntry {
  url: string;
  title: string | null;
  citation: string | null;
  embedding: number[];
}

export async function getJudgmentEmbedding(url: string): Promise<number[] | null> {
  if (!pool) return null;
  const result = await pool.query<{ embedding: number[] }>(
    'SELECT embedding FROM judgment_embeddings WHERE url = $1',
    [url],
  );
  return result.rows[0]?.embedding ?? null;
}

export async function upsertJudgmentEmbedding(url: string, embedding: number[]): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO judgment_embeddings (url, embedding, dimensions)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (url) DO UPDATE SET
       embedding  = EXCLUDED.embedding,
       dimensions = EXCLUDED.dimensions,
       created_at = NOW()`,
    [url, JSON.stringify(embedding), embedding.length],
  );
}

/** Returns all embedded judgments joined with cache metadata for similarity search. */
export async function getAllJudgmentEmbeddings(): Promise<EmbeddingEntry[]> {
  if (!pool) return [];
  const result = await pool.query<EmbeddingEntry>(`
    SELECT je.url, jc.title, jc.citation, je.embedding
    FROM judgment_embeddings je
    LEFT JOIN judgment_cache jc ON je.url = jc.url
    ORDER BY je.created_at DESC
  `);
  return result.rows;
}

export interface UserActivityRow {
  user_id: string | null;
  query_date: string;
  query_count: number;
  matters: string[];
}

export async function getUserActivity(params: {
  date_from?: string;
  date_to?: string;
}): Promise<UserActivityRow[]> {
  if (!pool) return [];
  const result = await pool.query<UserActivityRow>(`
    SELECT
      user_id,
      DATE(created_at)::text                         AS query_date,
      COUNT(*)::int                                  AS query_count,
      ARRAY_AGG(DISTINCT matter_ref)                 AS matters
    FROM matter_queries
    WHERE ($1::date IS NULL OR created_at >= $1::date)
      AND ($2::date IS NULL OR created_at <  $2::date + INTERVAL '1 day')
    GROUP BY user_id, DATE(created_at)
    ORDER BY query_date DESC, user_id
  `, [params.date_from ?? null, params.date_to ?? null]);
  return result.rows;
}

export interface RecentActivityRow extends MatterHistoryRow {
  // same shape, no additional fields
}

export async function getRecentActivity(limit: number = 50): Promise<RecentActivityRow[]> {
  if (!pool) return [];
  const result = await pool.query<RecentActivityRow>(`
    SELECT id, matter_ref, user_id, tool_name, query_text, jurisdiction,
           result_count, top_results, api_tokens_used, created_at
    FROM matter_queries
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}
