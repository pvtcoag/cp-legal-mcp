import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, matterRefSchema } from './_shared.js';
import {
  fetchDocumentText,
  resolveJudgmentUrl,
  AuslawError,
} from '../auslaw-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  citation_or_url: z
    .string()
    .min(5)
    .describe(
      'Neutral citation (e.g. "[2024] HCA 12") or a full AustLII URL of the judgment to retrieve',
    ),
  max_chars: z
    .number()
    .int()
    .min(5000)
    .max(500_000)
    .optional()
    .describe(
      'Maximum characters to return. Omit for full text (may be very large for lengthy judgments). ' +
      'Use 30000–80000 when you only need to read or quote a portion. ' +
      'The response includes total_chars so you can request more if needed.',
    ),
  matter_ref: matterRefSchema,
  start_at_section: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Return text starting from this section heading or paragraph number. ' +
      'Use to access a specific part of a long judgment without reading from the beginning. ' +
      'Examples: "REASONS FOR JUDGMENT", "ORDERS", "[45]", "Conclusion". ' +
      'Case-insensitive substring match. Returns from beginning with a note if not found.',
    ),
});

export function registerGetJudgment(server: McpServer): void {
  registerTool(
    server,
    'get_judgment',
    {
      title: 'Get judgment',
      description: '[Judgment Analysis] Retrieve the full text of an Australian court judgment by neutral citation or AustLII URL. Validates citations and returns structured text with metadata. Check total_chars in the response before requesting full text of lengthy judgments — use max_chars to limit context usage when you only need part of the text.',
      inputSchema: inputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const log = logger.child({ tool: 'get_judgment', input: input.citation_or_url });

      let resolved;
      try {
        resolved = await resolveJudgmentUrl(input.citation_or_url);
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'resolveJudgmentUrl failed');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'invalid_input',
              message: err.message,
              received: input.citation_or_url,
            }) }],
            isError: true,
          };
        }
        throw err;
      }

      log.debug({ url: resolved.url }, 'fetching document');

      let doc;
      try {
        doc = await fetchDocumentText(resolved.url);
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'fetch_document_text failed');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'upstream_unavailable',
              message: 'Could not retrieve the judgment. The legal database may be temporarily unavailable.',
              detail: err.message,
            }) }],
            isError: true,
          };
        }
        throw err;
      }

      const citation = doc.citation ?? resolved.citation;
      const totalChars = doc.text.length;

      // Section anchoring — find the start position within the document
      let startIndex = 0;
      let sectionFound = false;
      if (input.start_at_section) {
        const needle = input.start_at_section.toLowerCase();
        const haystack = doc.text.toLowerCase();
        const idx = haystack.indexOf(needle);
        if (idx !== -1) {
          startIndex = idx;
          sectionFound = true;
        }
      }
      const textFromSection = startIndex > 0 ? doc.text.slice(startIndex) : doc.text;
      const sectionCharsTotal = textFromSection.length;

      // Apply optional character cap — preserves full text by default so verbatim
      // quoting is always possible, but lets callers limit context window usage.
      const text =
        input.max_chars !== undefined && sectionCharsTotal > input.max_chars
          ? textFromSection.slice(0, input.max_chars)
          : textFromSection;
      const truncated = text.length < sectionCharsTotal;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'get_judgment',
        query_text: input.citation_or_url,
        result_count: 1,
        top_results: [{ title: doc.title ?? input.citation_or_url, citation, url: resolved.url }],
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          title: doc.title,
          citation,
          url: resolved.url,
          canonical_url: resolved.canonicalUrl ?? resolved.url,
          total_chars: totalChars,
          ...(startIndex > 0 ? { start_offset: startIndex } : {}),
          ...(input.start_at_section ? { section_found: sectionFound } : {}),
          ...(input.start_at_section && !sectionFound ? { note: `Section "${input.start_at_section}" not found — returning from document start.` } : {}),
          ...(truncated ? { truncated: true, returned_chars: text.length } : {}),
          text,
        }) }],
      };
    },
  );
}
