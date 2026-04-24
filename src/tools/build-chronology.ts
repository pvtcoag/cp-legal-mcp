import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, matterRefSchema } from './_shared.js';
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
  matter_ref: matterRefSchema,
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
  const trimmed = value.trim();
  // Already ISO-like
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  // DD/MM/YYYY or DD-MM-YYYY (Australian format — day first).
  // JS Date() parses these as MM/DD/YYYY, so handle explicitly before falling back.
  const dmy = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    const d = parseInt(dd!, 10);
    const m = parseInt(mm!, 10);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return `${yyyy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  // "21 April 2024" / "21 Apr 2024" / "April 21, 2024"
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  // Year only
  if (/^\d{4}$/.test(trimmed)) return `${trimmed}-01-01`;
  return null;
}

// Dates as they commonly appear in Australian judgments and contracts. Matches:
//   - "21 April 2024", "21 Apr 2024", "April 21 2024"
//   - "21/4/2024", "21-04-2024", "21.4.2024" (Australian day-first)
//   - "2024-04-21" (ISO)
// We deliberately do NOT match bare years — too noisy in legal prose where
// ``s 52 of the Trade Practices Act 1974`` would yield a spurious 1974-01-01.
const DATE_REGEX_GLOBAL = new RegExp(
  [
    '\\b\\d{1,2}\\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+\\d{4}\\b',
    '\\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+\\d{4}\\b',
    '\\b\\d{1,2}[/\\-.]\\d{1,2}[/\\-.]\\d{4}\\b',
    '\\b\\d{4}-\\d{2}-\\d{2}\\b',
  ].join('|'),
  'gi',
);

function sortChronology(entries: ChronologyEntry[]): ChronologyEntry[] {
  const dated = entries.filter((e) => e.date !== null);
  const undated = entries.filter((e) => e.date === null);
  dated.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
  return [...dated, ...undated];
}

export function registerBuildChronology(server: McpServer): void {
  registerTool(
    server,
    'build_chronology',
    {
      title: 'Build chronology',
      description: '[Matter] Extract and sort dates and events from a legal document or text to build a chronological timeline. Uses Isaacus Kanon 2 Enricher for structured date extraction. Useful for building matter chronologies, summarising procedural histories, and organising evidence timelines.',
      inputSchema: inputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
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

      // Process enrichment results.
      // Note: Kanon 2 Enricher's `dates` field is contract-oriented — it only
      // emits dates tagged as creation/signature/effective/expiry/delivery/
      // renewal/payment/birth/death. For judgments (hearings, orders, filings)
      // the enricher will typically return zero dates, and we rely on the QA
      // path plus the regex fallback below.
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

      // Process QA results — extract date + event pairs from answers.
      // Threshold lowered from 0.3 to 0.15: date-related QA answers often score
      // below 0.3 even when correct, because the model isn't highly confident
      // in a single paragraph being *the* answer to a multi-event question.
      if (qaResult.status === 'fulfilled') {
        totalTokens += qaResult.value.tokensUsed;
        for (const answer of qaResult.value.answers) {
          if (answer.score < 0.15) continue;
          const dateMatches = answer.text.match(DATE_REGEX_GLOBAL);
          const date = dateMatches?.[0] ? parseDate(dateMatches[0]) : null;
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

      // Regex fallback — when both Isaacus paths returned no dated entries,
      // sweep the raw document for date-shaped strings and surface the
      // surrounding sentence. This ensures build_chronology is useful even when
      // the enricher's contract-centric date types miss everything and QA is
      // noisy. Only runs when we have zero dated entries from Isaacus, so we
      // never paper over genuine model output.
      const datedCount = entries.filter((e) => e.date !== null).length;
      if (datedCount === 0) {
        const text = input.text;
        const seen = new Set<string>();
        let m: RegExpExecArray | null;
        const re = new RegExp(DATE_REGEX_GLOBAL.source, 'gi');
        while ((m = re.exec(text)) !== null) {
          const rawDate = m[0];
          const date = parseDate(rawDate);
          if (!date) continue;
          // Capture the surrounding sentence (±120 chars, clipped at terminators)
          const start = Math.max(0, m.index - 120);
          const end = Math.min(text.length, m.index + rawDate.length + 120);
          const window = text.slice(start, end).replace(/\s+/g, ' ').trim();
          const sentence = window.split(/(?<=[.!?])\s+/).find((s: string) => s.includes(rawDate)) ?? window;
          const description = sentence.slice(0, 300).trim();
          const dedupKey = `${date}|${description.slice(0, 50).toLowerCase()}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          entries.push({
            date,
            type: 'event',
            description,
            ...(input.format === 'detailed' ? { confidence: 0.5, source_text: sentence } : {}),
          });
          if (entries.length > 60) break; // cap fallback entries — caller can narrow via a shorter `text`
        }
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
            'Dates extracted via Isaacus Kanon 2 Enricher, extractive QA, and ' +
            'regex date-sweep fallback. Kanon 2 Enricher targets contract-style ' +
            'date types (creation/signature/effective/expiry/delivery/renewal/' +
            'payment/birth/death) — for judgments, most dates come from the ' +
            'QA and fallback paths. Review and supplement with primary sources.',
          ...(entries.length === 0
            ? { warning: 'No dates could be extracted. The document may lack explicit date references.' }
            : {}),
        }) }],
      };
    },
  );
}
