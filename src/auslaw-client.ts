import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { getCachedJudgment, upsertJudgmentCache } from './db.js';

// --- Response types (inferred from AusLaw MCP source) ---

export interface AuslawCase {
  title: string;
  citation: string;
  url: string;
  excerpt: string;
  court?: string;
  date?: string;
  jurisdiction?: string;
  [key: string]: unknown;
}

export interface AuslawLegislation {
  title: string;
  url: string;
  excerpt: string;
  jurisdiction?: string;
  date?: string;
  [key: string]: unknown;
}

export interface AuslawDocumentText {
  url: string;
  text: string;
  citation?: string;
  title?: string;
}

export interface AuslawCitationValidation {
  valid: boolean;
  url?: string;
  canonical?: string;
}

// --- Error type ---

export class AuslawError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
  ) {
    super(message);
    this.name = 'AuslawError';
  }
}

// --- Internal: call one AusLaw tool via MCP-over-HTTP ---

async function callAuslawToolRaw(
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<string> {
  const url = new URL('/mcp', config.AUSLAW_BASE_URL);

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      signal: AbortSignal.timeout(config.AUSLAW_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
    },
  });

  const client = new Client(
    { name: 'cp-legal-mcp', version: '0.1.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);

    const result = await client.callTool({ name: toolName, arguments: toolArgs });

    if (result.isError) {
      const errorText = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n');
      throw new AuslawError(
        `AusLaw tool "${toolName}" returned error: ${errorText}`,
        toolName,
      );
    }

    const textItem = (result.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === 'text' && c.text,
    );
    if (!textItem?.text) {
      throw new AuslawError(`AusLaw tool "${toolName}" returned no text content`, toolName);
    }

    return textItem.text;
  } catch (err) {
    if (err instanceof AuslawError) throw err;
    let message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error ? (err as NodeJS.ErrnoException).cause : undefined;
    if (cause instanceof Error && cause.message) message += ` (cause: ${cause.message})`;
    else if (cause) message += ` (cause: ${String(cause)})`;
    throw new AuslawError(`AusLaw tool "${toolName}" failed: ${message}`, toolName);
  } finally {
    await client.close().catch(() => { /* ignore close errors */ });
  }
}

async function callAuslawTool<T>(
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<T> {
  return JSON.parse(await callAuslawToolRaw(toolName, toolArgs)) as T;
}

// --- Public API ---

export async function searchCases(params: {
  query: string;
  jurisdiction?: string;
  limit?: number;
  fromYear?: number;
  toYear?: number;
}): Promise<AuslawCase[]> {
  logger.debug({ params }, 'auslaw: search_cases');
  return callAuslawTool<AuslawCase[]>('search_cases', {
    query: params.query,
    ...(params.jurisdiction && { jurisdiction: params.jurisdiction }),
    ...(params.limit && { limit: params.limit }),
    ...(params.fromYear !== undefined && { fromYear: params.fromYear }),
    ...(params.toYear !== undefined && { toYear: params.toYear }),
  });
}

export async function searchLegislation(params: {
  query: string;
  jurisdiction?: string;
  limit?: number;
}): Promise<AuslawLegislation[]> {
  logger.debug({ params }, 'auslaw: search_legislation');
  return callAuslawTool<AuslawLegislation[]>('search_legislation', {
    query: params.query,
    ...(params.jurisdiction && { jurisdiction: params.jurisdiction }),
    ...(params.limit && { limit: params.limit }),
  });
}

export async function fetchDocumentText(url: string): Promise<AuslawDocumentText> {
  // Check judgment cache first — 30-day TTL (judgments are permanent documents)
  const cached = await getCachedJudgment(url).catch(() => null);
  if (cached) {
    logger.debug({ url }, 'judgment cache hit');
    return {
      url,
      text: cached.body_text,
      citation: cached.citation ?? undefined,
      title: cached.title ?? undefined,
    };
  }

  logger.debug({ url }, 'auslaw: fetch_document_text (cache miss)');
  const doc = await callAuslawTool<AuslawDocumentText>('fetch_document_text', { url });

  // Cache for future calls — fire-and-forget, never blocks the response
  upsertJudgmentCache({
    url: doc.url ?? url,
    canonical_url: null,
    title: doc.title ?? null,
    citation: doc.citation ?? null,
    body_text: doc.text,
    char_count: doc.text.length,
  }).catch((err) => logger.warn({ err }, 'judgment cache write failed'));

  return doc;
}

export async function validateCitation(
  citation: string,
): Promise<AuslawCitationValidation> {
  logger.debug({ citation }, 'auslaw: validate_citation');
  return callAuslawTool<AuslawCitationValidation>('validate_citation', { citation });
}

export interface AuslawCitingCase {
  title: string;
  citation: string;
  url: string;
  excerpt?: string;
  court?: string;
  date?: string;
  [key: string]: unknown;
}

export interface AuslawFormattedCitation {
  formatted: string;
  style?: string;
}

export interface AuslawPinpoint {
  /** The pinpoint reference, e.g. "[20]" or "p 42". */
  pinpointString: string;
  /** Full AGLC4 citation with pinpoint appended, e.g. "[2024] HCA 12, [20]". */
  fullCitation: string;
  paragraphNumber?: number;
  paragraphText?: string;
}

export async function searchCitingCases(params: {
  citation: string;
  limit?: number;
}): Promise<AuslawCitingCase[]> {
  logger.debug({ params }, 'auslaw: search_citing_cases');
  return callAuslawTool<AuslawCitingCase[]>('search_citing_cases', {
    citation: params.citation,
    ...(params.limit && { limit: params.limit }),
  });
}

export async function searchByCitation(params: {
  citation_or_name: string;
  limit?: number;
}): Promise<AuslawCase[]> {
  logger.debug({ params }, 'auslaw: search_by_citation');
  return callAuslawTool<AuslawCase[]>('search_by_citation', {
    citation: params.citation_or_name,
    ...(params.limit && { limit: params.limit }),
  });
}

export async function formatCitation(params: {
  title: string;
  neutralCitation?: string;
  reportedCitation?: string;
  pinpoint?: string;
  style?: 'neutral' | 'reported' | 'combined';
}): Promise<AuslawFormattedCitation> {
  logger.debug({ params }, 'auslaw: format_citation');
  // auslaw-mcp format_citation returns plain text, not JSON
  const text = await callAuslawToolRaw('format_citation', {
    title: params.title,
    ...(params.neutralCitation && { neutralCitation: params.neutralCitation }),
    ...(params.reportedCitation && { reportedCitation: params.reportedCitation }),
    ...(params.pinpoint && { pinpoint: params.pinpoint }),
    ...(params.style && { style: params.style }),
  });
  return { formatted: text, style: params.style };
}

// ── Judgment URL resolution ───────────────────────────────────────────────────
// Shared by get_judgment, ask_judgment, enrich_judgment and any other tool that
// needs to resolve a citation-or-URL input into a fetchable AustLII URL.

const NEUTRAL_CITATION_RE = /^\[\d{4}\]\s+[A-Z]+\s+\d+$/i;
const URL_RE = /^https?:\/\//;

export interface ResolvedJudgment {
  url: string;
  canonicalUrl?: string;
  /** The original citation string, if the input was a citation rather than a URL. */
  citation?: string;
}

/**
 * Resolves a neutral citation or AustLII URL into a concrete fetch URL.
 * Throws AuslawError with a descriptive message on invalid input or missing citation.
 */
export async function resolveJudgmentUrl(input: string): Promise<ResolvedJudgment> {
  const value = input.trim();
  if (URL_RE.test(value)) {
    return { url: value };
  }
  if (NEUTRAL_CITATION_RE.test(value)) {
    let validation: AuslawCitationValidation;
    try {
      validation = await validateCitation(value);
    } catch (err) {
      // Upstream failure (network error etc.) — distinguish from genuine not-found
      const detail = err instanceof AuslawError ? err.message : String(err);
      throw new AuslawError(
        `Could not validate citation "${value}" — the legal database may be temporarily unavailable. Detail: ${detail}`,
        'validate_citation',
      );
    }
    if (!validation.valid || !validation.url) {
      throw new AuslawError(`Citation "${value}" could not be found on AustLII.`, 'validate_citation');
    }
    return { url: validation.url, canonicalUrl: validation.canonical ?? undefined, citation: value };
  }
  throw new AuslawError(
    'Invalid input: provide a neutral citation like "[2024] HCA 12" or a full AustLII URL.',
    'resolve_judgment_url',
  );
}

export async function generatePinpoint(params: {
  url: string;
  paragraphNumber?: number;
  phrase?: string;
  caseCitation?: string;
}): Promise<AuslawPinpoint> {
  logger.debug({ params }, 'auslaw: generate_pinpoint');
  return callAuslawTool<AuslawPinpoint>('generate_pinpoint', {
    url: params.url,
    ...(params.paragraphNumber !== undefined && { paragraphNumber: params.paragraphNumber }),
    ...(params.phrase && { phrase: params.phrase }),
    ...(params.caseCitation && { caseCitation: params.caseCitation }),
  });
}
