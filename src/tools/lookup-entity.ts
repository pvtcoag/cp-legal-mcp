import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { externalFetch, ExternalApiError } from '../external-client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  identifier: z
    .string()
    .min(1)
    .max(200)
    .describe('ABN (e.g. "72 629 951 766"), ACN (e.g. "629 951 766"), or entity name to search'),
  identifier_type: z
    .enum(['abn', 'acn', 'name'])
    .optional()
    .describe(
      'Type of identifier. Omit to auto-detect: 11-digit strings → ABN, 9-digit → ACN, text → name search.',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this lookup in the research log.'),
});

function normaliseDigits(s: string): string {
  return s.replace(/[\s\-]/g, '');
}

function detectType(identifier: string): 'abn' | 'acn' | 'name' {
  const digits = normaliseDigits(identifier);
  if (/^\d{11}$/.test(digits)) return 'abn';
  if (/^\d{9}$/.test(digits)) return 'acn';
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

function parseEntity(entity: AbrBusinessEntity) {
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
    abn: entity.ABN?.identifierValue ?? null,
    abn_status: entity.ABN?.isCurrentIndicator === 'Y' ? 'current' : 'replaced',
    entity_name: name,
    entity_type: entity.entityType?.entityDescription ?? null,
    status: entity.entityStatus?.entityStatusCode ?? null,
    acn: entity.ASICNumber ?? null,
    gst_registered: gstRegistered,
    state: entity.mainBusinessPhysicalAddress?.stateCode ?? null,
    postcode: entity.mainBusinessPhysicalAddress?.postcode ?? null,
  };
}

export function registerLookupEntity(server: McpServer): void {
  server.tool(
    'lookup_entity',
    'Look up an Australian business entity by ABN, ACN, or name using the Australian Business Register (ABR). Returns entity name, type, registration status, GST registration, and state. Requires ABR_GUID to be configured — register for free at abr.business.gov.au/Tools/WebServices. Use for counterparty due diligence, conflicts checking, and entity verification.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'lookup_entity' });

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

      const idType = input.identifier_type ?? detectType(input.identifier);
      const digits = normaliseDigits(input.identifier);
      const guid = config.ABR_GUID;

      let url: string;
      if (idType === 'abn') {
        url = `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${encodeURIComponent(digits)}&guid=${encodeURIComponent(guid)}`;
      } else if (idType === 'acn') {
        url = `https://abr.business.gov.au/json/AcnDetails.aspx?acn=${encodeURIComponent(digits)}&guid=${encodeURIComponent(guid)}`;
      } else {
        url = `https://abr.business.gov.au/json/MatchingNames.aspx?name=${encodeURIComponent(input.identifier)}&guid=${encodeURIComponent(guid)}`;
      }

      let data: unknown;
      try {
        const res = await externalFetch(url);
        if (!res.ok) {
          log.warn({ status: res.status, url }, 'ABR API returned non-OK status');
          throw new ExternalApiError('ABR', `ABR API returned status ${res.status}`, res.status);
        }
        data = await res.json();
      } catch (err) {
        if (err instanceof ExternalApiError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'upstream_unavailable',
              message: 'The Australian Business Register is currently unavailable. Please try again shortly.',
              detail: err.message,
            }) }],
            isError: true,
          };
        }
        throw err;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = (data as any)?.ABRPayloadSearchResults?.response;
      if (!payload) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'parse_error',
            message: 'Unexpected response format from ABR API.',
          }) }],
          isError: true,
        };
      }

      if (payload.exception) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'not_found',
            message: `Entity not found in ABR: ${payload.exception?.exceptionDescription ?? 'unknown error'}`,
            identifier: input.identifier,
          }) }],
          isError: true,
        };
      }

      if (idType === 'name') {
        // Name search — may return array or single record
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = payload.searchResultsList?.searchResultsRecord as any[];
        if (!list || list.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'not_found',
              message: `No entities found matching "${input.identifier}".`,
            }) }],
            isError: true,
          };
        }
        const results = list.slice(0, 10).map((r) => ({
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

        recordMatterQuery({
          matter_ref: input.matter_ref,
          tool_name: 'lookup_entity',
          query_text: input.identifier,
          result_count: results.length,
          top_results: results
            .filter((r) => r.entity_name)
            .slice(0, 3)
            .map((r) => ({ title: r.entity_name!, url: `https://abr.business.gov.au/ABN/View?abn=${r.abn ?? ''}` })),
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            query: input.identifier,
            result_count: results.length,
            results,
          }) }],
        };
      }

      // ABN or ACN lookup — single entity
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entityKey = Object.keys(payload).find((k) => k.startsWith('businessEntity')) as string | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entity = entityKey ? (payload as any)[entityKey] as AbrBusinessEntity : null;

      if (!entity) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'not_found',
            message: `No entity found for ${idType.toUpperCase()} ${input.identifier}.`,
          }) }],
          isError: true,
        };
      }

      const parsed = parseEntity(entity);

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
          identifier_type: idType,
          ...parsed,
          abr_url: `https://abr.business.gov.au/ABN/View?abn=${parsed.abn ?? ''}`,
        }) }],
      };
    },
  );
}
