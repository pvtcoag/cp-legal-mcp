import pg from 'pg';
import { logger } from './logger.js';
import { encryptToken, hashToken } from './token-utils.js';

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
    ssl: { rejectUnauthorized: false }, // Railway uses self-signed certs on internal networking
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

    CREATE TABLE IF NOT EXISTS users (
      id               SERIAL PRIMARY KEY,
      username         TEXT UNIQUE NOT NULL,
      token_salt       TEXT NOT NULL,
      token_hash       TEXT NOT NULL,
      token_encrypted  TEXT,
      is_admin         BOOLEAN DEFAULT FALSE,
      is_active        BOOLEAN DEFAULT TRUE,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      created_by       TEXT,
      last_active      TIMESTAMPTZ
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token_encrypted TEXT;

    CREATE TABLE IF NOT EXISTS login_events (
      id          SERIAL PRIMARY KEY,
      username    TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      ip          TEXT,
      user_agent  TEXT,
      client_name TEXT,
      meta        JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_le_username   ON login_events(username);
    CREATE INDEX IF NOT EXISTS idx_le_created_at ON login_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS oauth_authorizations (
      id           SERIAL PRIMARY KEY,
      username     TEXT NOT NULL,
      client_id    TEXT NOT NULL,
      client_name  TEXT,
      redirect_uri TEXT,
      first_auth   TIMESTAMPTZ DEFAULT NOW(),
      last_auth    TIMESTAMPTZ DEFAULT NOW(),
      auth_count   INT DEFAULT 1,
      UNIQUE(username, client_id)
    );
    CREATE INDEX IF NOT EXISTS idx_oa_username ON oauth_authorizations(username);

    CREATE TABLE IF NOT EXISTS app_config (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      description TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_by  TEXT
    );

    CREATE TABLE IF NOT EXISTS matters (
      matter_ref   TEXT PRIMARY KEY,
      display_name TEXT,
      status       TEXT NOT NULL DEFAULT 'open',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE matters ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
  `);

  // Activate installed extensions — idempotent, safe to run on every boot.
  // pg_trgm:          trigram similarity operators for future fuzzy text search.
  // pgcrypto:         cryptographic functions available to SQL if ever needed.
  // pg_stat_statements: query-level performance stats (Railway loads it server-side;
  //                   CREATE EXTENSION just makes it queryable in this database).
  try {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    `);
  } catch (err) {
    // pg_stat_statements requires shared_preload_libraries — log but don't crash
    // if the Railway instance hasn't loaded it at the server level.
    logger.warn({ err }, 'DB: one or more extensions could not be activated (non-fatal)');
  }

  logger.info('DB initialised — matter tracking enabled');
}

/** Quick connectivity probe used by the /health endpoint. */
export async function pingDb(): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
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

  // If the matter is closed, redirect to a new suffixed ref automatically
  const effectiveRef = await resolveOpenMatterRef(entry.matter_ref);

  await pool.query(
    `INSERT INTO matter_queries
       (matter_ref, user_id, tool_name, query_text, jurisdiction, result_count, top_results,
        api_tokens_used, is_error, error_message, accuracy_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      effectiveRef,
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
  offset: number = 0,
): Promise<MatterHistoryRow[]> {
  if (!pool) return [];
  const params: unknown[] = [matter_ref, limit];
  const toolClause = toolFilter ? ` AND tool_name = $3` : '';
  if (toolFilter) params.push(toolFilter);
  const offsetIdx = toolFilter ? 4 : 3;
  params.push(offset);
  const result = await pool.query<MatterHistoryRow>(
    `SELECT id, matter_ref, user_id, tool_name, query_text, jurisdiction,
            result_count, top_results, api_tokens_used,
            is_error, error_message, accuracy_score, created_at
     FROM matter_queries
     WHERE matter_ref = $1${toolClause}
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $${offsetIdx}`,
    params,
  );
  return result.rows;
}

export async function getMatterHistoryCount(matter_ref: string, toolFilter?: string): Promise<number> {
  if (!pool) return 0;
  const params: unknown[] = [matter_ref];
  const toolClause = toolFilter ? ` AND tool_name = $2` : '';
  if (toolFilter) params.push(toolFilter);
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM matter_queries WHERE matter_ref = $1${toolClause}`,
    params,
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

// ── Admin queries (admin-only) ─────────────────────────────────────────────

export interface MatterSummaryRow {
  matter_ref: string;
  display_name: string | null;
  status: string;
  query_count: number;
  users: string[];
  tools_used: string[];
  first_activity: string;
  last_activity: string;
}

/** Map a UI sort key to SQL ORDER BY clause. */
function matterSortClause(orderBy?: string): string {
  switch (orderBy) {
    case 'first_activity': return 'ORDER BY first_activity ASC';
    case 'queries':        return 'ORDER BY query_count DESC';
    case 'matter_ref':     return 'ORDER BY mq.matter_ref ASC';
    default:               return 'ORDER BY last_activity DESC';
  }
}

export async function listMattersForUser(userId: string, search?: string, status?: string, orderBy?: string, from?: string, to?: string): Promise<MatterSummaryRow[]> {
  if (!pool) return [];
  const params: unknown[] = [userId];
  const conditions: string[] = ['(mq.user_id = $1 OR mq.user_id IS NULL)'];
  if (search) { params.push(`%${search}%`); conditions.push(`mq.matter_ref ILIKE $${params.length}`); }
  if (from)   { params.push(from);           conditions.push(`mq.created_at >= $${params.length}::date`); }
  if (to)     { params.push(to);             conditions.push(`mq.created_at < ($${params.length}::date + interval '1 day')`); }
  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const statusClause = status && status !== 'all' ? ` HAVING COALESCE(MAX(m.status), 'open') = '${status === 'closed' ? 'closed' : 'open'}'` : '';
  const result = await pool.query<MatterSummaryRow>(`
    SELECT
      mq.matter_ref,
      MAX(m.display_name)                        AS display_name,
      COALESCE(MAX(m.status), 'open')            AS status,
      COUNT(*)::int                              AS query_count,
      ARRAY_AGG(DISTINCT mq.user_id) FILTER (WHERE mq.user_id IS NOT NULL) AS users,
      ARRAY_AGG(DISTINCT mq.tool_name)           AS tools_used,
      MIN(mq.created_at)                         AS first_activity,
      MAX(mq.created_at)                         AS last_activity
    FROM matter_queries mq
    LEFT JOIN matters m ON m.matter_ref = mq.matter_ref
    ${whereClause}
    GROUP BY mq.matter_ref${statusClause}
    ${matterSortClause(orderBy)}
  `, params);
  return result.rows;
}

export async function listMatters(search?: string, status?: string, orderBy?: string, from?: string, to?: string): Promise<MatterSummaryRow[]> {
  if (!pool) return [];
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (search) { params.push(`%${search}%`); conditions.push(`mq.matter_ref ILIKE $${params.length}`); }
  if (from)   { params.push(from);           conditions.push(`mq.created_at >= $${params.length}::date`); }
  if (to)     { params.push(to);             conditions.push(`mq.created_at < ($${params.length}::date + interval '1 day')`); }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const statusClause = status && status !== 'all' ? ` HAVING COALESCE(MAX(m.status), 'open') = '${status === 'closed' ? 'closed' : 'open'}'` : '';
  const result = await pool.query<MatterSummaryRow>(`
    SELECT
      mq.matter_ref,
      MAX(m.display_name)                        AS display_name,
      COALESCE(MAX(m.status), 'open')            AS status,
      COUNT(*)::int                              AS query_count,
      ARRAY_AGG(DISTINCT mq.user_id) FILTER (WHERE mq.user_id IS NOT NULL) AS users,
      ARRAY_AGG(DISTINCT mq.tool_name)           AS tools_used,
      MIN(mq.created_at)                         AS first_activity,
      MAX(mq.created_at)                         AS last_activity
    FROM matter_queries mq
    LEFT JOIN matters m ON m.matter_ref = mq.matter_ref
    ${whereClause}
    GROUP BY mq.matter_ref${statusClause}
    ${matterSortClause(orderBy)}
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

export async function getRecentActivity(limit: number = 50, userId?: string): Promise<RecentActivityRow[]> {
  if (!pool) return [];
  const where = userId ? 'WHERE user_id = $2 OR user_id IS NULL' : '';
  const params: (number | string)[] = userId ? [limit, userId] : [limit];
  const result = await pool.query<RecentActivityRow>(`
    SELECT id, matter_ref, user_id, tool_name, query_text, jurisdiction,
           result_count, top_results, api_tokens_used,
           is_error, error_message, accuracy_score, created_at
    FROM matter_queries ${where}
    ORDER BY created_at DESC
    LIMIT $1
  `, params);
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

export async function getErrorStats(userId?: string): Promise<ErrorStatRow[]> {
  if (!pool) return [];
  const where = userId ? 'WHERE user_id = $1 OR user_id IS NULL' : '';
  const params = userId ? [userId] : [];
  const result = await pool.query<ErrorStatRow>(`
    SELECT
      tool_name,
      COUNT(*)::int                                        AS total_queries,
      COUNT(*) FILTER (WHERE is_error = TRUE)::int         AS error_count,
      ROUND(
        COUNT(*) FILTER (WHERE is_error = TRUE)::numeric
        / GREATEST(COUNT(*)::numeric, 1) * 100, 1
      )::float                                             AS error_rate_pct
    FROM matter_queries ${where}
    GROUP BY tool_name
    HAVING COUNT(*) FILTER (WHERE is_error = TRUE) > 0
    ORDER BY error_count DESC
  `, params);
  return result.rows;
}

// ── Aggregate accuracy ────────────────────────────────────────────────────────

/** Average extractive QA confidence across all logged queries with a score. */
export async function getAggregateAccuracy(userId?: string): Promise<number | null> {
  if (!pool) return null;
  const where = userId
    ? 'WHERE (user_id = $1 OR user_id IS NULL) AND accuracy_score IS NOT NULL'
    : 'WHERE accuracy_score IS NOT NULL';
  const params = userId ? [userId] : [];
  const result = await pool.query<{ avg_accuracy: number | null }>(`
    SELECT ROUND(AVG(accuracy_score)::numeric, 3)::float AS avg_accuracy
    FROM matter_queries ${where}
  `, params);
  return result.rows[0]?.avg_accuracy ?? null;
}

// ── Per-tool token totals (for accurate cost calculation) ─────────────────────

export interface ToolTokenStat {
  tool_name: string;
  total_tokens: number;
}

/** Returns total tokens grouped by tool — used to compute accurate per-tool cost in the UI. */
export async function getDashboardCostByTool(userId?: string): Promise<ToolTokenStat[]> {
  if (!pool) return [];
  const where = userId ? 'WHERE user_id = $1 OR user_id IS NULL' : '';
  const params = userId ? [userId] : [];
  const result = await pool.query<ToolTokenStat>(`
    SELECT tool_name, COALESCE(SUM(api_tokens_used), 0)::int AS total_tokens
    FROM matter_queries ${where}
    GROUP BY tool_name
  `, params);
  return result.rows;
}

// ── User management ───────────────────────────────────────────────────────────

export interface UserRow {
  id: number;
  username: string;
  token_salt: string;
  token_hash: string;
  token_encrypted: string | null;
  is_admin: boolean;
  is_active: boolean;
  created_at: string;
  created_by: string | null;
  last_active: string | null;
  session_version: number;
}

export async function createUser(params: {
  username: string;
  tokenSalt: string;
  tokenHash: string;
  tokenEncrypted?: string;
  isAdmin: boolean;
  createdBy: string;
}): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO users (username, token_salt, token_hash, token_encrypted, is_admin, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [params.username, params.tokenSalt, params.tokenHash, params.tokenEncrypted ?? null, params.isAdmin, params.createdBy],
  );
}

export async function getUserByUsername(username: string): Promise<UserRow | null> {
  if (!pool) return null;
  const result = await pool.query<UserRow>(
    'SELECT * FROM users WHERE username = $1',
    [username],
  );
  return result.rows[0] ?? null;
}

export async function listUsers(): Promise<UserRow[]> {
  if (!pool) return [];
  const result = await pool.query<UserRow>(
    'SELECT * FROM users ORDER BY created_at ASC',
  );
  return result.rows;
}

export async function updateUserAdmin(username: string, isAdmin: boolean): Promise<void> {
  if (!pool) return;
  await pool.query('UPDATE users SET is_admin = $2 WHERE username = $1', [username, isAdmin]);
}

export async function updateUserActive(username: string, isActive: boolean): Promise<void> {
  if (!pool) return;
  await pool.query('UPDATE users SET is_active = $2 WHERE username = $1', [username, isActive]);
}

export async function rotateUserToken(username: string, tokenSalt: string, tokenHash: string, tokenEncrypted?: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    'UPDATE users SET token_salt = $2, token_hash = $3, token_encrypted = $4 WHERE username = $1',
    [username, tokenSalt, tokenHash, tokenEncrypted ?? null],
  );
}

export async function deleteUser(username: string): Promise<void> {
  if (!pool) return;
  await pool.query('DELETE FROM users WHERE username = $1', [username]);
}

export async function updateUserLastActive(username: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    'UPDATE users SET last_active = NOW() WHERE username = $1',
    [username],
  );
}

// ── Matter status management ──────────────────────────────────────────────────

export interface MatterRow {
  matter_ref: string;
  display_name: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export async function getMatter(ref: string): Promise<MatterRow | null> {
  if (!pool) return null;
  const r = await pool.query<MatterRow>('SELECT * FROM matters WHERE matter_ref = $1', [ref]);
  return r.rows[0] ?? null;
}

export async function upsertMatter(ref: string, updates: { displayName?: string; status?: string; notes?: string }): Promise<void> {
  if (!pool) return;
  await pool.query(`
    INSERT INTO matters (matter_ref, display_name, status, notes)
    VALUES ($1, $2, COALESCE($3, 'open'), $4)
    ON CONFLICT (matter_ref) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, matters.display_name),
      status       = COALESCE(EXCLUDED.status, matters.status),
      notes        = CASE WHEN $4 IS NOT NULL THEN $4 ELSE matters.notes END,
      updated_at   = NOW()
  `, [ref, updates.displayName ?? null, updates.status ?? null, updates.notes !== undefined ? (updates.notes || null) : null]);
}

export async function isMatterClosed(ref: string): Promise<boolean> {
  if (!pool) return false;
  const r = await pool.query<{ status: string }>('SELECT status FROM matters WHERE matter_ref = $1', [ref]);
  return r.rows[0]?.status === 'closed';
}

async function resolveOpenMatterRef(ref: string): Promise<string> {
  const closed = await isMatterClosed(ref);
  if (!closed) return ref;
  // Find next available suffix
  const base = ref.replace(/-\d+$/, ''); // strip existing numeric suffix
  const r = await pool!.query<{ matter_ref: string }>(
    `SELECT DISTINCT matter_ref FROM matter_queries WHERE matter_ref LIKE $1`,
    [base + '%'],
  );
  const existing = new Set(r.rows.map((row) => row.matter_ref));
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

/** Seeds users table from MCP_AUTH_TOKENS env var if the table is empty. */
export async function migrateUsersFromEnv(envTokens: string, adminUsers: string[]): Promise<void> {
  if (!pool) return;
  if (!envTokens.trim()) return;

  const existing = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
  const count = parseInt(existing.rows[0]?.count ?? '0', 10);
  if (count > 0) return; // already migrated

  const encKey = process.env.ENCRYPTION_KEY?.trim() ?? null;
  const pairs = envTokens.split(',');
  for (const pair of pairs) {
    const colon = pair.indexOf(':');
    if (colon < 1) continue;
    const username = pair.slice(0, colon).trim().toLowerCase();
    const token = pair.slice(colon + 1).trim();
    if (!username || !token) continue;
    const { salt, hash } = hashToken(token);
    const tokenEncrypted = encKey ? encryptToken(token, encKey) : null;
    const isAdmin = adminUsers.includes(username);
    try {
      await pool.query(
        `INSERT INTO users (username, token_salt, token_hash, token_encrypted, is_admin, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (username) DO NOTHING`,
        [username, salt, hash, tokenEncrypted, isAdmin, 'migration'],
      );
    } catch (err) {
      logger.error({ err, username }, 'migrateUsersFromEnv: failed to insert user');
    }
  }
  logger.info({ users: pairs.length }, 'migrateUsersFromEnv: migrated users from MCP_AUTH_TOKENS');
}

// ── Login events ──────────────────────────────────────────────────────────────

export interface LoginEventRow {
  id: number;
  username: string;
  event_type: string;
  ip: string | null;
  user_agent: string | null;
  client_name: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

export async function logLoginEvent(params: {
  username: string;
  eventType: string;
  ip?: string;
  userAgent?: string;
  clientName?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO login_events (username, event_type, ip, user_agent, client_name, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.username,
        params.eventType,
        params.ip ?? null,
        params.userAgent ?? null,
        params.clientName ?? null,
        params.meta ? JSON.stringify(params.meta) : null,
      ],
    );
  } catch (err) {
    logger.error({ err }, 'logLoginEvent: failed');
  }
}

export async function getLoginEvents(username: string, limit: number = 20): Promise<LoginEventRow[]> {
  if (!pool) return [];
  const result = await pool.query<LoginEventRow>(
    `SELECT * FROM login_events WHERE username = $1 ORDER BY created_at DESC LIMIT $2`,
    [username, limit],
  );
  return result.rows;
}

export async function getRecentLoginEvents(limit: number = 10): Promise<LoginEventRow[]> {
  if (!pool) return [];
  const result = await pool.query<LoginEventRow>(
    'SELECT * FROM login_events ORDER BY created_at DESC LIMIT $1',
    [limit],
  );
  return result.rows;
}

// ── OAuth authorizations ──────────────────────────────────────────────────────

export interface OAuthAuthRow {
  id: number;
  username: string;
  client_id: string;
  client_name: string | null;
  redirect_uri: string | null;
  first_auth: string;
  last_auth: string;
  auth_count: number;
}

export async function upsertOAuthAuthorization(params: {
  username: string;
  clientId: string;
  clientName?: string;
  redirectUri?: string;
}): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO oauth_authorizations (username, client_id, client_name, redirect_uri)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username, client_id) DO UPDATE SET
         client_name  = COALESCE(EXCLUDED.client_name, oauth_authorizations.client_name),
         redirect_uri = COALESCE(EXCLUDED.redirect_uri, oauth_authorizations.redirect_uri),
         last_auth    = NOW(),
         auth_count   = oauth_authorizations.auth_count + 1`,
      [params.username, params.clientId, params.clientName ?? null, params.redirectUri ?? null],
    );
  } catch (err) {
    logger.error({ err }, 'upsertOAuthAuthorization: failed');
  }
}

export async function getOAuthAuthorizations(username: string): Promise<OAuthAuthRow[]> {
  if (!pool) return [];
  const result = await pool.query<OAuthAuthRow>(
    'SELECT * FROM oauth_authorizations WHERE username = $1 ORDER BY last_auth DESC',
    [username],
  );
  return result.rows;
}

// ── App config ────────────────────────────────────────────────────────────────

export interface AppConfigRow {
  key: string;
  value: string;
  description: string | null;
  updated_at: string;
  updated_by: string | null;
}

export async function getAppConfig(key: string): Promise<string | null> {
  if (!pool) return null;
  const result = await pool.query<{ value: string }>(
    'SELECT value FROM app_config WHERE key = $1',
    [key],
  );
  return result.rows[0]?.value ?? null;
}

export async function setAppConfig(
  key: string,
  value: string,
  updatedBy: string,
  description?: string,
): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO app_config (key, value, description, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET
       value      = EXCLUDED.value,
       description = COALESCE(EXCLUDED.description, app_config.description),
       updated_at  = NOW(),
       updated_by  = EXCLUDED.updated_by`,
    [key, value, description ?? null, updatedBy],
  );
}

export async function listAppConfig(): Promise<AppConfigRow[]> {
  if (!pool) return [];
  const result = await pool.query<AppConfigRow>(
    'SELECT * FROM app_config ORDER BY key',
  );
  return result.rows;
}

// ── Admin stats ───────────────────────────────────────────────────────────────

export interface AdminDashboardStats {
  total_users: number;
  active_users_7d: number;
  total_queries_today: number;
  total_queries_7d: number;
  error_count_24h: number;
  judgment_cache_count: number;
  judgment_cache_mb: number;
  matter_queries_count: number;
  embeddings_count: number;
}

export async function getAdminDashboardStats(): Promise<AdminDashboardStats> {
  if (!pool) {
    return {
      total_users: 0, active_users_7d: 0, total_queries_today: 0, total_queries_7d: 0,
      error_count_24h: 0, judgment_cache_count: 0, judgment_cache_mb: 0,
      matter_queries_count: 0, embeddings_count: 0,
    };
  }
  const result = await pool.query<AdminDashboardStats>(`
    SELECT
      (SELECT COUNT(*)::int FROM users)                                                             AS total_users,
      (SELECT COUNT(*)::int FROM users WHERE last_active > NOW() - INTERVAL '7 days')              AS active_users_7d,
      (SELECT COUNT(*)::int FROM matter_queries WHERE created_at > NOW() - INTERVAL '1 day')       AS total_queries_today,
      (SELECT COUNT(*)::int FROM matter_queries WHERE created_at > NOW() - INTERVAL '7 days')      AS total_queries_7d,
      (SELECT COUNT(*)::int FROM matter_queries WHERE is_error = TRUE AND created_at > NOW() - INTERVAL '24 hours') AS error_count_24h,
      (SELECT COUNT(*)::int FROM judgment_cache)                                                    AS judgment_cache_count,
      (SELECT COALESCE(ROUND(SUM(char_count)::numeric / 1048576.0, 1), 0)::float FROM judgment_cache) AS judgment_cache_mb,
      (SELECT COUNT(*)::int FROM matter_queries)                                                    AS matter_queries_count,
      (SELECT COUNT(*)::int FROM judgment_embeddings)                                               AS embeddings_count
  `);
  return result.rows[0] ?? {
    total_users: 0, active_users_7d: 0, total_queries_today: 0, total_queries_7d: 0,
    error_count_24h: 0, judgment_cache_count: 0, judgment_cache_mb: 0,
    matter_queries_count: 0, embeddings_count: 0,
  };
}

export interface UserDetailStats {
  query_count: number;
  matter_count: number;
  total_tokens: number;
  first_query: string | null;
  last_query: string | null;
}

export async function getUserDetailStats(username: string): Promise<UserDetailStats> {
  if (!pool) return { query_count: 0, matter_count: 0, total_tokens: 0, first_query: null, last_query: null };
  const result = await pool.query<UserDetailStats>(`
    SELECT
      COUNT(*)::int                               AS query_count,
      COUNT(DISTINCT matter_ref)::int             AS matter_count,
      COALESCE(SUM(api_tokens_used), 0)::int      AS total_tokens,
      MIN(created_at)                             AS first_query,
      MAX(created_at)                             AS last_query
    FROM matter_queries
    WHERE user_id = $1
  `, [username]);
  return result.rows[0] ?? { query_count: 0, matter_count: 0, total_tokens: 0, first_query: null, last_query: null };
}

// ── Data management ───────────────────────────────────────────────────────────

export async function purgeOldMatterQueries(olderThanDays: number): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM matter_queries WHERE created_at < NOW() - ($1 || ' days')::INTERVAL RETURNING id
     ) SELECT COUNT(*)::text AS count FROM deleted`,
    [olderThanDays],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

export async function purgeOldJudgmentCache(olderThanDays: number): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM judgment_cache WHERE fetched_at < NOW() - ($1 || ' days')::INTERVAL RETURNING url
     ) SELECT COUNT(*)::text AS count FROM deleted`,
    [olderThanDays],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

export async function purgeAllJudgmentCache(): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query<{ count: string }>(
    `WITH deleted AS (DELETE FROM judgment_cache RETURNING url) SELECT COUNT(*)::text AS count FROM deleted`,
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

export async function getRecentErrors(limit: number = 10): Promise<MatterHistoryRow[]> {
  if (!pool) return [];
  const result = await pool.query<MatterHistoryRow>(`
    SELECT id, matter_ref, user_id, tool_name, query_text, jurisdiction,
           result_count, top_results, api_tokens_used,
           is_error, error_message, accuracy_score, created_at
    FROM matter_queries
    WHERE is_error = TRUE
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

// ── Admin matters list ─────────────────────────────────────────────────────────

export interface AdminMatterRow {
  matter_ref: string;
  display_name: string | null;
  status: string;
  first_seen: string;
  last_seen: string;
  query_count: number;
  total_tokens: number;
  creator: string | null;
  active_users: string[];
}

export async function listAdminMatters(period?: 'lifetime' | 'month' | 'week'): Promise<AdminMatterRow[]> {
  if (!pool) return [];
  const dateClause = period === 'week'
    ? `AND mq.created_at >= NOW() - INTERVAL '7 days'`
    : period === 'month'
    ? `AND mq.created_at >= NOW() - INTERVAL '30 days'`
    : '';
  const r = await pool.query<AdminMatterRow>(`
    SELECT mq.matter_ref,
           m.display_name,
           COALESCE(m.status, 'open') AS status,
           MIN(mq.created_at) AS first_seen,
           MAX(mq.created_at) AS last_seen,
           COUNT(*)::int AS query_count,
           COALESCE(SUM(mq.api_tokens_used), 0)::int AS total_tokens,
           (SELECT mq2.user_id FROM matter_queries mq2
            WHERE mq2.matter_ref = mq.matter_ref AND mq2.user_id IS NOT NULL
            ORDER BY mq2.created_at ASC LIMIT 1) AS creator,
           ARRAY_AGG(DISTINCT mq.user_id) FILTER (WHERE mq.user_id IS NOT NULL) AS active_users
    FROM matter_queries mq
    LEFT JOIN matters m ON m.matter_ref = mq.matter_ref
    WHERE mq.matter_ref IS NOT NULL ${dateClause}
    GROUP BY mq.matter_ref, m.display_name, m.status
    ORDER BY last_seen DESC
  `);
  return r.rows;
}

// ── User cost by period ────────────────────────────────────────────────────────

export interface UserCostStats {
  query_count: number;
  matter_count: number;
  total_tokens: number;
  first_query: string | null;
  last_query: string | null;
}

export async function getUserCostByPeriod(username: string, period: 'lifetime' | 'month' | 'week'): Promise<UserCostStats> {
  if (!pool) return { query_count: 0, matter_count: 0, total_tokens: 0, first_query: null, last_query: null };
  const dateClause = period === 'week'
    ? `AND created_at >= NOW() - INTERVAL '7 days'`
    : period === 'month'
    ? `AND created_at >= NOW() - INTERVAL '30 days'`
    : '';
  const result = await pool.query<UserCostStats>(`
    SELECT
      COUNT(*)::int                               AS query_count,
      COUNT(DISTINCT matter_ref)::int             AS matter_count,
      COALESCE(SUM(api_tokens_used), 0)::int      AS total_tokens,
      MIN(created_at)                             AS first_query,
      MAX(created_at)                             AS last_query
    FROM matter_queries
    WHERE user_id = $1 ${dateClause}
  `, [username]);
  return result.rows[0] ?? { query_count: 0, matter_count: 0, total_tokens: 0, first_query: null, last_query: null };
}

// ── Admin dashboard unique matters count ──────────────────────────────────────

export interface AdminDashboardStatsV2 extends AdminDashboardStats {
  unique_matters_count: number;
}

export async function getAdminDashboardStatsV2(): Promise<AdminDashboardStatsV2> {
  const base = await getAdminDashboardStats();
  if (!pool) return { ...base, unique_matters_count: 0 };
  const r = await pool.query<{ unique_matters_count: number }>(
    `SELECT COUNT(DISTINCT matter_ref)::int AS unique_matters_count FROM matter_queries WHERE matter_ref IS NOT NULL`,
  );
  return { ...base, unique_matters_count: r.rows[0]?.unique_matters_count ?? 0 };
}

// ── Daily query volume chart ──────────────────────────────────────────────────

export interface DailyQueryCount {
  day: string; // ISO date string
  count: number;
}

export async function getDailyQueryVolume(userId?: string, days = 14): Promise<DailyQueryCount[]> {
  if (!pool) return [];
  const userClause = userId ? 'AND user_id = $2' : '';
  const params: unknown[] = [days];
  if (userId) params.push(userId);
  const r = await pool.query<DailyQueryCount>(`
    SELECT DATE_TRUNC('day', created_at)::date::text AS day,
           COUNT(*)::int AS count
    FROM matter_queries
    WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL ${userClause}
    GROUP BY DATE_TRUNC('day', created_at)
    ORDER BY day ASC
  `, params);
  return r.rows;
}

// ── Global search ─────────────────────────────────────────────────────────────

export interface SearchResult {
  matter_ref: string;
  display_name: string | null;
  tool_name: string;
  query_text: string;
  created_at: string;
  user_id: string | null;
}

export async function searchQueries(query: string, userId?: string, limit = 50): Promise<SearchResult[]> {
  if (!pool) return [];
  const userClause = userId ? 'AND user_id = $3' : '';
  const params: unknown[] = [`%${query}%`, limit];
  if (userId) params.push(userId);
  const r = await pool.query<SearchResult>(`
    SELECT mq.matter_ref, m.display_name, mq.tool_name, mq.query_text, mq.created_at, mq.user_id
    FROM matter_queries mq
    LEFT JOIN matters m ON m.matter_ref = mq.matter_ref
    WHERE (mq.query_text ILIKE $1 OR mq.matter_ref ILIKE $1) ${userClause}
    ORDER BY mq.created_at DESC
    LIMIT $2
  `, params);
  return r.rows;
}

// ── Query volume by user today ────────────────────────────────────────────────

export interface UserQueryToday {
  user_id: string;
  count: number;
}

export async function getQueryVolumeByUserToday(): Promise<UserQueryToday[]> {
  if (!pool) return [];
  const r = await pool.query<UserQueryToday>(`
    SELECT COALESCE(user_id, 'unattributed') AS user_id, COUNT(*)::int AS count
    FROM matter_queries
    WHERE created_at >= CURRENT_DATE
    GROUP BY user_id
    ORDER BY count DESC
  `);
  return r.rows;
}

// ── Session versioning ────────────────────────────────────────────────────────

export async function incrementSessionVersion(username: string): Promise<void> {
  if (!pool) return;
  await pool.query('UPDATE users SET session_version = session_version + 1 WHERE username = $1', [username]);
}
