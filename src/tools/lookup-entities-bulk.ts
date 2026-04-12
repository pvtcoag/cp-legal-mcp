import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { externalFetch } from '../external-client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

// ── Helpers (shared logic with lookup-entity, kept local to avoid coupling) ────

function normaliseDigits(s: string): string {
  return s.replace(/[\s\-]/g, '');
}

function detectType(identifier: string): 'abn' | 'acn' | 'name' {
  const digits = normaliseDigits(identifier);
  if (/^\d{11}$/.test(digits)) return 'abn';
  if (/^\d{9}$/.test(digits))  return 'acn';
  return 'name';
}

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
    abn:         entity.ABN?.identifierValue ?? null,
    abn_status:  entity.ABN?.isCurrentIndicator === 'Y' ? 'current' : 'replaced',
    entity_name: name,
    entity_type: entity.entityType?.entityDescription ?? null,
    status:      entity.entityStatus?.entityStatusCode ?? null,
    acn:         entity.ASICNumber ?? null,
    gst_registered: gstRegistered,
    state:    entity.mainBusinessPhysicalAddress?.stateCode ?? null,
    postcode: entity.mainBusinessPhysicalAddress?.postcode ?? null,
  };
}

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
    // Name search: return top result only
    url = `https://abr.business.gov.au/json/MatchingNames.aspx?name=${encodeURIComponent(identifier)}&guid=${encodeURIComponent(guid)}`;
  }

  try {
    const res = await externalFetch(url);
    if (!res.ok) {
      return { identifier, identifier_type: idType, error: 'upstream_error', message: `ABR returned status ${res.status}` };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any;
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
      // Return top match only for name searches
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

// ── Tool ──────────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  identifiers: z
    .array(z.string().min(1).max(200))
    .min(2)
    .max(10)
    .describe(
      'List of 2–10 ABNs, ACNs, or entity names to look up in parallel. ' +
      'Mixed types are supported — each identifier is auto-detected. ' +
      'Examples: ["72 629 951 766", "629 951 766", "Westpac Banking Corporation"]',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag these lookups in the research log.'),
});

export function registerLookupEntitiesBulk(server: McpServer): void {
  server.tool(
    'lookup_entities_bulk',
    '[Entity Intelligence] Look up multiple Australian business entities by ABN, ACN, or name in a single call. ' +
    'Runs up to 10 lookups in parallel against the Australian Business Register (ABR). ' +
    'Returns registration status, entity type, GST status, and ABR URL for each identifier. ' +
    'Requires ABR_GUID to be configured. ' +
    'Use for due diligence on multiple counterparties, corporate group mapping, and conflicts checks across multiple entities.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'lookup_entities_bulk', count: input.identifiers.length });

      if (!config.ABR_GUID) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'not_configured',
            message:
              'ABR_GUID is not configured. Register for a free GUID at https://abr.business.gov.au/Tools/WebServices ' +
              'and set it as the ABR_GUID environment variable.',
          }) }],
          isError: true,
        };
      }

      const guid = config.ABR_GUID;
      log.debug({ identifiers: input.identifiers }, 'bulk entity lookup starting');

      const results = await Promise.all(
        input.identifiers.map((id) => lookupOne(id, guid)),
      );

      const found   = results.filter((r) => !('error' in r)).length;
      const errors  = results.filter((r) => 'error' in r).length;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'lookup_entities_bulk',
        query_text: input.identifiers.join(', ').slice(0, 200),
        result_count: found,
        top_results: results
          .filter((r): r is Extract<typeof r, { entity_name: string | null }> => 'entity_name' in r && r.entity_name != null)
          .slice(0, 3)
          .map((r) => ({ title: r.entity_name!, url: (r as { abr_url: string }).abr_url })),
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          requested: input.identifiers.length,
          found,
          errors,
          results,
        }) }],
      };
    },
  );
}
