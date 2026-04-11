import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  generatePinpoint,
  resolveJudgmentUrl,
  AuslawError,
  isJadeExpiry,
  JADE_EXPIRY_NOTICE,
} from '../auslaw-client.js';
import { logger } from '../logger.js';

const inputSchema = z.object({
  citation_or_url: z
    .string()
    .min(5)
    .describe('Neutral citation (e.g. "[2024] HCA 12") or full AustLII URL of the judgment'),
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
    .describe('Phrase to search for within the judgment paragraphs (alternative to paragraph_number)'),
});

export function registerGeneratePinpoint(server: McpServer): void {
  server.tool(
    'generate_pinpoint',
    'Generate an AGLC4-compliant pinpoint reference to a specific paragraph in an Australian judgment. Accepts a neutral citation or AustLII URL, plus a paragraph number or search phrase. Use this when citing a particular passage rather than the case generally.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({
        tool: 'generate_pinpoint',
        input: input.citation_or_url,
      });

      if (input.paragraph_number === undefined && !input.phrase) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'invalid_input',
            message: 'Provide at least one of paragraph_number or phrase.',
          }) }],
          isError: true,
        };
      }

      // Resolve citation or URL → concrete AustLII URL
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

      try {
        const result = await generatePinpoint({
          url: resolved.url,
          paragraphNumber: input.paragraph_number,
          phrase: input.phrase,
          caseCitation: resolved.citation,
        });
        log.debug('AusLaw generate_pinpoint succeeded');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  citation: resolved.citation ?? input.citation_or_url,
                  url: resolved.url,
                  paragraph_number: result.paragraphNumber ?? input.paragraph_number,
                  pinpoint: result.pinpointString,
                  full_citation: result.fullCitation,
                  ...(result.paragraphText ? { paragraph_text: result.paragraphText } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        if (err instanceof AuslawError) {
          const jadeExpired = isJadeExpiry(err);
          if (jadeExpired) logger.warn({ err }, 'JADE session cookie may have expired');
          else log.warn({ err }, 'AusLaw generate_pinpoint failed');
          const baseMessage = jadeExpired
            ? 'Could not retrieve the judgment — the JADE session appears to have expired.'
            : 'Could not generate pinpoint reference. The legal database may be temporarily unavailable.';
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: jadeExpired ? 'jade_session_expired' : 'upstream_unavailable',
                  message: baseMessage + (jadeExpired ? JADE_EXPIRY_NOTICE : ''),
                  detail: err.message,
                }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}
