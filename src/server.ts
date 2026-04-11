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
import { registerGetMatterHistory } from './tools/get-matter-history.js';

function buildServer(): McpServer {
  const server = new McpServer({
    name: 'cp-legal-mcp',
    version: '0.1.0',
  });

  // Discovery & retrieval
  registerResearchCases(server);
  registerResearchLegislation(server);
  registerSearchByCitation(server);
  registerFindCitingCases(server);

  // Document access
  registerGetJudgment(server);

  // Citation utilities
  registerFormatCitation(server);
  registerGeneratePinpoint(server);

  // Matter tracking
  registerGetMatterHistory(server);

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
