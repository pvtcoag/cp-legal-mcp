import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
      { message: 'Only AustLII URLs are supported (https://www.austlii.edu.au/...)' }
    )
    .describe(
      'AustLII URL of the legislation to query, e.g. "https://www.austlii.edu.au/au/legis/cth/consol_act/cca2010265/". ' +
      'Obtain this from research_legislation first.',
    ),
  question: z
    .string()
    .min(5)
    .max(500)
    .describe(
      'The specific question to answer from the legislation, e.g. "What are the elements of misleading or deceptive conduct?" ' +
      'or "What penalties apply under section 45?" or "How is \'consumer\' defined?"',
    ),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe('Maximum number of answer candidates to return'),
  section: z
    .string()
    .optional()
    .describe(
      'Optional: fetch only this section of the Act before answering, e.g. "18", "s 18A", "schedule 1". ' +
      'Much cheaper and more accurate than sending the full Act text. Recommended when you know the relevant provision.'
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Matter reference to tag this query in the research log. If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.',
    ),
});

export function registerAskLegislation(server: McpServer): void {
  server.tool(
    'ask_legislation',
    'Extract a direct answer to a specific question from an Australian Act or regulation. Accepts an AustLII legislation URL (from research_legislation) and returns exact text spans with confidence scores. Ideal for locating definitions, offence elements, penalty provisions, procedural requirements, or the scope of a specific section without reading the entire Act.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'ask_legislation', url: input.url });

      // If a section is specified, fetch just that section instead of the full Act
      let doc;
      if (input.section) {
        try {
          const sectionDoc = await fetchLegislationSection({ url: input.url, section: input.section });
          doc = { text: sectionDoc.text, title: `${sectionDoc.act_url} ${input.section}`, url: sectionDoc.section_url };
        } catch (err) {
          if (err instanceof AuslawError) {
            log.warn({ err }, 'fetch_legislation_section failed, falling back to full Act');
            // Fall through to full-Act fetch below
          } else {
            throw err;
          }
        }
      }
      if (!doc) {
        // Original full-Act fetch
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

      const filteredText = extractRelevantPassages(doc.text, input.question, 24_000);

      let extraction;
      try {
        extraction = await extractAnswer(input.question, filteredText, input.top_k ?? 3);
      } catch (err) {
        log.warn({ err }, 'Isaacus extractAnswer failed');
        recordMatterError({ matter_ref: input.matter_ref, tool_name: 'ask_legislation', query_text: input.question, error_message: 'extraction_failed' });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'extraction_failed',
            message: 'Could not extract an answer. Please use get_legislation to read the full text instead.',
            detail: err instanceof Error ? err.message : String(err),
          }) }],
          isError: true,
        };
      }

      const title = doc.title ?? input.url;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'ask_legislation',
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
              'Try rephrasing the question, or use get_legislation to read the full text.',
            inextractability_score: extraction.inextractability_score,
          }) }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          legislation: { title, url: input.url },
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
