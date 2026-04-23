import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, matterRefSchema } from './_shared.js';
import { externalFetch, ExternalApiError } from '../external-client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

// ── ASIC manual search URL ─────────────────────────────────────────────────────
// ASIC Connect's registry search (connectonline.asic.gov.au) migrated to an
// OutSystems/Oracle ADF SPA that requires JavaScript rendering and authentication.
// Server-side scraping is no longer possible. All programmatic lookups now use
// the ABR API exclusively. The manual URL is returned for users who need ASIC data.
const ASIC_MANUAL_URL = 'https://www.asic.gov.au/online-services/search-asic-s-registers/companies-and-registered-schemes/';

// ── ABR response parser ────────────────────────────────────────────────────────
// The ABR JSON endpoints (/json/AbnDetails.aspx etc.) return JSONP by default,
// wrapping the payload as `callback({...})` even though the path says "json".
// We fetch as text and strip the wrapper before parsing.
async function parseAbrJsonp(res: Response): Promise<unknown> {
  const text = await res.text();
  // Strip JSONP wrapper: `callback({...})` or `jQuery123({...})` or similar
  const stripped = text.replace(/^\s*\w[\w.]*\s*\(/, '').replace(/\)\s*;?\s*$/, '').trim();
  return JSON.parse(stripped);
}

// ── ABR bulk lookup helper (used by identifiers batch mode) ───────────────────

type SingleResult =
  | ({ identifier: string; identifier_type: 'abn' | 'acn' | 'name' } & ReturnType<typeof parseAbrEntity> & { abr_url: string })
  | { identifier: string; identifier_type: 'abn' | 'acn' | 'name'; error: string; message: string };

async function lookupOne(identifier: string, guid: string): Promise<SingleResult> {
  const idType = detectType(identifier);
  const digits = normaliseDigits(identifier);

  let url: string;
  if (idType === 'abn') {
    url = `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${encodeURIComponent(digits)}&guid=${encodeURIComponent(guid)}`;
  } else if (idType === 'acn') {
    url = `https://abr.business.gov.au/json/AcnDetails.aspx?acn=${encodeURIComponent(digits)}&guid=${encodeURIComponent(guid)}`;
  } else {
    url = `https://abr.business.gov.au/json/MatchingNames.aspx?name=${encodeURIComponent(identifier)}&guid=${encodeURIComponent(guid)}`;
  }

  try {
    const res = await externalFetch(url);
    if (!res.ok) {
      return { identifier, identifier_type: idType, error: 'upstream_error', message: `ABR returned status ${res.status}` };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await parseAbrJsonp(res) as any;
    const payload = data?.ABRPayloadSearchResults?.response;

    if (!payload || payload.exception) {
      return {
        identifier,
        identifier_type: idType,
        error: 'not_found',
        message: payload?.exception?.exceptionDescription ?? 'Entity not found in ABR',
      };
    }

    if (idType === 'name') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = payload.searchResultsList?.searchResultsRecord as any[];
      if (!list || list.length === 0) {
        return { identifier, identifier_type: idType, error: 'not_found', message: `No entities found matching "${identifier}"` };
      }
      const top = list[0];
      const name =
        top.mainName?.organisationName ??
        top.legalName?.organisationName ??
        top.mainTradingName?.organisationName ??
        null;
      return {
        identifier,
        identifier_type: idType,
        abn: top.ABN?.identifierValue ?? null,
        abn_status: 'current' as const,
        entity_name: name,
        entity_type: top.entityType?.entityDescription ?? null,
        status: top.ABNStatus ?? null,
        acn: null,
        gst_registered: false,
        state: top.mainBusinessPhysicalAddress?.stateCode ?? null,
        postcode: top.mainBusinessPhysicalAddress?.postcode ?? null,
        abr_url: `https://abr.business.gov.au/ABN/View?abn=${top.ABN?.identifierValue ?? ''}`,
      };
    }

    const entityKey = Object.keys(payload).find((k) => k.startsWith('businessEntity'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entity = entityKey ? (payload as any)[entityKey] as AbrBusinessEntity : null;

    if (!entity) {
      return { identifier, identifier_type: idType, error: 'not_found', message: `No entity record for ${identifier}` };
    }

    const parsed = parseAbrEntity(entity);
    return {
      identifier,
      identifier_type: idType,
      ...parsed,
      abr_url: `https://abr.business.gov.au/ABN/View?abn=${parsed.abn ?? ''}`,
    };
  } catch (err) {
    return {
      identifier,
      identifier_type: idType,
      error: 'lookup_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

// ── Output schema ──────────────────────────────────────────────────────────────
const outputSchemaShape = {
  // Error branches
  error: z.string().optional(),
  message: z.string().optional(),
  detail: z.string().optional(),

  // Single-mode ABN/ACN success
  source: z.string().optional(),
  identifier_type: z.string().optional(),
  abn: z.string().nullable().optional(),
  abn_status: z.string().optional(),
  entity_name: z.string().nullable().optional(),
  entity_type: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  acn: z.string().nullable().optional(),
  gst_registered: z.boolean().optional(),
  state: z.string().nullable().optional(),
  postcode: z.string().nullable().optional(),
  abr_url: z.string().optional(),
  asic_search_url: z.string().optional(),
  manual_url: z.string().optional(),

  // Name-search / batch
  query: z.string().optional(),
  result_count: z.number().optional(),
  results: z.array(z.record(z.any())).optional(),
  pagination: z.object({
    returned: z.number(),
    limit: z.number(),
  }).optional(),

  // Batch-specific
  requested: z.number().optional(),
  found: z.number().optional(),
  errors: z.number().optional(),
};

// ── Input schema ───────────────────────────────────────────────────────────────
const inputSchema = z.object({
  identifier: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'ABN (e.g. "72 629 951 766"), ACN (e.g. "629 951 766"), or entity/person name to search. ' +
      'Provide either this or identifiers (batch mode), not both.',
    ),
  identifiers: z
    .array(z.string().min(1).max(200))
    .min(2)
    .max(10)
    .optional()
    .describe(
      'Batch mode: list of 2–10 ABNs, ACNs, or entity names to look up in parallel via ABR. ' +
      'Mixed types are supported — each identifier is auto-detected. ' +
      'Examples: ["72 629 951 766", "629 951 766", "Westpac Banking Corporation"]',
    ),
  identifier_type: z
    .enum(['abn', 'acn', 'name'])
    .optional()
    .describe(
      'Type of identifier. Omit to auto-detect: 11-digit strings → ABN, 9-digit → ACN, text → name search.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Maximum number of search results to return for name searches'),
  matter_ref: matterRefSchema,
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

// ── Tool registration ──────────────────────────────────────────────────────────
export function registerLookupEntity(server: McpServer): void {
  registerTool(
    server,
    'lookup_entity',
    {
      title: 'Lookup entity',
      description: '[Entity Intelligence] Look up one or multiple Australian business entities by ABN, ACN, or name via the ABR (Australian Business Register). ' +
    'Returns verified registration data: name, entity type, ABN/ACN, GST status, state, and ABR/ASIC links. ' +
    'Single mode (identifier): ABN or ACN → direct ABR lookup; name → ABR name search. ' +
    'Batch mode (identifiers): Provide 2–10 ABNs, ACNs, or names to look up in parallel. ' +
    'Requires ABR_GUID environment variable (free registration at https://abr.business.gov.au/Tools/WebServices). ' +
    'For company directors/officeholders, use the ASIC manual URL returned in results. ' +
    'Use for counterparty due diligence, conflicts checking, entity verification, and corporate governance research.',
      inputSchema: inputSchema.shape,
      outputSchema: outputSchemaShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const log = logger.child({ tool: 'lookup_entity' });

      if (!input.identifier && !input.identifiers) {
        const obj = {
          error: 'missing_input',
          message: 'Either identifier (single lookup) or identifiers (batch lookup) must be provided.',
        };
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
          isError: true,
        };
      }

      if (!config.ABR_GUID) {
        const obj = {
          error: 'not_configured',
          message:
            'ABR_GUID is not configured. Register for a free GUID at https://abr.business.gov.au/Tools/WebServices ' +
            'and set it as the ABR_GUID environment variable.',
          manual_url: ASIC_MANUAL_URL,
        };
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
          isError: true,
        };
      }

      const guid = config.ABR_GUID;

      // ── Batch mode ─────────────────────────────────────────────────────────
      if (input.identifiers) {
        log.debug({ identifiers: input.identifiers }, 'bulk entity lookup starting');

        const results = await Promise.all(
          input.identifiers.map((id: string) => lookupOne(id, guid)),
        );

        const found  = results.filter((r) => !('error' in r)).length;
        const errors = results.filter((r) => 'error' in r).length;

        recordMatterQuery({
          matter_ref: input.matter_ref,
          tool_name: 'lookup_entity',
          query_text: input.identifiers.join(', ').slice(0, 200),
          result_count: found,
          top_results: results
            .filter((r): r is Extract<typeof r, { entity_name: string | null }> => 'entity_name' in r && r.entity_name != null)
            .slice(0, 3)
            .map((r) => ({ title: r.entity_name!, url: (r as { abr_url: string }).abr_url })),
        });

        const obj = {
          requested: input.identifiers.length,
          found,
          errors,
          results,
          manual_url: ASIC_MANUAL_URL,
          pagination: {
            returned: results.length,
            limit: input.identifiers.length,
          },
        };
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
        };
      }

      // ── Single mode ────────────────────────────────────────────────────────
      const singleId = input.identifier!;
      const idType  = input.identifier_type ?? detectType(singleId);
      const digits  = normaliseDigits(singleId);

      // ── ABN / ACN lookup ───────────────────────────────────────────────────
      if (idType === 'abn' || idType === 'acn') {
        const url = idType === 'abn'
          ? `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${encodeURIComponent(digits)}&guid=${encodeURIComponent(guid)}`
          : `https://abr.business.gov.au/json/AcnDetails.aspx?acn=${encodeURIComponent(digits)}&guid=${encodeURIComponent(guid)}`;

        let data: unknown;
        try {
          const res = await externalFetch(url);
          if (!res.ok) throw new ExternalApiError('ABR', `ABR API returned status ${res.status}`, res.status);
          data = await parseAbrJsonp(res);
        } catch (err) {
          log.warn({ err }, 'ABR lookup failed');
          const obj = {
            error: 'upstream_unavailable',
            message: `ABR is currently unavailable. Search manually at ${ASIC_MANUAL_URL}`,
            manual_url: ASIC_MANUAL_URL,
          };
          return {
            structuredContent: obj,
            content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
            isError: true,
          };
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload = (data as any)?.ABRPayloadSearchResults?.response;

        if (!payload || payload.exception) {
          const obj = {
            error: 'not_found',
            message: payload?.exception?.exceptionDescription
              ?? `No ABR record found for ${idType.toUpperCase()} ${singleId}. Search manually at ${ASIC_MANUAL_URL}`,
            manual_url: ASIC_MANUAL_URL,
          };
          return {
            structuredContent: obj,
            content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
            isError: true,
          };
        }

        const entityKey = Object.keys(payload).find((k) => k.startsWith('businessEntity'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entity = entityKey ? (payload as any)[entityKey] as AbrBusinessEntity : null;

        if (!entity) {
          const obj = {
            error: 'not_found',
            message: `No entity record found for ${idType.toUpperCase()} ${singleId}. Search manually at ${ASIC_MANUAL_URL}`,
            manual_url: ASIC_MANUAL_URL,
          };
          return {
            structuredContent: obj,
            content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
            isError: true,
          };
        }

        const parsed = parseAbrEntity(entity);
        const resolvedAcn = parsed.acn?.replace(/\D/g, '') ?? (idType === 'acn' ? digits : null);

        recordMatterQuery({
          matter_ref: input.matter_ref,
          tool_name: 'lookup_entity',
          query_text: singleId,
          result_count: 1,
          top_results: parsed.entity_name
            ? [{ title: parsed.entity_name, url: `https://abr.business.gov.au/ABN/View?abn=${parsed.abn ?? ''}` }]
            : [],
        });

        const obj = {
          source: 'abr',
          identifier_type: idType,
          ...parsed,
          abr_url: `https://abr.business.gov.au/ABN/View?abn=${parsed.abn ?? ''}`,
          asic_search_url: resolvedAcn
            ? `https://www.asic.gov.au/online-services/search-asic-s-registers/companies-and-registered-schemes/?q=${resolvedAcn}&type=companies`
            : ASIC_MANUAL_URL,
          manual_url: ASIC_MANUAL_URL,
        };
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
        };
      }

      // ── Name search ────────────────────────────────────────────────────────
      const url = `https://abr.business.gov.au/json/MatchingNames.aspx?name=${encodeURIComponent(singleId)}&guid=${encodeURIComponent(guid)}`;
      let abrResults: Array<{
        abn: string | null; entity_name: string | null;
        entity_type: string | null; status: string | null;
        state: string | null; postcode: string | null;
        abr_url: string;
      }> = [];

      try {
        const res = await externalFetch(url);
        if (res.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = await parseAbrJsonp(res) as any;
          const payload = data?.ABRPayloadSearchResults?.response;
          if (payload && !payload.exception) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const list = payload.searchResultsList?.searchResultsRecord as any[];
            if (list && list.length > 0) {
              abrResults = list.slice(0, input.limit).map((r) => ({
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
                abr_url: `https://abr.business.gov.au/ABN/View?abn=${r.ABN?.identifierValue ?? ''}`,
              }));
            }
          }
        }
      } catch (err) {
        log.warn({ err }, 'ABR name search failed');
      }

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'lookup_entity',
        query_text: singleId,
        result_count: abrResults.length,
        top_results: abrResults
          .filter((r) => r.entity_name)
          .slice(0, 3)
          .map((r) => ({ title: r.entity_name!, url: r.abr_url })),
      });

      if (abrResults.length === 0) {
        const obj = {
          query: singleId,
          result_count: 0,
          message: `No ABR records found matching "${singleId}". Search the ASIC register manually for company details.`,
          manual_url: ASIC_MANUAL_URL,
        };
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
        };
      }

      const obj = {
        query: singleId,
        source: 'abr',
        result_count: abrResults.length,
        results: abrResults,
        manual_url: ASIC_MANUAL_URL,
        pagination: {
          returned: abrResults.length,
          limit: input.limit ?? 10,
        },
      };
      return {
        structuredContent: obj,
        content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
      };
    },
  );
}
