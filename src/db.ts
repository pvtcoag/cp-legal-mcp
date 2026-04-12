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
    ALTER TABLE matter_queries ADD COLUMN IF NOT EXISTS is_error BOOLEAN DEFAULT FALSE;
    ALTER TABLE matter_queries ADD COLUMN IF NOT EXISTS error_message TEXT;
    ALTER TABLE matter_queries ADD COLUMN IF NOT EXISTS accuracy_score FLOAT4;
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
  is_error?: boolean;
  error_message?: string;
  accuracy_score?: number;
}

// Fire-and-forget safe: caller should .catch() this
export async function logMatterQuery(entry: QueryLogEntry): Promise<void> {
  if (!pool) return;

  await pool.query(
    `INSERT INTO matter_queries
       (matter_ref, user_id, tool_name, query_text, jurisdiction, result_count, top_results,
        api_tokens_used, is_error, error_message, accuracy_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.matter_ref,
      entry.user_id ?? null,
      entry.tool_name,
      entry.query_text,
      entry.jurisdiction ?? null,
      entry.result_count,
      JSON.stringify(entry.top_results),
      entry.api_tokens_used ?? 0,
      entry.is_error ?? false,
      entry.error_message ?? null,
      entry.accuracy_score ?? null,
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
  is_error: boolean;
  error_message: string | null;
  accuracy_score: number | null;
  created_at: string;
}

export async function getMatterHistory(
  matter_ref: string,
  limit: number = 50,
  toolFilter?: string,
): Promise<MatterHistoryRow[]> {
  if (!pool) return [];
  const params: unknown[] = [matter_ref, limit];
  const toolClause = toolFilter ? ` AND tool_name = $3` : '';
  if (toolFilter) params.push(toolFilter);
  const result = await pool.query<MatterHistoryRow>(
    `SELECT id, matter_ref, user_id, tool_name, query_text, jurisdiction,
            result_count, top_results, api_tokens_used,
            is_error, error_message, accuracy_score, created_at
     FROM matter_queries
     WHERE matter_ref = $1${toolClause}
     ORDER BY created_at DESC
     LIMIT $2`,
    params,
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

export async function listMattersForUser(userId: string, search?: string): Promise<MatterSummaryRow[]> {
  if (!pool) return [];
  const params: unknown[] = [userId];
  const searchClause = search ? ` AND matter_ref ILIKE $2` : '';
  if (search) params.push(`%${search}%`);
  const result = await pool.query<MatterSummaryRow>(`
    SELECT
      matter_ref,
      COUNT(*)::int                              AS query_count,
      ARRAY_AGG(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS users,
      ARRAY_AGG(DISTINCT tool_name)              AS tools_used,
      MIN(created_at)                            AS first_activity,
      MAX(created_at)                            AS last_activity
    FROM matter_queries
    WHERE (user_id = $1 OR user_id IS NULL)${searchClause}
    GROUP BY matter_ref
    ORDER BY last_activity DESC
  `, params);
  return result.rows;
}

export async function listMatters(search?: string): Promise<MatterSummaryRow[]> {
  if (!pool) return [];
  const params: unknown[] = [];
  const searchClause = search ? `WHERE matter_ref ILIKE $1` : '';
  if (search) params.push(`%${search}%`);
  const result = await pool.query<MatterSummaryRow>(`
    SELECT
      matter_ref,
      COUNT(*)::int                              AS query_count,
      ARRAY_AGG(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS users,
      ARRAY_AGG(DISTINCT tool_name)              AS tools_used,
      MIN(created_at)                            AS first_activity,
      MAX(created_at)                            AS last_activity
    FROM matter_queries
    ${searchClause}
    GROUP BY matter_ref
    ORDER BY last_activity DESC
  `, params);
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
           result_count, top_results, api_tokens_used,
           is_error, error_message, accuracy_score, created_at
    FROM matter_queries
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

// ── Dashboard analytics ───────────────────────────────────────────────────────

export interface DashboardStats {
  total_matters: number;
  total_queries: number;
  total_tokens: number;
  active_matters_30d: number;
}

export async function getDashboardStats(userId?: string): Promise<DashboardStats> {
  if (!pool) return { total_matters: 0, total_queries: 0, total_tokens: 0, active_matters_30d: 0 };
  const where = userId ? `WHERE user_id = $1 OR user_id IS NULL` : '';
  const params = userId ? [userId] : [];
  const result = await pool.query<DashboardStats>(`
    SELECT
      COUNT(DISTINCT matter_ref)::int AS total_matters,
      COUNT(*)::int AS total_queries,
      COALESCE(SUM(api_tokens_used), 0)::int AS total_tokens,
      COUNT(DISTINCT CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN matter_ref END)::int AS active_matters_30d
    FROM matter_queries ${where}
  `, params);
  return result.rows[0] ?? { total_matters: 0, total_queries: 0, total_tokens: 0, active_matters_30d: 0 };
}

export interface ToolUsageStat {
  tool_name: string;
  query_count: number;
  total_tokens: number;
}

export async function getToolUsageStats(userId?: string): Promise<ToolUsageStat[]> {
  if (!pool) return [];
  const where = userId ? `WHERE user_id = $1 OR user_id IS NULL` : '';
  const params = userId ? [userId] : [];
  const result = await pool.query<ToolUsageStat>(`
    SELECT
      tool_name,
      COUNT(*)::int AS query_count,
      COALESCE(SUM(api_tokens_used), 0)::int AS total_tokens
    FROM matter_queries ${where}
    GROUP BY tool_name
    ORDER BY query_count DESC
  `, params);
  return result.rows;
}

export interface UserStatRow {
  user_id: string | null;
  query_count: number;
  matter_count: number;
  total_tokens: number;
  last_activity: string;
}

export async function getUserStats(): Promise<UserStatRow[]> {
  if (!pool) return [];
  const result = await pool.query<UserStatRow>(`
    SELECT
      user_id,
      COUNT(*)::int AS query_count,
      COUNT(DISTINCT matter_ref)::int AS matter_count,
      COALESCE(SUM(api_tokens_used), 0)::int AS total_tokens,
      MAX(created_at) AS last_activity
    FROM matter_queries
    GROUP BY user_id
    ORDER BY query_count DESC
  `);
  return result.rows;
}

// ── Popular cases ─────────────────────────────────────────────────────────────

export interface PopularCaseRow {
  url: string;
  title: string | null;
  citation: string | null;
  mention_count: number;
}

export async function getPopularCases(limit: number = 10): Promise<PopularCaseRow[]> {
  if (!pool) return [];
  const result = await pool.query<PopularCaseRow>(`
    SELECT
      item->>'url'      AS url,
      item->>'title'    AS title,
      item->>'citation' AS citation,
      COUNT(*)::int     AS mention_count
    FROM matter_queries,
         LATERAL jsonb_array_elements(top_results) AS item
    WHERE jsonb_typeof(top_results) = 'array'
      AND jsonb_array_length(top_results) > 0
      AND item->>'url' IS NOT NULL
    GROUP BY item->>'url', item->>'title', item->>'citation'
    ORDER BY mention_count DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

// ── Error statistics ──────────────────────────────────────────────────────────

export interface ErrorStatRow {
  tool_name: string;
  total_queries: number;
  error_count: number;
  error_rate_pct: number;
}

export async function getErrorStats(): Promise<ErrorStatRow[]> {
  if (!pool) return [];
  const result = await pool.query<ErrorStatRow>(`
    SELECT
      tool_name,
      COUNT(*)::int                                        AS total_queries,
      COUNT(*) FILTER (WHERE is_error = TRUE)::int         AS error_count,
      ROUND(
        COUNT(*) FILTER (WHERE is_error = TRUE)::numeric
        / GREATEST(COUNT(*)::numeric, 1) * 100, 1
      )::float                                             AS error_rate_pct
    FROM matter_queries
    GROUP BY tool_name
    HAVING COUNT(*) FILTER (WHERE is_error = TRUE) > 0
    ORDER BY error_count DESC
  `);
  return result.rows;
}
