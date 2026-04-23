import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, matterRefSchema } from './_shared.js';
import { fetchDocumentText, fetchLegislationSection, AuslawError } from '../auslaw-client.js';
import { extractAnswer } from '../isaacus-client.js';
import { extractRelevantPassages } from '../text-utils.js';
import { logger } from '../logger.js';
import { recordMatterQuery, recordMatterError } from '../matter-log.js';

const inputSchema = z.object({
  url: z
    .string()
    .url()
    .refine(
      (v) => v.startsWith('https://www.austlii.edu.au') || v.startsWith('https://classic.austlii.edu.au'),
      { message: 'Only AustLII URLs are supported (https://www.austlii.edu.au/...)' },
    )
    .describe(
      'AustLII URL of the Act or regulation, e.g. "https://www.austlii.edu.au/au/legis/cth/consol_act/cca2010265/". ' +
      'Obtain this from research_legislation first.',
    ),
  question: z
    .string()
    .min(5)
    .max(500)
    .optional()
    .describe(
      'Specific question to answer from the legislation, e.g. "What are the elements of misleading or deceptive conduct?" ' +
      'or "What penalties apply under section 45?" or "How is \'consumer\' defined?". ' +
      'Omit to retrieve the full text of the Act.',
    ),
  section: z
    .string()
    .optional()
    .describe(
      'Fetch only this section before answering, e.g. "18", "s 18A", "schedule 1". ' +
      'Cheaper and more accurate than sending the full Act. Only applies when question is provided.',
    ),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe('Maximum number of answer candidates to return (only applies when question is provided)'),
  matter_ref: matterRefSchema,
});

export function registerGetLegislation(server: McpServer): void {
  registerTool(
    server,
    'get_legislation',
    {
      title: 'Get legislation',
      description: '[Legislation] Retrieve an Australian Act or regulation from AustLII. Two modes: ' +
    '(1) Full text — omit question to return the complete consolidated text. ' +
    '(2) Targeted QA — provide a question to extract a direct answer from the legislation using Isaacus extractive QA; optionally narrow to a specific section for cheaper, faster results. ' +
    'Use research_legislation to find the URL first.',
      inputSchema: inputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const log = logger.child({ tool: 'get_legislation', url: input.url });

      // ── Fetch document (section or full Act) ──────────────────────────────
      let doc: { text: string; title?: string | null; url?: string };

      if (input.question && input.section) {
        // Section fetch — cheaper for targeted QA
        try {
          const sectionDoc = await fetchLegislationSection({ url: input.url, section: input.section });
          doc = { text: sectionDoc.text, title: `${input.url} s ${input.section}`, url: sectionDoc.section_url };
        } catch (err) {
          if (err instanceof AuslawError) {
            log.warn({ err }, 'fetch_legislation_section failed — falling back to full Act');
            // Fall through to full fetch
          } else {
            throw err;
          }
        }
      }

      if (!doc!) {
        try {
          doc = await fetchDocumentText(input.url);
        } catch (err) {
          if (err instanceof AuslawError) {
            log.warn({ err }, 'fetch_document_text failed');
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                error: 'upstream_unavailable',
                message: 'Could not retrieve the legislation. The legal database may be temporarily unavailable.',
                detail: err.message,
              }) }],
              isError: true,
            };
          }
          throw err;
        }
      }

      const title = doc.title ?? input.url;

      // ── Mode 2: targeted QA ───────────────────────────────────────────────
      if (input.question) {
        const filteredText = extractRelevantPassages(doc.text, input.question, 24_000);

        let extraction;
        try {
          extraction = await extractAnswer(input.question, filteredText, input.top_k ?? 3);
        } catch (err) {
          log.warn({ err }, 'extractAnswer failed');
          recordMatterError({
            matter_ref: input.matter_ref,
            tool_name: 'get_legislation',
            query_text: input.question,
            error_message: 'extraction_failed',
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'extraction_failed',
              message: 'Could not extract an answer. Omit the question to retrieve the full text instead.',
              detail: err instanceof Error ? err.message : String(err),
            }) }],
            isError: true,
          };
        }

        recordMatterQuery({
          matter_ref: input.matter_ref,
          tool_name: 'get_legislation',
          query_text: input.question,
          result_count: extraction.answers.length,
          top_results: [{ title, url: input.url }],
          api_tokens_used: extraction.tokensUsed,
          accuracy_score: extraction.answers[0]?.score,
        });

        if (extraction.inextractable || extraction.answers.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              legislation: { title, url: input.url },
              question: input.question,
              answer_found: false,
              message:
                'The answer to this question does not appear to be present in this legislation. ' +
                'Try rephrasing, narrowing to a specific section, or omit question to read the full text.',
              inextractability_score: extraction.inextractability_score,
            }) }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            legislation: { title, url: input.url },
            question: input.question,
            ...(input.section ? { section: input.section } : {}),
            answer_found: true,
            answers: extraction.answers.map((a) => ({
              text: a.text,
              confidence: Math.round(a.score * 1000) / 1000,
              char_range: [a.start, a.end],
            })),
          }) }],
        };
      }

      // ── Mode 1: full text ─────────────────────────────────────────────────
      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'get_legislation',
        query_text: input.url,
        result_count: 1,
        top_results: [{ title, url: input.url }],
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          title,
          url: input.url,
          char_count: doc.text.length,
          text: doc.text,
        }) }],
      };
    },
  );
}
