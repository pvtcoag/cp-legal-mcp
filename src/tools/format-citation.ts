import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './_shared.js';
import {
  formatCitation,
  generatePinpoint,
  resolveJudgmentUrl,
  AuslawError,
} from '../auslaw-client.js';
import { logger } from '../logger.js';

const inputSchema = z.object({
  // ── Citation formatting ────────────────────────────────────────────────────
  title: z
    .string()
    .min(1)
    .optional()
    .describe("Case name for citation formatting, e.g. 'Mabo v Queensland (No 2)'"),
  neutral_citation: z
    .string()
    .optional()
    .describe("Neutral citation component, e.g. '[1992] HCA 23'"),
  reported_citation: z
    .string()
    .optional()
    .describe("Reported citation component, e.g. '(1992) 175 CLR 1'"),
  style: z
    .enum(['neutral', 'reported', 'combined'])
    .default('combined')
    .describe('Citation style: neutral (neutral only), reported (reported only), combined (both)'),
  pinpoint: z
    .string()
    .optional()
    .describe("Manual pinpoint string to include in the formatted citation, e.g. '[20]' or 'p 42'"),

  // ── Pinpoint generation ───────────────────────────────────────────────────
  citation_or_url: z
    .string()
    .min(5)
    .optional()
    .describe(
      'Neutral citation (e.g. "[2024] HCA 12") or AustLII URL to generate a pinpoint reference for. ' +
      'Supply this together with paragraph_number or phrase to generate a full pinpoint citation.',
    ),
  paragraph_number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Paragraph number within the judgment to create a pinpoint reference to'),
  phrase: z
    .string()
    .min(1)
    .optional()
    .describe('Phrase to search for within the judgment (alternative to paragraph_number)'),
});

// ── Output schema ──────────────────────────────────────────────────────────────
const outputSchemaShape = {
  error: z.string().optional(),
  message: z.string().optional(),
  detail: z.string().optional(),
  received: z.string().optional(),

  mode: z.string().optional(),

  // Pinpoint mode
  citation: z.string().optional(),
  url: z.string().optional(),
  paragraph_number: z.number().optional(),
  pinpoint: z.string().optional(),
  full_citation: z.string().optional(),
  paragraph_text: z.string().optional(),

  // Format mode
  title: z.string().optional(),
  formatted: z.string().optional(),
  style: z.string().optional(),
};

export function registerFormatCitation(server: McpServer): void {
  registerTool(
    server,
    'format_citation',
    {
      title: 'Format citation',
      description: '[Citation] Format an Australian case citation per AGLC4, or generate a pinpoint reference to a specific paragraph. ' +
    'Two modes: (1) Citation formatting — provide title + neutral/reported citation components → returns correctly formatted AGLC4 string. ' +
    '(2) Pinpoint generation — provide citation_or_url + paragraph_number or phrase → resolves the judgment and returns a full pinpoint citation. ' +
    'Use mode 1 when you have the citation components and need to format them; use mode 2 when you need to cite a specific paragraph.',
      inputSchema: inputSchema.shape,
      outputSchema: outputSchemaShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const log = logger.child({ tool: 'format_citation' });

      // ── Mode 2: pinpoint generation ──────────────────────────────────────
      if (input.citation_or_url) {
        if (input.paragraph_number === undefined && !input.phrase) {
          const obj = {
            error: 'invalid_input',
            message: 'Provide at least one of paragraph_number or phrase when using citation_or_url.',
          };
          return {
            structuredContent: obj,
            content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
            isError: true,
          };
        }

        let resolved;
        try {
          resolved = await resolveJudgmentUrl(input.citation_or_url);
        } catch (err) {
          if (err instanceof AuslawError) {
            log.warn({ err }, 'resolveJudgmentUrl failed');
            const obj = {
              error: 'invalid_input',
              message: err.message,
              received: input.citation_or_url,
            };
            return {
              structuredContent: obj,
              content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
              isError: true,
            };
          }
          throw err;
        }

        try {
          const result = await generatePinpoint({
            url: resolved.url,
            paragraphNumber: input.paragraph_number,
            phrase: input.phrase,
            caseCitation: resolved.citation,
          });
          log.debug('generate_pinpoint succeeded');

          const obj = {
            mode: 'pinpoint',
            citation: resolved.citation ?? input.citation_or_url,
            url: resolved.url,
            paragraph_number: result.paragraphNumber ?? input.paragraph_number,
            pinpoint: result.pinpointString,
            full_citation: result.fullCitation,
            ...(result.paragraphText ? { paragraph_text: result.paragraphText } : {}),
          };
          return {
            structuredContent: obj,
            content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
          };
        } catch (err) {
          if (err instanceof AuslawError) {
            log.warn({ err }, 'generatePinpoint failed');
            const obj = {
              error: 'upstream_unavailable',
              message: 'Could not retrieve the judgment. The legal database may be temporarily unavailable.',
              detail: err.message,
            };
            return {
              structuredContent: obj,
              content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
              isError: true,
            };
          }
          throw err;
        }
      }

      // ── Mode 1: citation formatting ───────────────────────────────────────
      if (!input.title) {
        const obj = {
          error: 'invalid_input',
          message:
            'Provide title (+ neutral/reported citation components) for citation formatting, ' +
            'or citation_or_url (+ paragraph_number or phrase) for pinpoint generation.',
        };
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
          isError: true,
        };
      }

      try {
        const result = await formatCitation({
          title: input.title,
          neutralCitation: input.neutral_citation,
          reportedCitation: input.reported_citation,
          pinpoint: input.pinpoint,
          style: input.style,
        });
        log.debug('format_citation succeeded');

        const obj = {
          mode: 'format',
          title: input.title,
          formatted: result.formatted,
          style: result.style ?? input.style,
        };
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
        };
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'formatCitation failed');
          const obj = {
            error: 'upstream_unavailable',
            message: 'Could not format citation. The legal database may be temporarily unavailable.',
            detail: err.message,
          };
          return {
            structuredContent: obj,
            content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}
