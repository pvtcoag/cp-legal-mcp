import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, matterRefSchema } from './_shared.js';
import {
  fetchDocumentText,
  resolveJudgmentUrl,
  AuslawError,
} from '../auslaw-client.js';
import { enrichDocument, type EnrichedJudgment } from '../isaacus-client.js';
import { truncateText } from '../text-utils.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';
import { getCachedEnrichment, upsertEnrichment } from '../db.js';

const inputSchemaBase = z.object({
  citation_or_url: z
    .string()
    .min(5)
    .optional()
    .describe('Neutral citation (e.g. "[2024] HCA 12") or full AustLII URL of the judgment'),
  citations_or_urls: z
    .array(z.string().min(5))
    .min(1)
    .max(5)
    .optional()
    .describe(
      'Array of up to 5 neutral citations or AustLII URLs for batch enrichment. ' +
      'Use instead of citation_or_url when enriching multiple judgments at once.',
    ),
  matter_ref: matterRefSchema,
});

const inputSchema = inputSchemaBase.refine(
  (d) => d.citation_or_url || (d.citations_or_urls && d.citations_or_urls.length > 0),
  { message: 'Either citation_or_url or citations_or_urls must be provided' },
);

export function registerEnrichJudgment(server: McpServer): void {
  registerTool(
    server,
    'enrich_judgment',
    {
      title: 'Enrich judgment',
      description: '[Judgment Analysis] Extract structured entities from an Australian court judgment: parties and their roles, key dates, cases cited with reception sentiment (positive/mixed/negative/neutral), and defined legal terms. Reception sentiment is particularly valuable — it reveals how each cited case was treated by the court. Uses Isaacus Kanon 2 Enricher. Accepts a single citation/URL or an array of up to 5 for batch enrichment.',
      inputSchema: inputSchemaBase.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input: z.infer<typeof inputSchemaBase>) => {
      const log = logger.child({ tool: 'enrich_judgment' });

      const inputs: string[] = input.citations_or_urls ?? (input.citation_or_url ? [input.citation_or_url] : []);
      const isBatch = !!input.citations_or_urls;

      interface EnrichSuccess {
        judgment: { title: string; citation: string | null; url: string; canonical_url: string };
        document_type: unknown;
        jurisdiction: unknown;
        parties: unknown;
        key_dates: unknown;
        citations_made: unknown;
        defined_terms: unknown;
        tokens_used: number;
        input: string;
      }
      interface EnrichFailure {
        error: string;
        message: string;
        input: string;
      }

      async function enrichOne(identifier: string): Promise<EnrichSuccess> {
        let resolved;
        try {
          resolved = await resolveJudgmentUrl(identifier);
        } catch (err) {
          if (err instanceof AuslawError) {
            log.warn({ err }, 'resolveJudgmentUrl failed');
            throw { error: 'invalid_input', message: err.message };
          }
          throw err;
        }

        let doc;
        try {
          doc = await fetchDocumentText(resolved.url);
        } catch (err) {
          if (err instanceof AuslawError) {
            log.warn({ err }, 'fetch_document_text failed');
            throw { error: 'upstream_unavailable', message: 'Could not retrieve the judgment. The legal database may be temporarily unavailable.' };
          }
          throw err;
        }

        let enriched: EnrichedJudgment;
        let enrichTokens = 0;
        // Check enrichment cache first
        const cachedEnrich = await getCachedEnrichment(resolved.url);
        if (cachedEnrich) {
          enriched = cachedEnrich.enrichment as unknown as EnrichedJudgment;
          enrichTokens = 0;
        } else {
          try {
            const enrichResult = await enrichDocument(truncateText(doc.text, 50_000));
            enriched = enrichResult.data;
            enrichTokens = enrichResult.tokensUsed;
            // Fire-and-forget cache write
            upsertEnrichment(resolved.url, enrichResult.data as unknown as Record<string, unknown>, enrichTokens)
              .catch(() => { /* non-critical */ });
          } catch (err) {
            log.warn({ err }, 'Isaacus enrichDocument failed');
            throw { error: 'enrichment_failed', message: 'Could not enrich the judgment. Please use get_judgment to read the full text instead.' };
          }
        }

        const citation = doc.citation ?? resolved.citation;
        const title = doc.title ?? citation ?? identifier;

        return {
          judgment: {
            title,
            citation: citation ?? null,
            url: resolved.url,
            canonical_url: resolved.canonicalUrl ?? resolved.url,
          },
          document_type: enriched.document_type,
          jurisdiction: enriched.jurisdiction,
          parties: enriched.parties,
          key_dates: enriched.key_dates,
          citations_made: enriched.citations_made,
          defined_terms: enriched.defined_terms,
          tokens_used: enrichTokens,
          input: identifier,
        };
      }

      if (!isBatch) {
        // Single mode — original behaviour
        const identifier = inputs[0]!;
        let result: EnrichSuccess;
        try {
          result = await enrichOne(identifier);
        } catch (err) {
          const e = err as { error?: string; message?: string };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: e.error ?? 'unknown_error',
              message: e.message ?? String(err),
              received: identifier,
            }) }],
            isError: true,
          };
        }

        recordMatterQuery({
          matter_ref: input.matter_ref,
          tool_name: 'enrich_judgment',
          query_text: identifier,
          result_count: 1,
          top_results: [{ title: result.judgment.title, citation: result.judgment.citation ?? undefined, url: result.judgment.url }],
          api_tokens_used: result.tokens_used,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            judgment: result.judgment,
            document_type: result.document_type,
            jurisdiction: result.jurisdiction,
            parties: result.parties,
            key_dates: result.key_dates,
            citations_made: result.citations_made,
            defined_terms: result.defined_terms,
          }) }],
        };
      }

      // Batch mode
      const settled = await Promise.allSettled(inputs.map((id) => enrichOne(id)));

      const batchResults: Array<EnrichSuccess | EnrichFailure> = settled.map((r, i) => {
        if (r.status === 'fulfilled') {
          return r.value;
        } else {
          const e = r.reason as { error?: string; message?: string };
          return {
            error: e.error ?? 'unknown_error',
            message: e.message ?? String(r.reason),
            input: inputs[i]!,
          };
        }
      });

      const successes = batchResults.filter((r): r is EnrichSuccess => !('error' in r));
      let totalTokens = 0;
      for (const s of successes) {
        totalTokens += s.tokens_used;
      }

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'enrich_judgment',
        query_text: inputs.join(', '),
        result_count: successes.length,
        top_results: successes
          .slice(0, 3)
          .map((s) => ({ title: s.judgment.title, citation: s.judgment.citation ?? undefined, url: s.judgment.url })),
        api_tokens_used: totalTokens,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          batch_count: inputs.length,
          results: batchResults.map((r) => {
            if ('error' in r) return r;
            const { tokens_used: _t, input: _i, ...rest } = r;
            return rest;
          }),
        }) }],
      };
    },
  );
}
