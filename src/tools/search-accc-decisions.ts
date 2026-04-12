import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { externalFetch, ExternalApiError } from '../external-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const REGISTERS: Record<string, { url: string; label: string }> = {
  mergers_informal: {
    url: 'https://www.accc.gov.au/public-registers/mergers-registers/public-informal-merger-assessments',
    label: 'Informal Merger Assessments',
  },
  mergers_formal: {
    url: 'https://www.accc.gov.au/public-registers/mergers-registers/formal-merger-review-register',
    label: 'Formal Merger Reviews',
  },
  enforcement: {
    url: 'https://www.accc.gov.au/public-registers/compliance-and-enforcement',
    label: 'Compliance & Enforcement',
  },
  undertakings: {
    url: 'https://www.accc.gov.au/public-registers/court-enforceable-undertakings',
    label: 'Court Enforceable Undertakings',
  },
};

const inputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe('Company name or keyword to search ACCC public registers for'),
  register_type: z
    .enum(['mergers_informal', 'mergers_formal', 'enforcement', 'undertakings', 'all'])
    .default('all')
    .describe('Which ACCC register to search'),
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

interface AcccDecision {
  title: string;
  date: string | null;
  summary: string | null;
  url: string;
  register_type: string;
}

function parseAcccRegister(html: string, baseUrl: string, registerType: string, query: string): AcccDecision[] {
  const results: AcccDecision[] = [];
  const q = query.toLowerCase();

  // Parse table rows from ACCC register pages
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const rowHtml = rowMatch[1]!;
    const cells = rowHtml
      .match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)
      ?.map((cell) => {
        const linkMatch = cell.match(/href="([^"]+)"/i);
        const text = cell
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
        return { text, href: linkMatch?.[1] ?? null };
      })
      .filter((c) => c.text.length > 0) ?? [];

    if (cells.length < 2) continue;

    const title = cells[0]?.text ?? '';
    if (!title || /^(matter|company|parties|transaction|date)/i.test(title)) continue;

    // Only include rows that mention the query
    const rowText = cells.map((c) => c.text).join(' ').toLowerCase();
    if (!rowText.includes(q)) continue;

    const href = cells.find((c) => c.href)?.href ?? null;
    const url = href
      ? href.startsWith('http') ? href : `https://www.accc.gov.au${href}`
      : baseUrl;

    const dateCell = cells.find((c) => /\d{4}/.test(c.text));
    const summary = cells
      .slice(1, 4)
      .map((c) => c.text)
      .filter(Boolean)
      .join(' — ')
      .slice(0, 300) || null;

    results.push({
      title,
      date: dateCell?.text ?? null,
      summary,
      url,
      register_type: registerType,
    });
  }

  // Also try article/list item pattern
  if (results.length === 0) {
    const itemPattern = /<(?:article|li)[^>]*>([\s\S]*?)<\/(?:article|li)>/gi;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemPattern.exec(html)) !== null) {
      const item = itemMatch[1]!;
      const itemText = item.replace(/<[^>]+>/g, ' ').toLowerCase();
      if (!itemText.includes(q)) continue;

      const titleMatch = item.match(/<(?:h[2-5]|a)[^>]*>([\s\S]*?)<\/(?:h[2-5]|a)>/i);
      const linkMatch = item.match(/href="([^"]+)"/i);
      const summaryMatch = item.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

      if (titleMatch) {
        const title = titleMatch[1]!.replace(/<[^>]+>/g, '').trim();
        if (title.length < 5) continue;

        const href = linkMatch?.[1] ?? null;
        const url = href
          ? href.startsWith('http') ? href : `https://www.accc.gov.au${href}`
          : baseUrl;
        const summary = summaryMatch
          ? summaryMatch[1]!.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300)
          : null;

        results.push({ title, date: null, summary, url, register_type: registerType });
      }
    }
  }

  return results;
}

export function registerSearchAcccDecisions(server: McpServer): void {
  server.tool(
    'search_accc_decisions',
    'Search ACCC public registers for merger assessments, enforcement actions, and court undertakings by company name or keyword. Use for competition law research, regulatory conflict assessment, and merger-related due diligence.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'search_accc_decisions' });

      const targets =
        input.register_type === 'all'
          ? Object.entries(REGISTERS)
          : [[input.register_type, REGISTERS[input.register_type]!] as [string, { url: string; label: string }]];

      const allResults: AcccDecision[] = [];
      const errors: string[] = [];

      await Promise.allSettled(
        targets.map(async ([type, { url }]) => {
          try {
            const res = await externalFetch(url, {
              headers: { Accept: 'text/html,application/xhtml+xml', Referer: 'https://www.accc.gov.au/' },
            });
            if (!res.ok) throw new ExternalApiError('ACCC', `Status ${res.status}`, res.status);
            const html = await res.text();
            const parsed = parseAcccRegister(html, url, type, input.query);
            allResults.push(...parsed);
          } catch (err) {
            log.warn({ err, url }, 'ACCC register fetch failed');
            errors.push(type);
          }
        }),
      );

      const sliced = allResults.slice(0, input.limit);

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'search_accc_decisions',
        query_text: input.query,
        result_count: sliced.length,
        top_results: sliced.slice(0, 3).map((r) => ({ title: r.title, url: r.url })),
      });

      if (errors.length === targets.length) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'search_unavailable',
            message: 'ACCC register search is currently unavailable.',
            manual_urls: Object.fromEntries(Object.entries(REGISTERS).map(([k, v]) => [k, v.url])),
          }) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          query: input.query,
          register_type: input.register_type,
          result_count: sliced.length,
          results: sliced,
          ...(errors.length > 0 ? { partial_failure: `Could not fetch: ${errors.join(', ')}` } : {}),
          manual_urls: Object.fromEntries(Object.entries(REGISTERS).map(([k, v]) => [k, v.url])),
        }) }],
      };
    },
  );
}
