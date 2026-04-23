import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, matterRefSchema } from './_shared.js';
import { externalFetch, ExternalApiError } from '../external-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

// ── ASIC endpoints ─────────────────────────────────────────────────────────────
const ASIC_ENFORCEMENT_URL =
  'https://asic.gov.au/regulatory-resources/find-a-document/search-for-enforcement-outcomes/';
const ASIC_UNDERTAKINGS_URL =
  'https://asic.gov.au/regulatory-resources/find-a-document/search-for-enforceable-undertakings/';
const ASIC_BANNING_URL =
  'https://asic.gov.au/regulatory-resources/find-a-document/search-for-banning-orders/';

// ── ACCC endpoints ─────────────────────────────────────────────────────────────
const ACCC_REGISTERS: Record<string, { url: string; label: string }> = {
  mergers_informal: {
    url: 'https://www.accc.gov.au/public-registers/mergers-registers/public-informal-merger-assessments',
    label: 'ACCC Informal Merger Assessments',
  },
  mergers_formal: {
    url: 'https://www.accc.gov.au/public-registers/mergers-registers/formal-merger-review-register',
    label: 'ACCC Formal Merger Reviews',
  },
  enforcement: {
    url: 'https://www.accc.gov.au/public-registers/compliance-and-enforcement',
    label: 'ACCC Compliance & Enforcement',
  },
  undertakings: {
    url: 'https://www.accc.gov.au/public-registers/court-enforceable-undertakings',
    label: 'ACCC Court Enforceable Undertakings',
  },
};

const inputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe('Name, company, or keyword to search regulatory decisions for'),
  regulator: z
    .enum(['asic', 'accc', 'all'])
    .default('all')
    .describe('Which regulator\'s decisions to search: asic, accc, or all'),
  decision_type: z
    .enum([
      'all',
      // ASIC-specific
      'enforcement',
      'enforceable_undertaking',
      'banning_order',
      // ACCC-specific
      'mergers_informal',
      'mergers_formal',
      'accc_enforcement',
      'accc_undertakings',
    ])
    .default('all')
    .describe(
      'Type of decision to search for. ' +
      'ASIC types: enforcement, enforceable_undertaking, banning_order. ' +
      'ACCC types: mergers_informal, mergers_formal, accc_enforcement, accc_undertakings.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Maximum number of results to return'),
  matter_ref: matterRefSchema,
});

interface RegulatoryDecision {
  title: string;
  date: string | null;
  summary: string | null;
  url: string;
  regulator: string;
  decision_type: string;
}

// ── ASIC HTML parsers ──────────────────────────────────────────────────────────

function parseAsicDecisions(
  html: string,
  baseUrl: string,
  decisionType: string,
): RegulatoryDecision[] {
  const results: RegulatoryDecision[] = [];

  // Pattern 1: article/result list items
  const articlePattern = /<(?:article|li)[^>]*class="[^"]*(?:result|search-result|listing)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|li)>/gi;
  let match: RegExpExecArray | null;
  while ((match = articlePattern.exec(html)) !== null) {
    const item = match[1]!;
    const titleMatch = item.match(/<(?:h[2-4]|a)[^>]*>([\s\S]*?)<\/(?:h[2-4]|a)>/i);
    const linkMatch = item.match(/href="([^"]+)"/i);
    const dateMatch = item.match(
      /(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i,
    );
    const summaryMatch = item.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

    if (titleMatch) {
      const title = titleMatch[1]!.replace(/<[^>]+>/g, '').replace(/\s{2,}/g, ' ').trim();
      if (!title || title.length < 5) continue;
      const href = linkMatch?.[1] ?? null;
      results.push({
        title,
        date: dateMatch?.[1] ?? null,
        summary: summaryMatch
          ? summaryMatch[1]!.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300)
          : null,
        url: href ? (href.startsWith('http') ? href : `https://asic.gov.au${href}`) : baseUrl,
        regulator: 'asic',
        decision_type: decisionType,
      });
    }
  }

  // Pattern 2: table rows (banning orders / undertakings)
  if (results.length === 0) {
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowPattern.exec(html)) !== null) {
      const cells = rowMatch[1]!
        .match(/<td[^>]*>([\s\S]*?)<\/td>/gi)
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

      if (cells.length >= 2) {
        const name = cells[0]?.text ?? '';
        if (!name || /^(name|respondent|person)/i.test(name)) continue;
        const href = cells.find((c) => c.href)?.href ?? null;
        const dateCell = cells.find((c) => /\d{4}/.test(c.text) && /\d{1,2}/.test(c.text));
        results.push({
          title: name,
          date: dateCell?.text ?? null,
          summary: cells.slice(1, 3).map((c) => c.text).filter(Boolean).join(' — ').slice(0, 300) || null,
          url: href ? (href.startsWith('http') ? href : `https://asic.gov.au${href}`) : baseUrl,
          regulator: 'asic',
          decision_type: decisionType,
        });
      }
    }
  }

  return results;
}

// ── ACCC HTML parser ───────────────────────────────────────────────────────────

function parseAcccRegister(
  html: string,
  baseUrl: string,
  registerType: string,
  query: string,
): RegulatoryDecision[] {
  const results: RegulatoryDecision[] = [];
  const q = query.toLowerCase();

  // Table rows
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const cells = rowMatch[1]!
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

    const rowText = cells.map((c) => c.text).join(' ').toLowerCase();
    if (!rowText.includes(q)) continue;

    const href = cells.find((c) => c.href)?.href ?? null;
    const dateCell = cells.find((c) => /\d{4}/.test(c.text));
    results.push({
      title,
      date: dateCell?.text ?? null,
      summary: cells.slice(1, 4).map((c) => c.text).filter(Boolean).join(' — ').slice(0, 300) || null,
      url: href ? (href.startsWith('http') ? href : `https://www.accc.gov.au${href}`) : baseUrl,
      regulator: 'accc',
      decision_type: registerType,
    });
  }

  // Article/list items (fallback)
  if (results.length === 0) {
    const itemPattern = /<(?:article|li)[^>]*>([\s\S]*?)<\/(?:article|li)>/gi;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemPattern.exec(html)) !== null) {
      const item = itemMatch[1]!;
      if (!item.replace(/<[^>]+>/g, ' ').toLowerCase().includes(q)) continue;
      const titleMatch = item.match(/<(?:h[2-5]|a)[^>]*>([\s\S]*?)<\/(?:h[2-5]|a)>/i);
      const linkMatch = item.match(/href="([^"]+)"/i);
      const summaryMatch = item.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (titleMatch) {
        const title = titleMatch[1]!.replace(/<[^>]+>/g, '').trim();
        if (title.length < 5) continue;
        const href = linkMatch?.[1] ?? null;
        results.push({
          title,
          date: null,
          summary: summaryMatch
            ? summaryMatch[1]!.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300)
            : null,
          url: href ? (href.startsWith('http') ? href : `https://www.accc.gov.au${href}`) : baseUrl,
          regulator: 'accc',
          decision_type: registerType,
        });
      }
    }
  }

  return results;
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function registerSearchRegulatoryDecisions(server: McpServer): void {
  registerTool(
    server,
    'search_regulatory_decisions',
    {
      title: 'Search regulatory decisions',
      description: '[Regulatory Intelligence] Search ASIC and ACCC public registers for regulatory decisions — enforcement outcomes, banning orders, enforceable undertakings, and merger assessments. ' +
    'Filter by regulator (asic/accc/all) and decision type. ' +
    'Use for regulatory risk assessment, counterparty due diligence, competition law research, and government advisory matters.',
      inputSchema: inputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const log = logger.child({ tool: 'search_regulatory_decisions' });

      const targets: Array<{ url: string; type: string; parser: 'asic' | 'accc' }> = [];

      const wantAsic = input.regulator === 'asic' || input.regulator === 'all';
      const wantAccc = input.regulator === 'accc' || input.regulator === 'all';
      const dt = input.decision_type;

      if (wantAsic) {
        if (dt === 'all' || dt === 'enforcement')
          targets.push({ url: ASIC_ENFORCEMENT_URL + `?query=${encodeURIComponent(input.query)}`, type: 'enforcement', parser: 'asic' });
        if (dt === 'all' || dt === 'enforceable_undertaking')
          targets.push({ url: ASIC_UNDERTAKINGS_URL + `?query=${encodeURIComponent(input.query)}`, type: 'enforceable_undertaking', parser: 'asic' });
        if (dt === 'all' || dt === 'banning_order')
          targets.push({ url: ASIC_BANNING_URL + `?query=${encodeURIComponent(input.query)}`, type: 'banning_order', parser: 'asic' });
      }

      if (wantAccc) {
        const acccTypes: Array<[string, string]> = [
          ['mergers_informal', 'mergers_informal'],
          ['mergers_formal', 'mergers_formal'],
          ['accc_enforcement', 'enforcement'],
          ['accc_undertakings', 'undertakings'],
        ];
        for (const [dtKey, regKey] of acccTypes) {
          if (dt === 'all' || dt === dtKey) {
            const reg = ACCC_REGISTERS[regKey];
            if (reg) targets.push({ url: reg.url, type: dtKey, parser: 'accc' });
          }
        }
      }

      const allResults: RegulatoryDecision[] = [];
      const errors: string[] = [];

      await Promise.allSettled(
        targets.map(async ({ url, type, parser }) => {
          try {
            const res = await externalFetch(url, {
              headers: {
                Accept: 'text/html,application/xhtml+xml',
                Referer: parser === 'asic' ? 'https://asic.gov.au/' : 'https://www.accc.gov.au/',
              },
            });
            if (!res.ok) throw new ExternalApiError(parser.toUpperCase(), `Status ${res.status}`, res.status);
            const html = await res.text();
            const parsed =
              parser === 'asic'
                ? parseAsicDecisions(html, url, type)
                : parseAcccRegister(html, url, type, input.query);
            allResults.push(...parsed);
          } catch (err) {
            log.warn({ err, url, type }, 'regulatory decisions fetch failed');
            errors.push(type);
          }
        }),
      );

      // Filter by query (asic results are pre-filtered by URL param; accc results are filtered in parser)
      const q = input.query.toLowerCase();
      const filtered = allResults
        .filter((r) =>
          r.regulator === 'accc' ||
          r.title.toLowerCase().includes(q) ||
          (r.summary ?? '').toLowerCase().includes(q),
        )
        .slice(0, input.limit);

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'search_regulatory_decisions',
        query_text: input.query,
        result_count: filtered.length,
        top_results: filtered.slice(0, 3).map((r) => ({ title: r.title, url: r.url })),
      });

      if (errors.length === targets.length && targets.length > 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'search_unavailable',
            message: 'Regulatory decision registers are currently unavailable.',
            manual_urls: {
              asic_enforcement: ASIC_ENFORCEMENT_URL,
              asic_undertakings: ASIC_UNDERTAKINGS_URL,
              asic_banning_orders: ASIC_BANNING_URL,
              ...Object.fromEntries(Object.entries(ACCC_REGISTERS).map(([k, v]) => [`accc_${k}`, v.url])),
            },
          }) }],
          isError: true,
        };
      }

      // ASIC and ACCC registers are HTML-scraped from landing pages that do
      // not expose a stable offset / page parameter. No `cursor` input is
      // accepted — agents cannot page past the first batch.
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          query: input.query,
          regulator: input.regulator,
          decision_type: input.decision_type,
          result_count: filtered.length,
          results: filtered,
          pagination: {
            returned: filtered.length,
            limit: input.limit ?? 10,
            has_more: allResults.length > (input.limit ?? 10),
          },
          ...(errors.length > 0 ? { partial_failure: `Could not fetch: ${errors.join(', ')}` } : {}),
          manual_urls: {
            asic_enforcement: ASIC_ENFORCEMENT_URL,
            asic_undertakings: ASIC_UNDERTAKINGS_URL,
            asic_banning_orders: ASIC_BANNING_URL,
            ...Object.fromEntries(Object.entries(ACCC_REGISTERS).map(([k, v]) => [`accc_${k}`, v.url])),
          },
        }) }],
      };
    },
  );
}
