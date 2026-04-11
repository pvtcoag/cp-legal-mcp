import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  fetchDocumentText,
  resolveJudgmentUrl,
  AuslawError,
  isJadeExpiry,
  JADE_EXPIRY_NOTICE,
} from '../auslaw-client.js';
import { extractAnswer, type ExtractedAnswer } from '../isaacus-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  citation_or_url_a: z
    .string()
    .min(5)
    .describe('Neutral citation or AustLII URL of the first case'),
  citation_or_url_b: z
    .string()
    .min(5)
    .describe('Neutral citation or AustLII URL of the second case'),
  question: z
    .string()
    .min(5)
    .max(500)
    .describe(
      'The legal question to compare across both cases, e.g. "How did the court treat the duty of care issue?" or "What approach did the court take to damages?"',
    ),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2)
    .describe('Number of answer candidates to return per case'),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Matter reference to tag this comparison in the research log. If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.',
    ),
});

interface CasePanel {
  title: string;
  citation: string | undefined;
  url: string;
  answer: { text: string; confidence: number } | null;
  all_answers: Array<{ text: string; confidence: number }>;
  answer_found: boolean;
}

async function resolveAndFetch(input: string) {
  const resolved = await resolveJudgmentUrl(input);
  const doc = await fetchDocumentText(resolved.url);
  return { resolved, doc };
}

function buildPanel(
  resolved: Awaited<ReturnType<typeof resolveJudgmentUrl>>,
  doc: Awaited<ReturnType<typeof fetchDocumentText>>,
  extraction: { answers: ExtractedAnswer[]; inextractable: boolean; tokensUsed: number },
): CasePanel {
  const citation = doc.citation ?? resolved.citation;
  const title = doc.title ?? citation ?? resolved.url;
  const answer_found = !extraction.inextractable && extraction.answers.length > 0;

  return {
    title,
    citation,
    url: resolved.url,
    answer: answer_found
      ? { text: extraction.answers[0]!.text, confidence: Math.round(extraction.answers[0]!.score * 1000) / 1000 }
      : null,
    all_answers: extraction.answers.map((a) => ({
      text: a.text,
      confidence: Math.round(a.score * 1000) / 1000,
    })),
    answer_found,
  };
}

export function registerCompareCases(server: McpServer): void {
  server.tool(
    'compare_cases',
    'Compare how two Australian judgments address the same legal question. Fetches both cases (from the judgment cache where available), runs extractive QA in parallel, and returns a side-by-side comparison. Ideal for analysing how different courts or different periods have treated the same principle, test, or issue.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'compare_cases' });

      // ── 1. Resolve both citations/URLs ──────────────────────────────────────
      let resolvedA, resolvedB;
      try {
        [resolvedA, resolvedB] = await Promise.all([
          resolveJudgmentUrl(input.citation_or_url_a),
          resolveJudgmentUrl(input.citation_or_url_b),
        ]);
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'resolveJudgmentUrl failed');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'invalid_input',
              message: err.message,
            }) }],
            isError: true,
          };
        }
        throw err;
      }

      if (resolvedA.url === resolvedB.url) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'invalid_input',
            message: 'Both inputs resolve to the same judgment URL. Provide two distinct cases.',
          }) }],
          isError: true,
        };
      }

      // ── 2. Fetch both judgment texts ────────────────────────────────────────
      let docA, docB;
      try {
        [docA, docB] = await Promise.all([
          fetchDocumentText(resolvedA.url),
          fetchDocumentText(resolvedB.url),
        ]);
      } catch (err) {
        if (err instanceof AuslawError) {
          const jadeExpired = isJadeExpiry(err);
          if (jadeExpired) logger.warn({ err }, 'JADE session cookie may have expired');
          else log.warn({ err }, 'fetch_document_text failed');
          const baseMessage = jadeExpired
            ? 'Could not retrieve one or both judgments — the JADE session appears to have expired.'
            : 'Could not retrieve one or both judgments. The legal database may be temporarily unavailable.';
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

      // ── 3. Extract answers from both judgments in parallel ──────────────────
      let extractionA, extractionB;
      try {
        [extractionA, extractionB] = await Promise.all([
          extractAnswer(input.question, docA.text, input.top_k ?? 2),
          extractAnswer(input.question, docB.text, input.top_k ?? 2),
        ]);
      } catch (err) {
        log.warn({ err }, 'Isaacus extractAnswer failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'extraction_failed',
            message: 'Could not extract answers from one or both judgments.',
            detail: err instanceof Error ? err.message : String(err),
          }) }],
          isError: true,
        };
      }

      const panelA = buildPanel(resolvedA, docA, extractionA);
      const panelB = buildPanel(resolvedB, docB, extractionB);
      const totalTokens = extractionA.tokensUsed + extractionB.tokensUsed;

      const queryText = `${input.citation_or_url_a} vs ${input.citation_or_url_b}: ${input.question}`;
      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'compare_cases',
        query_text: queryText.slice(0, 300),
        result_count: 2,
        top_results: [
          { title: panelA.title, citation: panelA.citation, url: panelA.url },
          { title: panelB.title, citation: panelB.citation, url: panelB.url },
        ],
        api_tokens_used: totalTokens,
      });

      // ── 4. Build comparison note ────────────────────────────────────────────
      let agreement_note: string;
      if (!panelA.answer_found && !panelB.answer_found) {
        agreement_note = 'Neither case contained an extractable answer to this question.';
      } else if (!panelA.answer_found) {
        agreement_note = `Answer found only in ${panelB.title}. The first case may address this issue differently — try rephrasing the question.`;
      } else if (!panelB.answer_found) {
        agreement_note = `Answer found only in ${panelA.title}. The second case may address this issue differently — try rephrasing the question.`;
      } else {
        agreement_note = 'Both cases contain extractable answers. Review the texts to compare the courts\' approaches.';
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          question: input.question,
          case_a: panelA,
          case_b: panelB,
          agreement_note,
        }, null, 2) }],
      };
    },
  );
}
