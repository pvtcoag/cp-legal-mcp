/**
 * Shared building blocks for tool registration.
 *
 * Exports:
 *  - matterRefSchema: the Zod schema every tool should use for its `matter_ref`
 *    input so malformed values are rejected at the Zod boundary instead of
 *    being silently dropped downstream.
 *  - registerTool: thin wrapper around McpServer.registerTool that attaches
 *    MCP tool annotations (readOnlyHint etc.) and applies the same admin-note
 *    error decoration the old monkey-patched server.tool() did.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MATTER_REF_RE } from '../matter-log.js';

const ADMIN_ERROR_NOTE = '\n\nIf this error persists, contact your administrator.';

export const matterRefSchema = z
  .string()
  .regex(MATTER_REF_RE, 'matter_ref must be alphanumeric with hyphens, underscores, slashes or spaces (max 100 chars)')
  .max(100)
  .optional()
  .describe(
    'Optional matter/file reference to tag this query with for tracking at /mcp/matters. ' +
    'Alphanumeric, hyphens, underscores, slashes, spaces. Max 100 chars.',
  );

export interface ToolAnnotations {
  /** Human-friendly title shown by MCP clients. */
  title?: string;
  /** true = tool does not modify server state. */
  readOnlyHint?: boolean;
  /** true = repeat calls may have destructive effect. */
  destructiveHint?: boolean;
  /** true = repeated calls with same args produce the same effect. */
  idempotentHint?: boolean;
  /** true = tool reaches outside the MCP server (upstream APIs, DB, etc.). */
  openWorldHint?: boolean;
}

// The SDK's ToolCallback return type is generic over the input schema; we
// keep the handler loosely typed here and rely on the per-tool Zod shape to
// type `input` at the call-site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (input: any, ctx?: any) => Promise<any> | any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string; [k: string]: any }>; structuredContent?: Record<string, unknown> };

function decorateError(result: ToolResult): ToolResult {
  if (!result?.isError) return result;
  return {
    ...result,
    content: (result.content ?? []).map((c) => {
      if (c.type !== 'text' || typeof c.text !== 'string') return c;
      try {
        const parsed = JSON.parse(c.text) as Record<string, unknown>;
        if (typeof parsed['message'] === 'string') {
          return { ...c, text: JSON.stringify({ ...parsed, message: parsed['message'] + ADMIN_ERROR_NOTE }) };
        }
      } catch { /* not JSON — fall through */ }
      return { ...c, text: c.text + ADMIN_ERROR_NOTE };
    }),
  };
}

/**
 * Register a tool with the MCP server, applying annotations and the shared
 * admin-note error decoration.
 */
export function registerTool(
  server: McpServer,
  name: string,
  config: {
    title?: string;
    description: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputSchema?: Record<string, any>;
    annotations: ToolAnnotations;
  },
  handler: Handler,
): void {
   
  const wrapped: Handler = async (input: unknown, ctx: unknown) => {
    const result = (await handler(input, ctx)) as ToolResult;
    return decorateError(result);
  };

  server.registerTool(
    name,
    {
      ...(config.title ? { title: config.title } : {}),
      description: config.description,
      inputSchema: config.inputSchema,
      ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
      annotations: config.annotations,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapped as any,
  );
}
