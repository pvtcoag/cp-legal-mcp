import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { externalFetch, ExternalApiError } from '../external-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const ASIC_CONNECT_BASE = 'https://connectonline.asic.gov.au/RegistrySearch/faces/landing';
const ASIC_MANUAL_URL = `${ASIC_CONNECT_BASE}/SearchRegisters.jspx`;

const inputSchemaBase = z.object({
  acn: z
    .string()
    .optional()
    .describe('9-digit ACN of the company (preferred — more precise than name search)'),
  company_name: z
    .string()
    .min(2)
    .optional()
    .describe('Company name to search for (used if ACN is not known)'),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this lookup in the research log.'),
});

const inputSchema = inputSchemaBase.refine((d) => d.acn || d.company_name, {
  message: 'Either acn or company_name must be provided',
});

interface Officeholder {
  name: string;
  role: string | null;
  appointed: string | null;
  ceased?: string | null;
}

function parseOfficeholders(html: string): {
  company_name: string | null;
  current: Officeholder[];
  former: Officeholder[];
} {
  let company_name: string | null = null;

  // Try to extract company name from page title or heading
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (titleMatch) {
    company_name = titleMatch[1]!
      .replace(/<[^>]+>/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || null;
  }

  const current: Officeholder[] = [];
  const former: Officeholder[] = [];

  // Look for officeholder sections
  // ASIC Connect renders officeholders in table rows under "Current" and "Former" sections
  const sections = html.split(/<h[23][^>]*>/i);

  for (const section of sections) {
    const isFormer = /former|ceased|previous/i.test(section.slice(0, 100));
    const isCurrent = /current|present/i.test(section.slice(0, 100));

    // Extract rows with officeholder data
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowPattern.exec(section)) !== null) {
      const cells = rowMatch[1]!
        .match(/<td[^>]*>([\s\S]*?)<\/td>/gi)
        ?.map((cell) =>
          cell
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim(),
        )
        .filter(Boolean) ?? [];

      if (cells.length >= 2) {
        const name = cells[0] ?? '';
        if (!name || /^(name|officer|director)/i.test(name)) continue;

        const officeholder: Officeholder = {
          name,
          role: cells[1] ?? null,
          appointed: cells[2] ?? null,
          ceased: cells[3] ?? null,
        };

        if (isFormer || (officeholder.ceased && officeholder.ceased !== '')) {
          former.push(officeholder);
        } else if (isCurrent || !officeholder.ceased) {
          current.push(officeholder);
        } else {
          current.push(officeholder);
        }
      }
    }
  }

  return { company_name, current, former };
}

export function registerGetDirectorHistory(server: McpServer): void {
  server.tool(
    'get_director_history',
    'Retrieve current and former directors and officeholders for an Australian company from the ASIC Connect public register. Accepts ACN (preferred) or company name. Use for due diligence, conflicts checking, and identifying related parties. Best-effort public scrape of the ASIC Connect register.',
    inputSchemaBase.shape,
    async (input) => {
      const log = logger.child({ tool: 'get_director_history' });

      let acn = input.acn ? input.acn.replace(/\s/g, '') : null;

      // If no ACN, first do a name search to find it
      if (!acn && input.company_name) {
        try {
          const searchUrl = `${ASIC_CONNECT_BASE}/panelSearchResult.jspx?action=googleSearch&searchText=${encodeURIComponent(input.company_name)}&searchType=OrgAndBus&pResultsPerPage=5`;
          const searchRes = await externalFetch(searchUrl, {
            headers: { Accept: 'text/html,application/xhtml+xml', Referer: ASIC_MANUAL_URL },
          });
          if (searchRes.ok) {
            const searchHtml = await searchRes.text();
            // Extract first ACN from results
            const acnMatch = searchHtml.match(/(\d{3}\s?\d{3}\s?\d{3})/);
            if (acnMatch) {
              acn = acnMatch[1]!.replace(/\s/g, '');
            }
          }
        } catch (err) {
          log.warn({ err }, 'ASIC name search failed during ACN lookup');
        }
      }

      if (!acn) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'not_found',
            message: input.company_name
              ? `Could not find ACN for "${input.company_name}" in ASIC Connect.`
              : 'No ACN provided and no company name to search.',
            manual_url: ASIC_MANUAL_URL,
          }) }],
          isError: true,
        };
      }

      const detailUrl = `${ASIC_CONNECT_BASE}/panelOrganisationResult.jspx?searchText=${encodeURIComponent(acn)}&resultsPerPage=10&action=googleSearch&searchType=OrgAndBus`;

      let html: string;
      try {
        const res = await externalFetch(detailUrl, {
          headers: { Accept: 'text/html,application/xhtml+xml', Referer: ASIC_MANUAL_URL },
        });
        if (!res.ok) {
          throw new ExternalApiError('ASIC', `ASIC Connect returned status ${res.status}`, res.status);
        }
        html = await res.text();
      } catch (err) {
        log.warn({ err }, 'ASIC Connect detail fetch failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'search_unavailable',
            message: 'ASIC Connect is currently unavailable. Search manually at connectonline.asic.gov.au',
            manual_url: ASIC_MANUAL_URL,
          }) }],
          isError: true,
        };
      }

      const { company_name, current, former } = parseOfficeholders(html);
      const displayName = company_name ?? input.company_name ?? `ACN ${acn}`;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'get_director_history',
        query_text: input.acn ?? input.company_name ?? '',
        result_count: current.length + former.length,
        top_results: current
          .slice(0, 3)
          .map((o) => ({ title: `${o.name} (${o.role ?? 'Director'})`, url: detailUrl })),
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          company: displayName,
          acn,
          asic_url: detailUrl,
          current_officeholders: current,
          former_officeholders: former,
          ...(current.length === 0 && former.length === 0
            ? { note: 'No officeholder data could be extracted. View the company page directly at the asic_url.' }
            : {}),
        }) }],
      };
    },
  );
}
