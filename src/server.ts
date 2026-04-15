import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from './logger.js';

// ── Stateful session store ────────────────────────────────────────────────────
//
// Each MCP conversation gets a persistent transport+server pair keyed by the
// Mcp-Session-Id the client sends on every subsequent request. This allows:
//  - Server-sent events (SSE) to stream back to the same client connection
//  - Session-scoped matter inference in matter-log.ts to group untagged tool
//    calls from the same conversation under a single inferred matter ref
//
// Sessions expire after IDLE_TTL_MS of inactivity. Explicit matter_ref values
// (weeks-long matters) are unaffected — those bypass session inference entirely.

const SESSION_IDLE_TTL_MS = 8 * 60 * 60 * 1000; // 8 h — full work day
const SESSION_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // scan every 15 min

interface ManagedSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

const sessionStore = new Map<string, ManagedSession>();

// Background cleanup — purge sessions idle past TTL.
// .unref() lets Node exit cleanly without waiting for the interval.
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessionStore) {
    if (now - session.lastActivity > SESSION_IDLE_TTL_MS) {
      session.transport.close();
      session.server.close();
      sessionStore.delete(id);
      logger.info({ sessionId: id }, 'MCP session expired (idle TTL)');
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();
import { registerResearchCases } from './tools/research-cases.js';
import { registerResearchLegislation } from './tools/research-legislation.js';
import { registerGetJudgment } from './tools/get-judgment.js';
import { registerFindCitingCases } from './tools/find-citing-cases.js';
import { registerSearchByCitation } from './tools/search-by-citation.js';
import { registerFormatCitation } from './tools/format-citation.js';
import { registerAskJudgment } from './tools/ask-judgment.js';
import { registerEnrichJudgment } from './tools/enrich-judgment.js';
import { registerSummariseJudgment } from './tools/summarise-judgment.js';
import { registerClassifyLegalIssue } from './tools/classify-legal-issue.js';
import { registerFindRelatedCases } from './tools/find-related-cases.js';
import { registerCompareCases } from './tools/compare-cases.js';
import { registerGetLegislation } from './tools/get-legislation.js';
import { registerGetMatterHistory } from './tools/get-matter-history.js';
import { registerInspectDatabase } from './tools/inspect-database.js';
import { registerLookupEntity } from './tools/lookup-entity.js';
import { registerSearchRegulatoryDecisions } from './tools/search-regulatory-decisions.js';
import { registerSearchAsxAnnouncements } from './tools/search-asx-announcements.js';
import { registerBuildChronology } from './tools/build-chronology.js';
import { registerCheckDeadlines } from './tools/check-deadlines.js';
import { registerDraftResearchMemo } from './tools/draft-research-memo.js';
import { registerMonitorPrecedents } from './tools/monitor-precedents.js';

const ADMIN_ERROR_NOTE = '\n\nIf this error persists, contact your administrator.';

/**
 * Monkey-patches server.tool() so every registered handler's error responses
 * automatically include an admin contact note — without touching each tool file.
 */
function instrumentServerErrors(server: McpServer): void {
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      args[args.length - 1] = async (input: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (last as (i: unknown) => Promise<any>)(input);
        if (!result?.isError) return result;
        return {
          ...result,
          content: (result.content ?? []).map((c: { type: string; text?: string }) => {
            if (c.type !== 'text' || !c.text) return c;
            try {
              const parsed = JSON.parse(c.text) as Record<string, unknown>;
              if (typeof parsed['message'] === 'string') {
                return { ...c, text: JSON.stringify({ ...parsed, message: parsed['message'] + ADMIN_ERROR_NOTE }) };
              }
            } catch { /* not JSON — fall through */ }
            return { ...c, text: c.text + ADMIN_ERROR_NOTE };
          }),
        };
      };
    }
    return original(...args);
  };
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: 'cp-legal-mcp',
    version: '0.1.0',
  });
  instrumentServerErrors(server);

  // Discovery & retrieval — cases
  registerResearchCases(server);
  registerSearchByCitation(server);
  registerFindCitingCases(server);
  registerFindRelatedCases(server);

  // Discovery & retrieval — legislation
  registerResearchLegislation(server);

  // Judgment analysis
  registerGetJudgment(server);
  registerAskJudgment(server);
  registerEnrichJudgment(server);
  registerSummariseJudgment(server);
  registerCompareCases(server);

  // Legislation retrieval & QA
  registerGetLegislation(server);

  // Issue classification
  registerClassifyLegalIssue(server);

  // Citation utilities
  registerFormatCitation(server);

  // Matter tracking
  registerGetMatterHistory(server);

  // Entity intelligence
  registerLookupEntity(server);

  // Regulatory decisions (ASIC + ACCC)
  registerSearchRegulatoryDecisions(server);

  // Market data
  registerSearchAsxAnnouncements(server);

  // Matter intelligence
  registerBuildChronology(server);
  registerDraftResearchMemo(server);
  registerMonitorPrecedents(server);

  // Time-critical utilities
  registerCheckDeadlines(server);

  // Admin (restricted to ADMIN_USERS)
  registerInspectDatabase(server);

  return server;
}

export function createMcpHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const requestId = crypto.randomUUID();
    const log = logger.child({ requestId, method: req.method });
    log.debug({ path: req.path }, 'MCP request received');

    const incomingSessionId = req.headers['mcp-session-id'] as string | undefined;

    // ── Route to existing session ──────────────────────────────────────────
    // If the session ID is known, reuse the existing transport.
    // If it is unknown (server restart / TTL expiry), fall through to
    // new-session creation rather than returning 404. MCP clients
    // (including Claude) do not reliably re-initialise on 404 — they
    // show a generic "tool execution failed" error instead. Falling
    // through gives the request a fresh transport, behaving like the
    // old stateless mode for that one call, which is better than a
    // hard failure.
    if (incomingSessionId) {
      const existing = sessionStore.get(incomingSessionId);

      if (existing) {
        existing.lastActivity = Date.now();
        try {
          await existing.transport.handleRequest(req, res, req.body);
          // DELETE = explicit session termination (MCP spec §4.2)
          if (req.method === 'DELETE') {
            existing.transport.close();
            existing.server.close();
            sessionStore.delete(incomingSessionId);
            log.info({ sessionId: incomingSessionId }, 'MCP session terminated by client');
          }
        } catch (err) {
          log.error({ err, sessionId: incomingSessionId }, 'MCP handler error (existing session)');
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            });
          }
        }
        return;
      }

      // ── Non-initialize POST on a stale session ─────────────────────────
      // If the client sends a tool call (or any non-initialize method) with
      // a session ID we don't recognise, falling through to an uninitialized
      // transport produces a confusing protocol error that Claude shows as
      // "Error occurred during tool execution". Return a proper JSON-RPC
      // session-expired response with HTTP 200 instead (HTTP 404 is not used
      // because Claude Desktop does not automatically reinitialise on 404).
      // The client can retry after a fresh initialize.
      if (req.method === 'POST') {
        const body = req.body as { method?: string; id?: unknown } | undefined;
        if (body?.method && body.method !== 'initialize') {
          log.info({ sessionId: incomingSessionId, method: body.method }, 'MCP session not found for non-initialize POST — returning session-expired error');
          res.status(200).json({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'MCP session not found. The server may have restarted — please start a new conversation to reinitialise the connection.',
            },
            id: body.id ?? null,
          });
          return;
        }
      }

      log.info({ sessionId: incomingSessionId }, 'MCP session not found — falling through to new session (server restart / TTL expiry)');
    }

    // ── New session (no Mcp-Session-Id or stale session ID) ───────────────
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    const server = buildServer();

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      // sessionId is populated after handleRequest processes the initialize request.
      const sessionId = transport.sessionId;
      if (sessionId) {
        sessionStore.set(sessionId, { transport, server, lastActivity: Date.now() });
        log.info({ sessionId, activeSessions: sessionStore.size }, 'MCP session created');
      } else {
        // No session ID generated (e.g. non-initialize POST on stale session) — tear down.
        transport.close();
        server.close();
      }
    } catch (err) {
      log.error({ err }, 'MCP handler error (new session)');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };
}
