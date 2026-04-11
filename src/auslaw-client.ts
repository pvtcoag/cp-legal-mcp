import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';
import { logger } from './logger.js';

// --- Response types (inferred from AusLaw MCP source) ---

export interface AuslawCase {
  title: string;
  citation: string;
  url: string;
  excerpt: string;
  court?: string;
  date?: string;
  jurisdiction?: string;
}

export interface AuslawLegislation {
  title: string;
  url: string;
  excerpt: string;
  jurisdiction?: string;
  date?: string;
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

async function callAuslawTool<T>(
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<T> {
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

    return JSON.parse(textItem.text) as T;
  } catch (err) {
    if (err instanceof AuslawError) throw err;
    // Wrap timeout / network errors
    const message = err instanceof Error ? err.message : String(err);
    throw new AuslawError(`AusLaw tool "${toolName}" failed: ${message}`, toolName);
  } finally {
    await client.close().catch(() => {
      /* ignore close errors */
    });
  }
}

// --- Public API ---

export async function searchCases(params: {
  query: string;
  jurisdiction?: string;
  limit?: number;
}): Promise<AuslawCase[]> {
  logger.debug({ params }, 'auslaw: search_cases');
  return callAuslawTool<AuslawCase[]>('search_cases', {
    query: params.query,
    ...(params.jurisdiction && { jurisdiction: params.jurisdiction }),
    ...(params.limit && { limit: params.limit }),
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
  logger.debug({ url }, 'auslaw: fetch_document_text');
  return callAuslawTool<AuslawDocumentText>('fetch_document_text', { url });
}

export async function validateCitation(
  citation: string,
): Promise<AuslawCitationValidation> {
  logger.debug({ citation }, 'auslaw: validate_citation');
  return callAuslawTool<AuslawCitationValidation>('validate_citation', { citation });
}
