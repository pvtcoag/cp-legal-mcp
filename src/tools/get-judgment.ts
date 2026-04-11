import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchDocumentText, validateCitation, AuslawError, isJadeExpiry, JADE_EXPIRY_NOTICE } from '../auslaw-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery, validateMatterRef } from '../matter-log.js';

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
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Optional matter reference to tag this retrieval for later review.'),
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
          const jadeExpired = isJadeExpiry(err);
          if (jadeExpired) {
            logger.warn({ err }, 'JADE session cookie may have expired');
          } else {
            log.warn({ err }, 'AusLaw fetch_document_text failed');
          }
          const baseMessage = jadeExpired
            ? 'Could not retrieve the judgment — the JADE session appears to have expired.'
            : 'Could not retrieve the judgment. The legal database may be temporarily unavailable.';
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: jadeExpired ? 'jade_session_expired' : 'upstream_unavailable',
                  message: baseMessage + (jadeExpired ? JADE_EXPIRY_NOTICE : ''),
                }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }

      const citation = doc.citation ?? (isCitation ? value : undefined);

      if (input.matter_ref && validateMatterRef(input.matter_ref)) {
        recordMatterQuery({
          matter_ref: input.matter_ref,
          tool_name: 'get_judgment',
          query_text: value,
          result_count: 1,
          top_results: [{ title: doc.title ?? value, citation, url: resolvedUrl }],
        });
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                title: doc.title,
                citation,
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
