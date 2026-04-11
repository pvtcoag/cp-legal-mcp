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
    'Produce a structured legal summary of an Australian court judgment: holding, orders, key facts, legal principles, and outcome — combined with enriched metadata (parties, key dates, cases cited with reception sentiment, defined terms). Runs enrichment and five parallel extractive QA calls in a single operation. More efficient than get_judgment for a quick overview, and more comprehensive than ask_judgment for a single question. Ideal as a first step before deeper research.',
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

      // Enrichment + all five QA calls run in parallel for maximum throughput
      let enrichResult, holdingR, ordersR, factsR, principlesR, outcomeR;
      try {
        [enrichResult, holdingR, ordersR, factsR, principlesR, outcomeR] = await Promise.all([
          enrichDocument(doc.text),
          extractAnswer(QA_QUESTIONS.holding, doc.text, 1),
          extractAnswer(QA_QUESTIONS.orders, doc.text, 1),
          extractAnswer(QA_QUESTIONS.key_facts, doc.text, 1),
          extractAnswer(QA_QUESTIONS.legal_principles, doc.text, 1),
          extractAnswer(QA_QUESTIONS.outcome, doc.text, 1),
        ]);
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

      const enriched = enrichResult.data;
      const totalTokens =
        enrichResult.tokensUsed +
        holdingR.tokensUsed + ordersR.tokensUsed + factsR.tokensUsed +
        principlesR.tokensUsed + outcomeR.tokensUsed;

      const citation = doc.citation ?? resolved.citation;
      const title = doc.title ?? citation ?? input.citation_or_url;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'summarise_judgment',
        query_text: input.citation_or_url,
        result_count: 1,
        top_results: [{ title, citation, url: resolved.url }],
        api_tokens_used: totalTokens,
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
          summary: {
            holding: qaField(holdingR),
            orders: qaField(ordersR),
            key_facts: qaField(factsR),
            legal_principles: qaField(principlesR),
            outcome: qaField(outcomeR),
          },
          cases_cited: enriched.citations_made,
          defined_terms: enriched.defined_terms,
        }, null, 2) }],
      };
    },
  );
}
