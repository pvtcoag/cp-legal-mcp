import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchDocumentText, validateCitation, AuslawError } from '../auslaw-client.js';
import { logger } from '../logger.js';

// Neutral citation: [2024] HCA 12, [2023] FCAFC 45, etc.
const NEUTRAL_CITATION_RE = /^\[\d{4}\]\s+[A-Z]+\s+\d+$/i;
const URL_RE = /^https?:\/\//;

const inputSchema = z.object({
  citation_or_url: z
    .string()
    .min(5)
    .describe(
      'Neutral citation (e.g. "[2024] HCA 12") or a full AustLII URL of the judgment to retrieve',
    ),
});

export function registerGetJudgment(server: McpServer): void {
  server.tool(
    'get_judgment',
    'Retrieve the full text of an Australian court judgment by neutral citation or AustLII URL. Validates citations and returns structured text with metadata.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'get_judgment', input: input.citation_or_url });
      const value = input.citation_or_url.trim();

      let resolvedUrl: string;
      let canonicalUrl: string | undefined;
      const isCitation = NEUTRAL_CITATION_RE.test(value);

      if (URL_RE.test(value)) {
        resolvedUrl = value;
      } else if (isCitation) {
        let validation;
        try {
          validation = await validateCitation(value);
        } catch (err) {
          if (err instanceof AuslawError) {
            log.warn({ err }, 'AusLaw validate_citation failed');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'upstream_unavailable',
                    message: 'Could not validate the citation. The legal database may be temporarily unavailable.',
                  }),
                },
              ],
              isError: true,
            };
          }
          throw err;
        }

        if (!validation.valid || !validation.url) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'citation_not_found',
                  message: `Citation "${value}" could not be found on AustLII.`,
                  citation: value,
                }),
              },
            ],
            isError: true,
          };
        }

        resolvedUrl = validation.url;
        canonicalUrl = validation.canonical;
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'invalid_input',
                message:
                  'Provide a neutral citation like "[2024] HCA 12" or a full AustLII URL.',
                received: value,
              }),
            },
          ],
          isError: true,
        };
      }

      log.debug({ resolvedUrl }, 'fetching document');

      let doc;
      try {
        doc = await fetchDocumentText(resolvedUrl);
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'AusLaw fetch_document_text failed');
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'upstream_unavailable',
                  message:
                    'Could not retrieve the judgment. The legal database may be temporarily unavailable.',
                }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                title: doc.title,
                citation: doc.citation ?? (isCitation ? value : undefined),
                url: resolvedUrl,
                canonical_url: canonicalUrl ?? resolvedUrl,
                char_count: doc.text.length,
                text: doc.text,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
