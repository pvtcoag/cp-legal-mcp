import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from './logger.js';
import { registerResearchCases } from './tools/research-cases.js';
import { registerResearchLegislation } from './tools/research-legislation.js';
import { registerGetJudgment } from './tools/get-judgment.js';
import { registerFindCitingCases } from './tools/find-citing-cases.js';
import { registerSearchByCitation } from './tools/search-by-citation.js';
import { registerFormatCitation } from './tools/format-citation.js';
import { registerGeneratePinpoint } from './tools/generate-pinpoint.js';
import { registerAskJudgment } from './tools/ask-judgment.js';
import { registerEnrichJudgment } from './tools/enrich-judgment.js';
import { registerSummariseJudgment } from './tools/summarise-judgment.js';
import { registerClassifyLegalIssue } from './tools/classify-legal-issue.js';
import { registerFindRelatedCases } from './tools/find-related-cases.js';
import { registerCompareCases } from './tools/compare-cases.js';
import { registerAskLegislation } from './tools/ask-legislation.js';
import { registerGetLegislation } from './tools/get-legislation.js';
import { registerGetMatterHistory } from './tools/get-matter-history.js';
import { registerInspectDatabase } from './tools/inspect-database.js';
import { registerLookupEntity } from './tools/lookup-entity.js';
import { registerSearchAsic } from './tools/search-asic.js';
import { registerGetDirectorHistory } from './tools/get-director-history.js';
import { registerSearchAsicDecisions } from './tools/search-asic-decisions.js';
import { registerSearchAcccDecisions } from './tools/search-accc-decisions.js';
import { registerSearchAsxAnnouncements } from './tools/search-asx-announcements.js';
import { registerSummariseMatter } from './tools/summarise-matter.js';
import { registerBuildChronology } from './tools/build-chronology.js';

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

  // Legislation analysis
  registerGetLegislation(server);
  registerAskLegislation(server);

  // Issue classification
  registerClassifyLegalIssue(server);

  // Citation utilities
  registerFormatCitation(server);
  registerGeneratePinpoint(server);

  // Matter tracking
  registerGetMatterHistory(server);

  // Entity intelligence
  registerLookupEntity(server);
  registerSearchAsic(server);
  registerGetDirectorHistory(server);

  // Regulatory decisions
  registerSearchAsicDecisions(server);
  registerSearchAcccDecisions(server);

  // Market data
  registerSearchAsxAnnouncements(server);

  // Matter intelligence
  registerSummariseMatter(server);
  registerBuildChronology(server);

  // Admin (restricted to ADMIN_USERS)
  registerInspectDatabase(server);

  return server;
}

export function createMcpHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const requestId = crypto.randomUUID();
    const log = logger.child({ requestId, method: req.method });
    log.debug({ path: req.path }, 'MCP request received');

    // Stateless: no sessionId — fresh server+transport per request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const server = buildServer();

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      res.on('close', () => {
        log.debug('MCP request closed, tearing down');
        transport.close();
        server.close();
      });
    } catch (err) {
      log.error({ err }, 'MCP handler error');
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
