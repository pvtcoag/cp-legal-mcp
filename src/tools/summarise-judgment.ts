import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  fetchDocumentText,
  resolveJudgmentUrl,
  AuslawError,
  isJadeExpiry,
  JADE_EXPIRY_NOTICE,
} from '../auslaw-client.js';
import { enrichDocument, extractAnswer, type ExtractedAnswer } from '../isaacus-client.js';
import { extractRelevantPassages, truncateText } from '../text-utils.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  citation_or_url: z
    .string()
    .min(5)
    .describe('Neutral citation (e.g. "[2024] HCA 12") or full AustLII URL of the judgment'),
  include_metadata: z
    .boolean()
    .default(true)
    .describe(
      'Include enriched metadata: parties, key dates, cases cited with reception sentiment, and defined terms. ' +
      'Set false for a faster summary containing only the five narrative dimensions (holding, orders, key facts, ' +
      'legal principles, outcome). Reduces cost by ~32% — use when you need the summary only, not the citation network.',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Matter reference to tag this summary in the research log. If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.',
    ),
});

// Five dimensions of a judgment summary, each answered with targeted extractive QA
const QA_QUESTIONS = {
  holding: "What is the court's final decision, ruling, or principal holding?",
  orders: 'What orders or relief did the court grant or make?',
  key_facts: 'What are the key facts or background circumstances giving rise to the dispute?',
  legal_principles: 'What legal tests, principles, or rules did the court state, apply, or reformulate?',
  outcome: "What was the result — who succeeded and what did the court decide about each party's claims?",
} as const;

function qaField(
  result: { answers: ExtractedAnswer[]; inextractable: boolean },
): { text: string; confidence: number } | null {
  if (result.inextractable || result.answers.length === 0) return null;
  const a = result.answers[0]!;
  return { text: a.text, confidence: Math.round(a.score * 1000) / 1000 };
}

export function registerSummariseJudgment(server: McpServer): void {
  server.tool(
    'summarise_judgment',
    'Produce a structured legal summary of an Australian court judgment: holding, orders, key facts, legal principles, and outcome. By default also includes enriched metadata (parties, key dates, cases cited with reception sentiment, defined terms). Set include_metadata: false for a faster, cheaper summary covering only the five narrative dimensions — useful when you just need the substance and not the citation network. Ideal as a first step before deeper research.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'summarise_judgment', input: input.citation_or_url });

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
          const jadeExpired = isJadeExpiry(err);
          if (jadeExpired) logger.warn({ err }, 'JADE session cookie may have expired');
          else log.warn({ err }, 'fetch_document_text failed');
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

      // Pre-process document text to reduce token costs:
      // - For QA: extract only relevant passages via keyword pre-filter (up to 24K chars)
      // - For enrichment: hard-truncate preserving start + end (up to 50K chars)
      const combinedQaQuery = Object.values(QA_QUESTIONS).join(' ');
      const qaText = extractRelevantPassages(doc.text, combinedQaQuery, 24_000);
      const enrichText = input.include_metadata ? truncateText(doc.text, 50_000) : '';

      // Run QA + (optionally) enrichment in parallel
      let enrichResult: Awaited<ReturnType<typeof enrichDocument>> | null = null;
      let holdingR, ordersR, factsR, principlesR, outcomeR;
      try {
        const promises: Promise<unknown>[] = [
          extractAnswer(QA_QUESTIONS.holding,          qaText, 1),
          extractAnswer(QA_QUESTIONS.orders,           qaText, 1),
          extractAnswer(QA_QUESTIONS.key_facts,        qaText, 1),
          extractAnswer(QA_QUESTIONS.legal_principles, qaText, 1),
          extractAnswer(QA_QUESTIONS.outcome,          qaText, 1),
          ...(input.include_metadata ? [enrichDocument(enrichText)] : []),
        ];
        const results = await Promise.all(promises);
        [holdingR, ordersR, factsR, principlesR, outcomeR] = results as [
          typeof holdingR, typeof ordersR, typeof factsR, typeof principlesR, typeof outcomeR
        ];
        enrichResult = input.include_metadata ? (results[5] as typeof enrichResult) : null;
      } catch (err) {
        log.warn({ err }, 'Isaacus summarisation failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'summarisation_failed',
            message:
              'Could not summarise the judgment. Use get_judgment to read the full text ' +
              'or enrich_judgment for structured entities alone.',
            detail: err instanceof Error ? err.message : String(err),
          }) }],
          isError: true,
        };
      }

      const enriched = enrichResult?.data ?? null;
      const totalTokens =
        (enrichResult?.tokensUsed ?? 0) +
        holdingR!.tokensUsed + ordersR!.tokensUsed + factsR!.tokensUsed +
        principlesR!.tokensUsed + outcomeR!.tokensUsed;

      const citation = doc.citation ?? resolved.citation;
      const title = doc.title ?? citation ?? input.citation_or_url;

      const qaScores = [holdingR!, ordersR!, factsR!, principlesR!, outcomeR!]
        .flatMap((r) => r.answers.map((a) => a.score));
      const accuracy_score = qaScores.length > 0 ? Math.min(...qaScores) : undefined;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'summarise_judgment',
        query_text: input.citation_or_url,
        result_count: 1,
        top_results: [{ title, citation, url: resolved.url }],
        api_tokens_used: totalTokens,
        accuracy_score,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          judgment: {
            title,
            citation,
            url: resolved.url,
            canonical_url: resolved.canonicalUrl ?? resolved.url,
          },
          ...(enriched ? {
            document_type: enriched.document_type,
            jurisdiction: enriched.jurisdiction,
            parties: enriched.parties,
            key_dates: enriched.key_dates,
          } : {}),
          summary: {
            holding: qaField(holdingR!),
            orders: qaField(ordersR!),
            key_facts: qaField(factsR!),
            legal_principles: qaField(principlesR!),
            outcome: qaField(outcomeR!),
          },
          ...(enriched ? {
            cases_cited: enriched.citations_made,
            defined_terms: enriched.defined_terms,
          } : {}),
          _suggested_next: enriched
            ? 'Use ask_judgment for questions not covered by the five summary dimensions above. Use find_citing_cases to trace subsequent treatment. Use find_related_cases to discover cases addressing similar issues. Do NOT call enrich_judgment — enrichment data is already included above.'
            : 'Metadata (parties, citations made) was skipped (include_metadata: false). Call enrich_judgment if you need the citation network. Use ask_judgment for targeted follow-up questions.',
        }) }],
      };
    },
  );
}
