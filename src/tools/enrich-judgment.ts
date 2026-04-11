import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  fetchDocumentText,
  resolveJudgmentUrl,
  AuslawError,
  isJadeExpiry,
  JADE_EXPIRY_NOTICE,
} from '../auslaw-client.js';
import { enrichDocument } from '../isaacus-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  citation_or_url: z
    .string()
    .min(5)
    .describe('Neutral citation (e.g. "[2024] HCA 12") or full AustLII URL of the judgment'),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this enrichment in the research log. If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.'),
});

export function registerEnrichJudgment(server: McpServer): void {
  server.tool(
    'enrich_judgment',
    'Extract structured entities from an Australian court judgment: parties and their roles, key dates, cases cited with reception sentiment (positive/mixed/negative/neutral), and defined legal terms. Reception sentiment is particularly valuable — it reveals how each cited case was treated by the court. Uses Isaacus Kanon 2 Enricher.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'enrich_judgment', input: input.citation_or_url });

      // Resolve citation or URL → concrete fetch URL
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

      // Fetch judgment text
      let doc;
      try {
        doc = await fetchDocumentText(resolved.url);
      } catch (err) {
        if (err instanceof AuslawError) {
          const jadeExpired = isJadeExpiry(err);
          if (jadeExpired) logger.warn({ err }, 'JADE session cookie may have expired');
          else log.warn({ err }, 'AusLaw fetch_document_text failed');
          const baseMessage = jadeExpired
            ? 'Could not retrieve the judgment — the JADE session appears to have expired.'
            : 'Could not retrieve the judgment. The legal database may be temporarily unavailable.';
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: jadeExpired ? 'jade_session_expired' : 'upstream_unavailable',
              message: baseMessage + (jadeExpired ? JADE_EXPIRY_NOTICE : ''),
              detail: err.message,
            }) }],
            isError: true,
          };
        }
        throw err;
      }

      // Enrich using Isaacus
      let enriched;
      let enrichTokens = 0;
      try {
        const enrichResult = await enrichDocument(doc.text);
        enriched = enrichResult.data;
        enrichTokens = enrichResult.tokensUsed;
      } catch (err) {
        log.warn({ err }, 'Isaacus enrichDocument failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'enrichment_failed',
            message: 'Could not enrich the judgment. Please use get_judgment to read the full text instead.',
            detail: err instanceof Error ? err.message : String(err),
          }) }],
          isError: true,
        };
      }

      const citation = doc.citation ?? resolved.citation;
      const title = doc.title ?? citation ?? input.citation_or_url;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'enrich_judgment',
        query_text: input.citation_or_url,
        result_count: 1,
        top_results: [{ title, citation, url: resolved.url }],
        api_tokens_used: enrichTokens,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          judgment: {
            title,
            citation,
            url: resolved.url,
            canonical_url: resolved.canonicalUrl ?? resolved.url,
          },
          document_type: enriched.document_type,
          jurisdiction: enriched.jurisdiction,
          parties: enriched.parties,
          key_dates: enriched.key_dates,
          citations_made: enriched.citations_made,
          defined_terms: enriched.defined_terms,
        }, null, 2) }],
      };
    },
  );
}
