import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { externalFetch, ExternalApiError } from '../external-client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

// ── ASIC Connect constants ─────────────────────────────────────────────────────
const ASIC_CONNECT_BASE = 'https://connectonline.asic.gov.au/RegistrySearch/faces/landing';
const ASIC_MANUAL_URL = `${ASIC_CONNECT_BASE}/SearchRegisters.jspx`;

const TYPE_MAP: Record<string, string> = {
  company: 'OrgAndBus',
  person:  'IndividualPerson',
  all:     'OrgAndBus',
};

// ── Input schema ───────────────────────────────────────────────────────────────
const inputSchema = z.object({
  identifier: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'ABN (e.g. "72 629 951 766"), ACN (e.g. "629 951 766"), or entity/person name to search',
    ),
  identifier_type: z
    .enum(['abn', 'acn', 'name'])
    .optional()
    .describe(
      'Type of identifier. Omit to auto-detect: 11-digit strings → ABN, 9-digit → ACN, text → name search.',
    ),
  search_type: z
    .enum(['company', 'person', 'all'])
    .default('company')
    .describe(
      'For name searches: limit to companies/organisations, persons, or both. Ignored for ABN/ACN lookups.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Maximum number of search results to return for name searches'),
  include_officers: z
    .boolean()
    .default(false)
    .describe(
      'Also fetch current and former directors/officeholders for the resolved entity. ' +
      'Requires a second ASIC Connect request — only enable when officer data is needed.',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this lookup in the research log.'),
});

// ── Helper: detect identifier type ────────────────────────────────────────────
function normaliseDigits(s: string): string {
  return s.replace(/[\s\-]/g, '');
}

function detectType(identifier: string): 'abn' | 'acn' | 'name' {
  const digits = normaliseDigits(identifier);
  if (/^\d{11}$/.test(digits)) return 'abn';
  if (/^\d{9}$/.test(digits))  return 'acn';
  return 'name';
}

// ── ABR types & parsers ────────────────────────────────────────────────────────
interface AbrBusinessEntity {
  ABN?: { identifierValue?: string; isCurrentIndicator?: string };
  entityStatus?: { entityStatusCode?: string };
  ASICNumber?: string;
  entityType?: { entityDescription?: string };
  goodsAndServicesTax?: { effectiveFrom?: string; effectiveTo?: string };
  mainName?: { organisationName?: string };
  legalName?: { organisationName?: string };
  mainTradingName?: { organisationName?: string };
  mainBusinessPhysicalAddress?: { stateCode?: string; postcode?: string };
}

function parseAbrEntity(entity: AbrBusinessEntity) {
  const name =
    entity.mainName?.organisationName ??
    entity.legalName?.organisationName ??
    entity.mainTradingName?.organisationName ??
    null;
  const gstTo = entity.goodsAndServicesTax?.effectiveTo;
  const gstRegistered =
    !!entity.goodsAndServicesTax?.effectiveFrom &&
    (!gstTo || gstTo === '0001-01-01');

  return {
    abn:        entity.ABN?.identifierValue ?? null,
    abn_status: entity.ABN?.isCurrentIndicator === 'Y' ? 'current' : 'replaced',
    entity_name: name,
    entity_type: entity.entityType?.entityDescription ?? null,
    status:      entity.entityStatus?.entityStatusCode ?? null,
    acn:         entity.ASICNumber ?? null,
    gst_registered: gstRegistered,
    state:    entity.mainBusinessPhysicalAddress?.stateCode ?? null,
    postcode: entity.mainBusinessPhysicalAddress?.postcode ?? null,
  };
}

// ── ASIC types & parsers ───────────────────────────────────────────────────────
interface AsicResult {
  name: string;
  acn:    string | null;
  type:   string | null;
  status: string | null;
  asic_url: string;
}

interface Officeholder {
  name:     string;
  role:     string | null;
  appointed: string | null;
  ceased?:  string | null;
}

/**
 * Lightweight structural check: returns false if the HTML doesn't look like
 * a valid ASIC Connect search result page, which indicates the scraper may
 * need updating. Logs a warning with a content fingerprint so breakage is
 * detectable in Railway logs without exposing the full HTML.
 */
function checkAsicHtmlStructure(html: string): boolean {
  // All valid ASIC Connect result pages contain at least one of these markers
  const KNOWN_MARKERS = ['tbl_data_cell', 'panelSearchResult', 'RegistrySearch', 'connectonline.asic.gov.au'];
  const hasMarker = KNOWN_MARKERS.some((m) => html.includes(m));
  if (!hasMarker) {
    // Generate a short content fingerprint (first 64 chars of the body, stripped)
    const fingerprint = html.replace(/\s+/g, ' ').trim().slice(0, 64);
    logger.warn({ fingerprint }, 'ASIC Connect HTML structure unrecognised — scraper may need updating');
  }
  return hasMarker;
}

function parseAsicResults(html: string, limit: number): AsicResult[] {
  const results: AsicResult[] = [];
  const rowPattern  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellPattern = /<td[^>]*class="[^"]*tbl_data_cell[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(html)) !== null && results.length < limit) {
    const rowHtml = rowMatch[1]!;
    const cells: string[] = [];

    let cellMatch: RegExpExecArray | null;
    const cellRe = new RegExp(cellPattern.source, 'gi');
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      const text = cellMatch[1]!
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (text) cells.push(text);
    }

    if (cells.length >= 2) {
      const name = cells[0] ?? '';
      const acn  = cells[1] ? cells[1].replace(/\s/g, '') : null;
      const type   = cells[2] ?? null;
      const status = cells[3] ?? null;

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

function parseOfficeholders(html: string): { current: Officeholder[]; former: Officeholder[] } {
  const current: Officeholder[] = [];
  const former:  Officeholder[] = [];

  const sections = html.split(/<h[23][^>]*>/i);
  for (const section of sections) {
    const isFormer = /former|ceased|previous/i.test(section.slice(0, 100));
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
          role:     cells[1] ?? null,
          appointed: cells[2] ?? null,
          ceased:   cells[3] ?? null,
        };
        if (isFormer || (officeholder.ceased && officeholder.ceased !== '')) {
          former.push(officeholder);
        } else {
          current.push(officeholder);
        }
      }
    }
  }
  return { current, former };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchOfficers(acn: string, log: any): Promise<{ current: Officeholder[]; former: Officeholder[] } | null> {
  const url = `${ASIC_CONNECT_BASE}/panelOrganisationResult.jspx?searchText=${encodeURIComponent(acn)}&resultsPerPage=10&action=googleSearch&searchType=OrgAndBus`;
  try {
    const res = await externalFetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', Referer: ASIC_MANUAL_URL },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseOfficeholders(html);
  } catch (err) {
    log.warn({ err, acn }, 'officer fetch failed');
    return null;
  }
}

// ── Tool registration ──────────────────────────────────────────────────────────
export function registerLookupEntity(server: McpServer): void {
  server.tool(
    'lookup_entity',
    '[Entity Intelligence] Look up an Australian business entity by ABN, ACN, or name. ' +
    'Uses the Australian Business Register (ABR) for verified registration data (name, type, GST status, state) ' +
    'and ASIC Connect for company search and officeholder information. ' +
    'ABN/ACN lookups: queries ABR first (requires ABR_GUID), falls back to ASIC Connect for company details. ' +
    'Name searches: queries ABR name index and ASIC Connect in parallel. ' +
    'Set include_officers: true to retrieve current and former directors/officeholders. ' +
    'Use for counterparty due diligence, conflicts checking, entity verification, and corporate governance research.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'lookup_entity' });

      const idType  = input.identifier_type ?? detectType(input.identifier);
      const digits  = normaliseDigits(input.identifier);
      const hasAbr  = !!config.ABR_GUID;

      // ── ABN / ACN lookup ───────────────────────────────────────────────────
      if (idType === 'abn' || idType === 'acn') {
        // Prefer ABR if configured
        if (hasAbr) {
          const guid = config.ABR_GUID!;
          const url  = idType === 'abn'
            ? `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${encodeURIComponent(digits)}&guid=${encodeURIComponent(guid)}`
            : `https://abr.business.gov.au/json/AcnDetails.aspx?acn=${encodeURIComponent(digits)}&guid=${encodeURIComponent(guid)}`;

          let data: unknown;
          try {
            const res = await externalFetch(url);
            if (!res.ok) throw new ExternalApiError('ABR', `ABR API returned status ${res.status}`, res.status);
            data = await res.json();
          } catch (err) {
            if (err instanceof ExternalApiError) {
              log.warn({ err }, 'ABR lookup failed — falling back to ASIC Connect');
              // Fall through to ASIC Connect below
              data = null;
            } else {
              throw err;
            }
          }

          if (data) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const payload = (data as any)?.ABRPayloadSearchResults?.response;
            if (payload && !payload.exception) {
              const entityKey = Object.keys(payload).find((k) => k.startsWith('businessEntity'));
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const entity = entityKey ? (payload as any)[entityKey] as AbrBusinessEntity : null;
              if (entity) {
                const parsed = parseAbrEntity(entity);
                const resolvedAcn = parsed.acn?.replace(/\D/g, '') ?? digits;

                let officers: { current: Officeholder[]; former: Officeholder[] } | null = null;
                if (input.include_officers && resolvedAcn) {
                  officers = await fetchOfficers(resolvedAcn, log);
                }

                recordMatterQuery({
                  matter_ref: input.matter_ref,
                  tool_name: 'lookup_entity',
                  query_text: input.identifier,
                  result_count: 1,
                  top_results: parsed.entity_name
                    ? [{ title: parsed.entity_name, url: `https://abr.business.gov.au/ABN/View?abn=${parsed.abn ?? ''}` }]
                    : [],
                });

                return {
                  content: [{ type: 'text' as const, text: JSON.stringify({
                    source: 'abr',
                    identifier_type: idType,
                    ...parsed,
                    abr_url: `https://abr.business.gov.au/ABN/View?abn=${parsed.abn ?? ''}`,
                    asic_url: resolvedAcn
                      ? `${ASIC_CONNECT_BASE}/panelOrganisationResult.jspx?searchText=${resolvedAcn}&searchType=OrgAndBus&action=googleSearch`
                      : ASIC_MANUAL_URL,
                    ...(officers ? { officers } : {}),
                  }) }],
                };
              }
            }
          }
        }

        // ── ASIC Connect fallback (ACN or when ABR not configured / failed) ──
        const acnDigits = idType === 'acn' ? digits : null; // for ABN we don't have ACN yet
        if (acnDigits || !hasAbr) {
          const searchText = acnDigits ?? input.identifier;
          const detailUrl = `${ASIC_CONNECT_BASE}/panelOrganisationResult.jspx?searchText=${encodeURIComponent(searchText)}&resultsPerPage=1&action=googleSearch&searchType=OrgAndBus`;
          try {
            const res = await externalFetch(detailUrl, {
              headers: { Accept: 'text/html,application/xhtml+xml', Referer: ASIC_MANUAL_URL },
            });
            if (res.ok) {
              const html = await res.text();
              checkAsicHtmlStructure(html);
              const results = parseAsicResults(html, 1);

              let officers: { current: Officeholder[]; former: Officeholder[] } | null = null;
              if (input.include_officers && results[0]?.acn) {
                officers = await fetchOfficers(results[0].acn.replace(/\D/g, ''), log);
              }

              recordMatterQuery({
                matter_ref: input.matter_ref,
                tool_name: 'lookup_entity',
                query_text: input.identifier,
                result_count: results.length,
                top_results: results.slice(0, 1).map((r) => ({ title: r.name, url: r.asic_url })),
              });

              return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                  source: 'asic_connect',
                  identifier_type: idType,
                  result_count: results.length,
                  results,
                  ...(officers ? { officers } : {}),
                  manual_url: ASIC_MANUAL_URL,
                }) }],
              };
            }
          } catch (err) {
            log.warn({ err }, 'ASIC Connect ACN lookup failed');
          }
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'not_found',
            message: `Could not retrieve entity for ${idType.toUpperCase()} ${input.identifier}. ` +
              (hasAbr ? 'Both ABR and ASIC Connect are unavailable.' : 'ABR_GUID is not configured and ASIC Connect is unavailable.') +
              ` Search manually at ${ASIC_MANUAL_URL}`,
            manual_url: ASIC_MANUAL_URL,
          }) }],
          isError: true,
        };
      }

      // ── Name search — run ABR + ASIC Connect in parallel ──────────────────
      const abrResultsP: Promise<Array<{
        abn: string | null; entity_name: string | null;
        entity_type: string | null; status: string | null;
        state: string | null; postcode: string | null;
      }>> = (async () => {
        if (!hasAbr) return [];
        const guid = config.ABR_GUID!;
        const url = `https://abr.business.gov.au/json/MatchingNames.aspx?name=${encodeURIComponent(input.identifier)}&guid=${encodeURIComponent(guid)}`;
        try {
          const res = await externalFetch(url);
          if (!res.ok) return [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = await res.json() as any;
          const payload = data?.ABRPayloadSearchResults?.response;
          if (!payload || payload.exception) return [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const list = payload.searchResultsList?.searchResultsRecord as any[];
          if (!list || list.length === 0) return [];
          return list.slice(0, input.limit).map((r) => ({
            abn: r.ABN?.identifierValue ?? null,
            entity_name:
              r.mainName?.organisationName ??
              r.legalName?.organisationName ??
              r.mainTradingName?.organisationName ??
              null,
            entity_type: r.entityType?.entityDescription ?? null,
            status: r.ABNStatus ?? null,
            state: r.mainBusinessPhysicalAddress?.stateCode ?? null,
            postcode: r.mainBusinessPhysicalAddress?.postcode ?? null,
          }));
        } catch {
          return [];
        }
      })();

      const asicResultsP: Promise<AsicResult[]> = (async () => {
        const searchType = TYPE_MAP[input.search_type] ?? 'OrgAndBus';
        const url = `${ASIC_CONNECT_BASE}/panelSearchResult.jspx?action=googleSearch&searchText=${encodeURIComponent(input.identifier)}&searchType=${searchType}&pResultsPerPage=${input.limit}`;
        try {
          const res = await externalFetch(url, {
            headers: { Accept: 'text/html,application/xhtml+xml', Referer: ASIC_MANUAL_URL },
          });
          if (!res.ok) return [];
          const html = await res.text();
          checkAsicHtmlStructure(html);
          return parseAsicResults(html, input.limit);
        } catch {
          return [];
        }
      })();

      const [abrResults, asicResults] = await Promise.all([abrResultsP, asicResultsP]);

      // Optional officer lookup for top ASIC result
      let officers: { current: Officeholder[]; former: Officeholder[] } | null = null;
      if (input.include_officers) {
        const topAcn = asicResults[0]?.acn?.replace(/\D/g, '') ?? null;
        if (topAcn) {
          officers = await fetchOfficers(topAcn, log);
        }
      }

      const totalCount = abrResults.length + asicResults.length;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'lookup_entity',
        query_text: input.identifier,
        result_count: totalCount,
        top_results: [
          ...abrResults
            .filter((r) => r.entity_name)
            .slice(0, 2)
            .map((r) => ({ title: r.entity_name!, url: `https://abr.business.gov.au/ABN/View?abn=${r.abn ?? ''}` })),
          ...asicResults
            .slice(0, 1)
            .map((r) => ({ title: r.name, url: r.asic_url })),
        ],
      });

      if (totalCount === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            query: input.identifier,
            result_count: 0,
            message: `No entities found matching "${input.identifier}" in ABR or ASIC Connect.`,
            manual_url: ASIC_MANUAL_URL,
          }) }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          query: input.identifier,
          search_type: input.search_type,
          abr_results: abrResults.length > 0 ? { count: abrResults.length, results: abrResults } : null,
          asic_results: asicResults.length > 0 ? { count: asicResults.length, results: asicResults } : null,
          ...(officers ? { officers } : {}),
          manual_url: ASIC_MANUAL_URL,
        }) }],
      };
    },
  );
}
