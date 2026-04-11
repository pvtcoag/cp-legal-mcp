import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generatePinpoint, AuslawError } from '../auslaw-client.js';
import { logger } from '../logger.js';

const inputSchema = z.object({
  citation: z
    .string()
    .min(5)
    .describe('Neutral citation of the case, e.g. "[2024] HCA 12"'),
  paragraph: z
    .number()
    .int()
    .min(1)
    .describe('Paragraph number within the judgment to create a pinpoint reference to'),
});

export function registerGeneratePinpoint(server: McpServer): void {
  server.tool(
    'generate_pinpoint',
    'Generate an AGLC4-compliant pinpoint reference to a specific paragraph in an Australian judgment. Use this when citing a particular passage rather than the case generally.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({
        tool: 'generate_pinpoint',
        citation: input.citation,
        paragraph: input.paragraph,
      });

      try {
        const result = await generatePinpoint({
          citation: input.citation,
          paragraph: input.paragraph,
        });
        log.debug('AusLaw generate_pinpoint succeeded');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  citation: input.citation,
                  paragraph: input.paragraph,
                  pinpoint: result.pinpoint,
                  ...(result.full ? { full_citation: result.full } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'AusLaw generate_pinpoint failed');
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'upstream_unavailable',
                  message: 'Could not generate pinpoint reference. The legal database may be temporarily unavailable.',
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
