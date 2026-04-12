import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { enrichDocument, extractAnswer } from '../isaacus-client.js';
import { extractRelevantPassages, truncateText } from '../text-utils.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  text: z
    .string()
    .min(50)
    .max(500_000)
    .describe('Document text to extract a chronology from (judgment, statement of facts, email chain, etc.)'),
  title: z
    .string()
    .max(200)
    .optional()
    .describe('Optional title or description of the document (used in output labelling)'),
  format: z
    .enum(['compact', 'detailed'])
    .default('compact')
    .describe(
      'compact: date + event type + description. ' +
      'detailed: adds confidence scores and source text extracts.',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this extraction in the research log.'),
});

interface ChronologyEntry {
  date: string | null;
  type: string;
  description: string;
  confidence?: number;
  source_text?: string;
}

/** Parse ISO or common date strings to YYYY-MM-DD for sorting. Returns null if unparseable. */
function parseDate(value: string): string | null {
  // Already ISO-like
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  // Try JS Date parse
  const d = new Date(value);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  // Year only
  if (/^\d{4}$/.test(value.trim())) return `${value.trim()}-01-01`;
  return null;
}

function sortChronology(entries: ChronologyEntry[]): ChronologyEntry[] {
  const dated = entries.filter((e) => e.date !== null);
  const undated = entries.filter((e) => e.date === null);
  dated.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
  return [...dated, ...undated];
}

export function registerBuildChronology(server: McpServer): void {
  server.tool(
    'build_chronology',
    '[Matter] Extract and sort dates and events from a legal document or text to build a chronological timeline. Uses Isaacus Kanon 2 Enricher for structured date extraction. Useful for building matter chronologies, summarising procedural histories, and organising evidence timelines.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'build_chronology' });
      let totalTokens = 0;

      const enrichText = truncateText(input.text, 50_000);
      const qaText = extractRelevantPassages(
        input.text,
        'date event occurred when hearing decision order filed served commenced',
        24_000,
      );

      const entries: ChronologyEntry[] = [];

      // Run enrichment and QA in parallel
      const [enrichResult, qaResult] = await Promise.allSettled([
        enrichDocument(enrichText),
        extractAnswer(
          'What events occurred and on what dates? List each event and its date.',
          qaText,
          10,
        ),
      ]);

      // Process enrichment results
      if (enrichResult.status === 'fulfilled') {
        totalTokens += enrichResult.value.tokensUsed;
        for (const kd of enrichResult.value.data.key_dates) {
          const date = parseDate(kd.value);
          entries.push({
            date,
            type: kd.type,
            description: `${kd.type}: ${kd.value}`,
            ...(input.format === 'detailed' ? { confidence: 0.85 } : {}),
          });
        }
      } else {
        log.warn({ err: enrichResult.reason }, 'enrichDocument failed in build_chronology');
      }

      // Process QA results — extract date + event pairs from answers
      if (qaResult.status === 'fulfilled') {
        totalTokens += qaResult.value.tokensUsed;
        for (const answer of qaResult.value.answers) {
          if (answer.score < 0.3) continue; // skip low-confidence answers
          // Try to detect a date in the answer text
          const dateMatch = answer.text.match(
            /(\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|\d{4})/i,
          );
          const date = dateMatch ? parseDate(dateMatch[1]!) : null;
          const description = answer.text.slice(0, 300).trim();

          // Deduplicate by description prefix
          const alreadyExists = entries.some(
            (e) =>
              e.description.slice(0, 50).toLowerCase() === description.slice(0, 50).toLowerCase(),
          );
          if (!alreadyExists && description.length > 10) {
            entries.push({
              date,
              type: 'event',
              description,
              ...(input.format === 'detailed'
                ? { confidence: Math.round(answer.score * 1000) / 1000, source_text: answer.text }
                : {}),
            });
          }
        }
      } else {
        log.warn({ err: qaResult.reason }, 'extractAnswer failed in build_chronology');
      }

      const sorted = sortChronology(entries);

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'build_chronology',
        query_text: input.title ?? input.text.slice(0, 100),
        result_count: sorted.length,
        top_results: [],
        api_tokens_used: totalTokens,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ...(input.title ? { title: input.title } : {}),
          event_count: sorted.length,
          chronology: sorted,
          note:
            'Dates extracted via Isaacus Kanon 2 Enricher and extractive QA. ' +
            'Review and supplement with primary sources.',
          ...(entries.length === 0
            ? { warning: 'No dates could be extracted. The document may lack explicit date references.' }
            : {}),
        }) }],
      };
    },
  );
}
