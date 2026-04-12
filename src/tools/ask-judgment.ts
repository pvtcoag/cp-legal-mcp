import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  fetchDocumentText,
  resolveJudgmentUrl,
  AuslawError,
} from '../auslaw-client.js';
import { extractAnswer } from '../isaacus-client.js';
import { extractRelevantPassages } from '../text-utils.js';
import { logger } from '../logger.js';
import { recordMatterQuery, recordMatterError } from '../matter-log.js';

const inputSchema = z.object({
  citation_or_url: z
    .string()
    .min(5)
    .describe('Neutral citation (e.g. "[2024] HCA 12") or full AustLII URL of the judgment'),
  question: z
    .string()
    .min(5)
    .max(500)
    .describe(
      'The specific question to answer from the judgment, e.g. "What was the court\'s reasoning on contributory negligence?" or "What damages were awarded?"',
    ),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe('Maximum number of answer candidates to return'),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this query in the research log. If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.'),
});

export function registerAskJudgment(server: McpServer): void {
  server.tool(
    'ask_judgment',
    '[Judgment Analysis] Extract a direct answer to a specific question from an Australian court judgment. Uses Isaacus Kanon Answer Extractor — faster and more precise than reading the full text. Ideal for targeted questions like reasoning on a specific issue, damages awarded, or how a legal principle was applied. Returns exact text spans with confidence scores.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'ask_judgment', input: input.citation_or_url });

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

      // Pre-filter document to relevant passages before sending to Kanon (reduces token cost ~50–70%)
      const filteredText = extractRelevantPassages(doc.text, input.question, 24_000);

      // Extract answers using Isaacus
      let extraction;
      try {
        extraction = await extractAnswer(input.question, filteredText, input.top_k ?? 3);
      } catch (err) {
        log.warn({ err }, 'Isaacus extractAnswer failed');
        recordMatterError({ matter_ref: input.matter_ref, tool_name: 'ask_judgment', query_text: input.question, error_message: 'extraction_failed' });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'extraction_failed',
            message: 'Could not extract an answer. Please use get_judgment to read the full text instead.',
            detail: err instanceof Error ? err.message : String(err),
          }) }],
          isError: true,
        };
      }

      const citation = doc.citation ?? resolved.citation;
      const title = doc.title ?? citation ?? input.citation_or_url;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'ask_judgment',
        query_text: input.question,
        result_count: extraction.answers.length,
        top_results: [{ title, citation, url: resolved.url }],
        api_tokens_used: extraction.tokensUsed,
        accuracy_score: extraction.answers[0]?.score,
      });

      if (extraction.inextractable || extraction.answers.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            judgment: { title, citation, url: resolved.url },
            question: input.question,
            answer_found: false,
            message:
              'The answer to this question does not appear to be present in the judgment text. ' +
              'Try rephrasing the question, or use get_judgment to read the full text.',
            inextractability_score: extraction.inextractability_score,
          }) }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          judgment: { title, citation, url: resolved.url },
          question: input.question,
          answer_found: true,
          answers: extraction.answers.map((a) => ({
            text: a.text,
            confidence: Math.round(a.score * 1000) / 1000,
            char_range: [a.start, a.end],
          })),
        }) }],
      };
    },
  );
}
