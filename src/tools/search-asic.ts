import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { externalFetch, ExternalApiError } from '../external-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const ASIC_CONNECT_BASE = 'https://connectonline.asic.gov.au/RegistrySearch/faces/landing';
const ASIC_MANUAL_URL = `${ASIC_CONNECT_BASE}/SearchRegisters.jspx`;

const inputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe('Company or person name to search in the ASIC register'),
  search_type: z
    .enum(['company', 'person', 'all'])
    .default('company')
    .describe('Search for companies/organisations, persons, or both'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Maximum number of results to return'),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this search in the research log.'),
});

const TYPE_MAP: Record<string, string> = {
  company: 'OrgAndBus',
  person: 'IndividualPerson',
  all: 'OrgAndBus',
};

interface AsicResult {
  name: string;
  acn: string | null;
  type: string | null;
  status: string | null;
  asic_url: string;
}

function parseAsicResults(html: string, limit: number): AsicResult[] {
  const results: AsicResult[] = [];

  // ASIC Connect renders results in a table. Parse rows by looking for
  // the data cells pattern. Each result row contains: name, ACN, type, status.
  // Pattern: table rows in the results section contain tbl_data_cell class.
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellPattern = /<td[^>]*class="[^"]*tbl_data_cell[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(html)) !== null && results.length < limit) {
    const rowHtml = rowMatch[1]!;
    const cells: string[] = [];

    let cellMatch: RegExpExecArray | null;
    const cellRe = new RegExp(cellPattern.source, 'gi');
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      const cellText = cellMatch[1]!
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (cellText) cells.push(cellText);
    }

    if (cells.length >= 2) {
      const name = cells[0] ?? '';
      const acn = cells[1] ? cells[1].replace(/\s/g, '') : null;
      const type = cells[2] ?? null;
      const status = cells[3] ?? null;

      // Filter out header rows
      if (name && !/^(name|organisation|company|search|results)/i.test(name)) {
        const acnForUrl = acn?.replace(/\D/g, '') ?? '';
        results.push({
          name,
          acn: acn ?? null,
          type,
          status,
          asic_url: acnForUrl
            ? `${ASIC_CONNECT_BASE}/panelOrganisationResult.jspx?searchText=${acnForUrl}&searchType=OrgAndBus&action=googleSearch`
            : ASIC_MANUAL_URL,
        });
      }
    }
  }

  return results;
}

export function registerSearchAsic(server: McpServer): void {
  server.tool(
    'search_asic',
    'Search the ASIC Connect public register for Australian companies and persons by name. Returns company name, ACN, entity type, and registration status. Best-effort public scrape of the ASIC Connect register — use for initial entity identification and counterparty research.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'search_asic' });
      const searchType = TYPE_MAP[input.search_type] ?? 'OrgAndBus';
      const url = `${ASIC_CONNECT_BASE}/panelSearchResult.jspx?action=googleSearch&searchText=${encodeURIComponent(input.query)}&searchType=${searchType}&pResultsPerPage=${input.limit}`;

      let html: string;
      try {
        const res = await externalFetch(url, {
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            Referer: ASIC_MANUAL_URL,
          },
        });
        if (!res.ok) {
          throw new ExternalApiError('ASIC', `ASIC Connect returned status ${res.status}`, res.status);
        }
        html = await res.text();
      } catch (err) {
        log.warn({ err }, 'ASIC Connect fetch failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'search_unavailable',
            message:
              'ASIC Connect search is currently unavailable. Search manually at connectonline.asic.gov.au',
            manual_url: ASIC_MANUAL_URL,
          }) }],
          isError: true,
        };
      }

      const results = parseAsicResults(html, input.limit);

      // Detect "no results" page
      const noResults =
        results.length === 0 &&
        (html.includes('No records found') ||
          html.includes('Your search returned no results') ||
          html.includes('0 record'));

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'search_asic',
        query_text: input.query,
        result_count: results.length,
        top_results: results.slice(0, 3).map((r) => ({ title: r.name, url: r.asic_url })),
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          query: input.query,
          search_type: input.search_type,
          result_count: results.length,
          results,
          ...(noResults ? { note: 'No matching entities found in ASIC Connect.' } : {}),
          manual_search_url: ASIC_MANUAL_URL,
        }) }],
      };
    },
  );
}
