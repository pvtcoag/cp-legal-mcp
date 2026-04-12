import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  fetchDocumentText,
  resolveJudgmentUrl,
  searchCases,
  AuslawError,
} from '../auslaw-client.js';
import {
  embedText,
  rerank,
  cosineSimilarity,
} from '../isaacus-client.js';
import {
  getJudgmentEmbedding,
  upsertJudgmentEmbedding,
  getAllJudgmentEmbeddings,
} from '../db.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  citation_or_url: z
    .string()
    .min(5)
    .describe('Neutral citation (e.g. "[2024] HCA 12") or full AustLII URL of the seed judgment'),
  additional_seeds: z
    .array(z.string().min(5))
    .max(4)
    .optional()
    .describe(
      'Up to 4 additional neutral citations or AustLII URLs to use as additional seed judgments alongside citation_or_url. ' +
      'The embeddings of all seeds are averaged to find cases related to all of them simultaneously.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(15)
    .default(5)
    .describe('Maximum number of related cases to return'),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Matter reference to tag this search in the research log. If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.',
    ),
});

export function registerFindRelatedCases(server: McpServer): void {
  server.tool(
    'find_related_cases',
    'Find Australian judgments semantically related to a given case using Kanon 2 Embedder vector similarity. Searches the judgment corpus (built up as cases are researched) plus an AustLII keyword search based on the case title. Results improve as the corpus grows. Use this to discover cases that address similar legal issues without relying solely on the citation network.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'find_related_cases', input: input.citation_or_url });
      let totalTokens = 0;

      // ── 1. Resolve and fetch the seed judgment ──────────────────────────────
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

      const seedTitle = doc.title ?? resolved.citation ?? input.citation_or_url;
      const seedCitation = doc.citation ?? resolved.citation;

      // ── 2. Get or generate embedding for the seed judgment ──────────────────
      // Embed only first 8000 chars — the intro and headnote carry most of the
      // topical signal; full text would exceed the model context anyway.
      const TEXT_WINDOW = 8000;
      const textForEmbedding = doc.text.slice(0, TEXT_WINDOW);

      let seedEmbedding = await getJudgmentEmbedding(resolved.url).catch(() => null);
      if (!seedEmbedding) {
        try {
          const embedResult = await embedText(textForEmbedding, 'retrieval/document');
          seedEmbedding = embedResult.embedding;
          totalTokens += embedResult.tokensUsed;
          // Cache it for future calls — fire-and-forget
          upsertJudgmentEmbedding(resolved.url, seedEmbedding).catch((err) =>
            logger.warn({ err }, 'embedding cache write failed'),
          );
        } catch (err) {
          log.warn({ err }, 'Isaacus embedding failed — falling back to title search only');
          seedEmbedding = null;
        }
      }

      // ── 2b. Additional seeds (if any) ─────────────────────────────────────────
      const seedsUsed: Array<{ title: string; citation: string | null; url: string }> = [
        { title: seedTitle, citation: seedCitation ?? null, url: resolved.url },
      ];

      if (input.additional_seeds && input.additional_seeds.length > 0) {
        const additionalResults = await Promise.allSettled(
          input.additional_seeds.map(async (seed) => {
            const res = await resolveJudgmentUrl(seed);
            const d = await fetchDocumentText(res.url);
            const t = d.text.slice(0, TEXT_WINDOW);
            let emb = await getJudgmentEmbedding(res.url).catch(() => null);
            if (!emb) {
              const r = await embedText(t, 'retrieval/document');
              emb = r.embedding;
              totalTokens += r.tokensUsed;
              upsertJudgmentEmbedding(res.url, emb).catch(() => null);
            }
            return {
              embedding: emb,
              title: d.title ?? res.citation ?? seed,
              citation: d.citation ?? res.citation ?? null,
              url: res.url,
            };
          }),
        );

        const additionalEmbeddings: number[][] = [];
        for (const r of additionalResults) {
          if (r.status === 'fulfilled') {
            additionalEmbeddings.push(r.value.embedding);
            seedsUsed.push({
              title: r.value.title,
              citation: r.value.citation,
              url: r.value.url,
            });
          } else {
            log.warn({ reason: r.reason }, 'Additional seed failed — skipping');
          }
        }

        // Average all embeddings (primary + additional) element-wise
        if (seedEmbedding && additionalEmbeddings.length > 0) {
          const allEmbs = [seedEmbedding, ...additionalEmbeddings];
          const dims = seedEmbedding.length;
          const averaged = new Array<number>(dims).fill(0);
          for (const emb of allEmbs) {
            for (let i = 0; i < dims; i++) {
              averaged[i]! += emb[i]! / allEmbs.length;
            }
          }
          seedEmbedding = averaged;
        }
      }

      // ── 3. Corpus similarity search ─────────────────────────────────────────
      interface SimilarCase {
        url: string;
        title: string | null;
        citation: string | null;
        similarity: number;
        source: 'corpus' | 'auslaw';
        excerpt?: string;
      }

      const corpusResults: SimilarCase[] = [];
      let corpus: Awaited<ReturnType<typeof getAllJudgmentEmbeddings>> = [];

      if (seedEmbedding) {
        corpus = await getAllJudgmentEmbeddings().catch(() => []);
        const others = corpus.filter((e) => e.url !== resolved.url);

        if (others.length > 0) {
          const scored = others
            .map((e) => ({
              url: e.url,
              title: e.title,
              citation: e.citation,
              similarity: cosineSimilarity(seedEmbedding!, e.embedding),
              source: 'corpus' as const,
            }))
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, input.limit * 2); // over-fetch for reranking

          corpusResults.push(...scored);
          log.debug({ corpusSize: others.length, found: scored.length }, 'corpus similarity done');
        }
      }

      // ── 4. AustLII keyword search for freshness ─────────────────────────────
      // Use the title as the search query — the most stable topical signal.
      const auslawCandidates = await searchCases({
        query: seedTitle,
        limit: input.limit * 3,
      }).catch(() => []);

      // Exclude the seed judgment itself
      const auslawFiltered = auslawCandidates.filter(
        (c) => c.url !== resolved.url && c.citation !== seedCitation,
      );

      // ── 5. Merge and rerank ─────────────────────────────────────────────────
      // Build a unified candidate pool from both sources, deduplicated by URL
      const seen = new Set<string>();
      const allCandidates: Array<{
        title: string; citation: string; url: string; excerpt: string;
        similarity?: number; source: 'corpus' | 'auslaw';
      }> = [];

      for (const c of corpusResults) {
        if (!seen.has(c.url)) {
          seen.add(c.url);
          allCandidates.push({
            title: c.title ?? '',
            citation: c.citation ?? '',
            url: c.url,
            excerpt: '',
            similarity: c.similarity,
            source: 'corpus',
          });
        }
      }
      for (const c of auslawFiltered) {
        if (!seen.has(c.url)) {
          seen.add(c.url);
          allCandidates.push({
            title: c.title,
            citation: c.citation,
            url: c.url,
            excerpt: c.excerpt ?? '',
            source: 'auslaw',
          });
        }
      }

      let finalResults: Array<{ title: string; citation?: string; url: string; excerpt?: string; corpus_similarity?: number; relevance_score: number }>;

      if (allCandidates.length === 0) {
        finalResults = [];
      } else {
        const rerankQuery = seedsUsed.length === 1
          ? `Cases related to: ${seedTitle}${seedCitation ? ` (${seedCitation})` : ''}`
          : `Cases related to: ${seedsUsed.map((s) => s.title + (s.citation ? ` (${s.citation})` : '')).join('; ')}`;
        try {
          const rerankResult = await rerank(rerankQuery, allCandidates, input.limit);
          totalTokens += rerankResult.tokensUsed;
          finalResults = rerankResult.results.map(({ item, score }) => ({
            title: item.title,
            citation: item.citation || undefined,
            url: item.url,
            ...(item.excerpt ? { excerpt: item.excerpt } : {}),
            ...(item.similarity !== undefined ? { corpus_similarity: Math.round(item.similarity * 1000) / 1000 } : {}),
            relevance_score: Math.round(score * 1000) / 1000,
          }));
        } catch {
          // Reranker failed — return raw candidates sorted by corpus similarity then title
          finalResults = allCandidates.slice(0, input.limit).map((c) => ({
            title: c.title,
            citation: c.citation || undefined,
            url: c.url,
            ...(c.excerpt ? { excerpt: c.excerpt } : {}),
            ...(c.similarity !== undefined ? { corpus_similarity: Math.round(c.similarity * 1000) / 1000 } : {}),
            relevance_score: c.similarity ?? 0,
          }));
        }
      }

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'find_related_cases',
        query_text: input.citation_or_url,
        result_count: finalResults.length,
        top_results: finalResults.slice(0, 3).map((r) => ({ title: r.title, citation: r.citation, url: r.url })),
        api_tokens_used: totalTokens,
      });

      const corpusSize = corpus.length;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          seed_case: seedsUsed[0]!,
          additional_seeds_used: seedsUsed.slice(1),
          seeds_count: seedsUsed.length,
          related_cases: finalResults,
          corpus_size: corpusSize,
          note: corpusResults.length === 0
            ? 'Corpus is empty or has only this judgment — results are from AustLII keyword search. The corpus grows as more judgments are researched with summarise_judgment, enrich_judgment, or ask_judgment.'
            : `${corpusResults.length} result(s) from the ${corpusSize}-judgment semantic corpus; remaining from AustLII.`,
        }) }],
      };
    },
  );
}
