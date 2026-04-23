import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, matterRefSchema } from './_shared.js';
import { classifyText } from '../isaacus-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

// ── Category definitions ──────────────────────────────────────────────────────

const PRACTICE_AREAS = [
  {
    label: 'Negligence / Tort',
    description:
      'negligence, duty of care, tortious liability, personal injury, breach of duty, causation, contributory negligence, pure economic loss',
  },
  {
    label: 'Contract',
    description:
      'contract formation, breach of contract, contractual obligations, consideration, implied terms, commercial agreement, damages for breach, repudiation, frustration',
  },
  {
    label: 'Administrative Law',
    description:
      'administrative law, judicial review, statutory interpretation, public law, executive discretion, government decision making, delegated legislation, jurisdictional error',
  },
  {
    label: 'Constitutional Law',
    description:
      'constitutional law, constitutional validity, separation of powers, implied freedom of political communication, Commonwealth legislative power, characterisation of laws, Chapter III',
  },
  {
    label: 'Criminal Law',
    description:
      'criminal law, criminal liability, mens rea, actus reus, offence elements, prosecution, criminal procedure, sentencing, criminal responsibility, defence',
  },
  {
    label: 'Equity & Trusts',
    description:
      'equity, express trust, fiduciary duty, unconscionable conduct, equitable relief, constructive trust, breach of fiduciary duty, equitable estoppel, undue influence',
  },
  {
    label: 'Family Law',
    description:
      'family law, parenting orders, property settlement, matrimonial property, divorce, children, de facto relationship, family violence, best interests of child, Financial Agreement',
  },
  {
    label: 'Corporations & Commercial',
    description:
      'corporations, company law, directors duties, insolvency, shareholder rights, Corporations Act, corporate governance, winding up, receivership, oppression',
  },
  {
    label: 'Intellectual Property',
    description:
      'intellectual property, copyright infringement, trademark, patent, trade secret, passing off, designs, IP ownership, fair dealing',
  },
  {
    label: 'Employment & Industrial',
    description:
      'employment law, unfair dismissal, workplace relations, enterprise agreement, Fair Work Act, industrial dispute, discrimination in employment, redundancy, adverse action',
  },
  {
    label: 'Property & Conveyancing',
    description:
      'real property, land law, conveyancing, easement, restrictive covenant, mortgage, Torrens title, leasehold, adverse possession, strata title, indefeasibility',
  },
  {
    label: 'Evidence & Procedure',
    description:
      'evidence law, admissibility, procedural fairness, natural justice, court procedure, privilege, hearsay, expert evidence, uniform evidence legislation',
  },
] as const;

const PROCEEDING_TYPES = [
  {
    label: 'Appeal',
    description:
      'appeal from primary decision, appellate review, grounds of appeal, error of law or fact, leave to appeal granted, notice of appeal',
  },
  {
    label: 'First Instance / Trial',
    description:
      'trial at first instance, contested hearing on merits, liability determination, findings of fact, damages assessment, original jurisdiction',
  },
  {
    label: 'Judicial Review',
    description:
      'judicial review of administrative decision, certiorari, mandamus, ADJR Act, review of government or statutory authority action, prerogative writs',
  },
  {
    label: 'Interlocutory Application',
    description:
      'interlocutory injunction, urgent application, preliminary relief, stay pending appeal, ex parte order, Mareva order, search order',
  },
  {
    label: 'Special Leave',
    description:
      'special leave application to High Court, application for leave to appeal, special leave to appeal refused or granted, section 35A',
  },
] as const;

// ── Corporate intelligence categories ────────────────────────────────────────
// Classified separately from legal practice areas — captures research mandates
// that are primarily about entity/market intelligence rather than black-letter law.

const CORPORATE_CATEGORIES = [
  {
    label: 'Corporate Due Diligence',
    description:
      'company ownership, shareholders, corporate structure, entity verification, ABN, ACN, registered office, business registration, counterparty check, conflicts of interest, beneficial ownership',
  },
  {
    label: 'Director & Officer Research',
    description:
      'directors, officeholders, company officers, board composition, disqualified directors, former directors, director history, ASIC banning, appointment and cessation of officers',
  },
  {
    label: 'Regulatory Enforcement',
    description:
      'ASIC enforcement, ACCC investigation, regulatory action, banning order, enforceable undertaking, civil penalty, infringement notice, licence cancellation, compliance outcome',
  },
  {
    label: 'Competition & Merger',
    description:
      'merger clearance, ACCC review, informal merger assessment, competition law, market concentration, substantial lessening of competition, acquisitions, merger authorisation',
  },
  {
    label: 'Listed Company / ASX',
    description:
      'ASX announcement, continuous disclosure, market sensitive information, listed company, ASX listing rules, capital raising, securities, share price, annual report, investor presentation',
  },
] as const;

// ── Jurisdiction codes most likely to yield relevant results per area ─────────
const AREA_JURISDICTION_MAP: Record<string, string[]> = {
  'Negligence / Tort':         ['hca', 'nswca', 'vsca', 'qca', 'fcafc'],
  'Contract':                  ['hca', 'nswca', 'vsca', 'fcafc'],
  'Administrative Law':        ['hca', 'fcafc', 'fca', 'nswca'],
  'Constitutional Law':        ['hca', 'fcafc'],
  'Criminal Law':              ['hca', 'nswca', 'vsca', 'qca'],
  'Equity & Trusts':           ['hca', 'nswca', 'vsca', 'fcafc'],
  'Family Law':                ['hca', 'fcafc', 'fca'],
  'Corporations & Commercial': ['hca', 'fcafc', 'fca', 'nswca'],
  'Intellectual Property':     ['hca', 'fcafc', 'fca'],
  'Employment & Industrial':   ['hca', 'fcafc', 'fca'],
  'Property & Conveyancing':   ['nswca', 'nswsc', 'vsca', 'vsc', 'qca'],
  'Evidence & Procedure':      ['hca', 'fcafc', 'nswca', 'vsca'],
};

const DEFAULT_JURISDICTIONS = ['hca', 'fcafc', 'nswca'];

// ── Tool workflow suggestions per practice area ───────────────────────────────

interface ToolSuggestion {
  tool: string;
  purpose: string;
  suggested_params?: Record<string, unknown>;
}

const TOOL_WORKFLOW_MAP: Record<string, ToolSuggestion[]> = {
  'Negligence / Tort': [
    { tool: 'research_cases',      purpose: 'Find duty of care, causation, and damages case law',    suggested_params: { jurisdiction: 'hca' } },
    { tool: 'research_legislation', purpose: 'Civil liability legislation (state-specific)', suggested_params: { jurisdiction: 'nsw' } },
    { tool: 'summarise_judgment',   purpose: 'Structured overview of key cases found' },
  ],
  'Contract': [
    { tool: 'research_cases',       purpose: 'Contract formation, breach, and damages cases',         suggested_params: { jurisdiction: 'hca' } },
    { tool: 'research_legislation', purpose: 'Australian Consumer Law, Sale of Goods Act',           suggested_params: { jurisdiction: 'cth' } },
    { tool: 'summarise_judgment',   purpose: 'Structured overview of leading contract cases' },
  ],
  'Administrative Law': [
    { tool: 'research_cases',       purpose: 'Judicial review and statutory interpretation cases',   suggested_params: { jurisdiction: 'hca' } },
    { tool: 'research_legislation', purpose: 'ADJR Act, relevant enabling legislation',              suggested_params: { jurisdiction: 'cth' } },
    { tool: 'search_regulatory_decisions', purpose: 'Regulatory enforcement context if a regulator is involved', suggested_params: { regulator: 'all' } },
  ],
  'Constitutional Law': [
    { tool: 'research_cases',       purpose: 'High Court constitutional decisions',                  suggested_params: { jurisdiction: 'hca' } },
    { tool: 'research_legislation', purpose: 'Commonwealth legislation under challenge',             suggested_params: { jurisdiction: 'cth' } },
  ],
  'Criminal Law': [
    { tool: 'research_cases',       purpose: 'Criminal liability and sentencing decisions',          suggested_params: { jurisdiction: 'hca' } },
    { tool: 'research_legislation', purpose: 'Criminal Code, Crimes Act, relevant offence provisions', suggested_params: { jurisdiction: 'cth' } },
  ],
  'Equity & Trusts': [
    { tool: 'research_cases',       purpose: 'Fiduciary duty, constructive trust, and estoppel cases', suggested_params: { jurisdiction: 'hca' } },
    { tool: 'research_legislation', purpose: 'Trustee Acts and equitable property legislation',     suggested_params: { jurisdiction: 'nsw' } },
    { tool: 'find_related_cases',   purpose: 'Semantically similar cases on specific equitable doctrines' },
  ],
  'Family Law': [
    { tool: 'research_cases',       purpose: 'Parenting and property settlement decisions',          suggested_params: { jurisdiction: 'hca' } },
    { tool: 'research_legislation', purpose: 'Family Law Act 1975 and related instruments',         suggested_params: { jurisdiction: 'cth' } },
  ],
  'Corporations & Commercial': [
    { tool: 'research_cases',       purpose: 'Director duties, oppression, insolvency case law',    suggested_params: { jurisdiction: 'hca' } },
    { tool: 'research_legislation', purpose: 'Corporations Act 2001 provisions',                    suggested_params: { jurisdiction: 'cth' } },
    { tool: 'lookup_entity',        purpose: 'Verify entity registration, check directors and ASIC history', suggested_params: { include_officers: true } },
    { tool: 'search_regulatory_decisions', purpose: 'ASIC enforcement history for parties',        suggested_params: { regulator: 'asic' } },
  ],
  'Intellectual Property': [
    { tool: 'research_cases',       purpose: 'Copyright, trademark, and patent infringement cases', suggested_params: { jurisdiction: 'hca' } },
    { tool: 'research_legislation', purpose: 'Copyright Act, Trade Marks Act, Patents Act',        suggested_params: { jurisdiction: 'cth' } },
  ],
  'Employment & Industrial': [
    { tool: 'research_cases',       purpose: 'Unfair dismissal, adverse action, and enterprise agreement cases', suggested_params: { jurisdiction: 'hca' } },
    { tool: 'research_legislation', purpose: 'Fair Work Act 2009 and related instruments',         suggested_params: { jurisdiction: 'cth' } },
  ],
  'Property & Conveyancing': [
    { tool: 'research_cases',       purpose: 'Real property, easements, and Torrens title cases',  suggested_params: { jurisdiction: 'nswca' } },
    { tool: 'research_legislation', purpose: 'Real Property Act, Conveyancing Act (state-specific)', suggested_params: { jurisdiction: 'nsw' } },
  ],
  'Evidence & Procedure': [
    { tool: 'research_cases',       purpose: 'Admissibility, privilege, and procedural fairness cases', suggested_params: { jurisdiction: 'hca' } },
    { tool: 'research_legislation', purpose: 'Evidence Act (uniform evidence legislation)',        suggested_params: { jurisdiction: 'cth' } },
  ],
};

// Corporate intelligence workflow suggestions
const CORPORATE_WORKFLOW_MAP: Record<string, ToolSuggestion[]> = {
  'Corporate Due Diligence': [
    { tool: 'lookup_entity',        purpose: 'Verify entity registration (ABN, ACN, type, status)',  suggested_params: { include_officers: false } },
    { tool: 'search_regulatory_decisions', purpose: 'Check for ASIC enforcement history',           suggested_params: { regulator: 'asic' } },
    { tool: 'research_cases',       purpose: 'Case law involving the entity or related parties',    suggested_params: { jurisdiction: 'fca' } },
  ],
  'Director & Officer Research': [
    { tool: 'lookup_entity',        purpose: 'Retrieve current and former officeholders',           suggested_params: { include_officers: true } },
    { tool: 'search_regulatory_decisions', purpose: 'ASIC banning orders and enforcement actions against individuals', suggested_params: { regulator: 'asic', decision_type: 'banning_order' } },
    { tool: 'research_cases',       purpose: 'Litigation history involving named individuals',      suggested_params: { jurisdiction: 'fca' } },
  ],
  'Regulatory Enforcement': [
    { tool: 'search_regulatory_decisions', purpose: 'Search ASIC and ACCC enforcement registers',  suggested_params: { regulator: 'all' } },
    { tool: 'research_cases',       purpose: 'Case law from enforcement proceedings',              suggested_params: { jurisdiction: 'fca' } },
    { tool: 'research_legislation', purpose: 'Relevant provisions of ASIC Act, Corporations Act, or CCA', suggested_params: { jurisdiction: 'cth' } },
  ],
  'Competition & Merger': [
    { tool: 'search_regulatory_decisions', purpose: 'ACCC informal and formal merger assessments', suggested_params: { regulator: 'accc', decision_type: 'mergers_informal' } },
    { tool: 'research_cases',       purpose: 'Competition law and merger authorisation decisions', suggested_params: { jurisdiction: 'fca' } },
    { tool: 'research_legislation', purpose: 'Competition and Consumer Act 2010 (Part IV)',       suggested_params: { jurisdiction: 'cth' } },
  ],
  'Listed Company / ASX': [
    { tool: 'search_asx_announcements', purpose: 'Market-sensitive ASX announcements for the entity', suggested_params: { limit: 10 } },
    { tool: 'lookup_entity',        purpose: 'Verify entity and associated corporate group',       suggested_params: { include_officers: false } },
    { tool: 'search_regulatory_decisions', purpose: 'ASIC enforcement actions (continuous disclosure, market integrity)', suggested_params: { regulator: 'asic' } },
  ],
};

const DEFAULT_TOOLS: ToolSuggestion[] = [
  { tool: 'research_cases',       purpose: 'Search case law for the identified issue' },
  { tool: 'research_legislation', purpose: 'Find applicable legislation' },
];

// ── Tool ──────────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  text: z
    .string()
    .min(10)
    .max(2000)
    .describe(
      'Legal text, query, or issue description to classify. Can be a research question, a case excerpt, a legal problem description, a claim summary, or a matter description involving entities or corporate issues.',
    ),
  matter_ref: matterRefSchema,
});

export function registerClassifyLegalIssue(server: McpServer): void {
  registerTool(
    server,
    'classify_legal_issue',
    {
      title: 'Classify legal issue',
      description: '[Classification & Workflow] Classify a legal issue or matter description into Australian law practice areas, proceeding types, and corporate intelligence categories. ' +
    'Returns ranked classifications with confidence scores, suggested jurisdiction codes for research_cases, and a prioritised list of suggested tools with purpose and parameters for each research category. ' +
    'Covers both legal research workflows (cases, legislation, judgments) and entity intelligence workflows (ASIC register, ABR, ASX, regulatory decisions). ' +
    'Use as the first step on any new matter to identify the most relevant courts, practice areas, and research tools. ' +
    'Powered by zero-shot AI classification (Kanon Universal Classifier).',
      inputSchema: inputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const log = logger.child({ tool: 'classify_legal_issue' });

      const practiceDescriptions  = PRACTICE_AREAS.map((a) => a.description);
      const proceedingDescriptions = PROCEEDING_TYPES.map((p) => p.description);
      const corporateDescriptions  = CORPORATE_CATEGORIES.map((c) => c.description);

      let practiceClassification, proceedingClassification, corporateClassification;
      try {
        [practiceClassification, proceedingClassification, corporateClassification] = await Promise.all([
          classifyText(input.text, practiceDescriptions),
          classifyText(input.text, proceedingDescriptions),
          classifyText(input.text, corporateDescriptions),
        ]);
      } catch (err) {
        log.warn({ err }, 'Isaacus classification failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'classification_failed',
            message:
              'Could not classify the legal issue. Try using research_cases with your query directly.',
            detail: err instanceof Error ? err.message : String(err),
          }) }],
          isError: true,
        };
      }

      const totalTokens =
        practiceClassification.tokensUsed +
        proceedingClassification.tokensUsed +
        corporateClassification.tokensUsed;

      // Map description strings back to human-readable labels
      const practiceAreas = practiceClassification.results.map((r) => {
        const area = PRACTICE_AREAS.find((a) => a.description === r.category);
        return { area: area?.label ?? r.category, score: Math.round(r.score * 1000) / 1000 };
      });

      const proceedingTypes = proceedingClassification.results.map((r) => {
        const pt = PROCEEDING_TYPES.find((p) => p.description === r.category);
        return { type: pt?.label ?? r.category, score: Math.round(r.score * 1000) / 1000 };
      });

      const corporateCategories = corporateClassification.results.map((r) => {
        const cat = CORPORATE_CATEGORIES.find((c) => c.description === r.category);
        return { category: cat?.label ?? r.category, score: Math.round(r.score * 1000) / 1000 };
      });

      const primaryArea       = practiceAreas[0];
      const primaryCorporate  = corporateCategories[0];

      const suggestedJurisdictions = primaryArea
        ? (AREA_JURISDICTION_MAP[primaryArea.area] ?? DEFAULT_JURISDICTIONS)
        : DEFAULT_JURISDICTIONS;

      // Determine suggested tools:
      // - If the top corporate category score is high (≥ 0.5) and exceeds practice score, prefer corporate workflow
      // - Otherwise use legal practice workflow
      // - When both are strong (≥ 0.5), merge both sets (deduped by tool name, legal workflow first)
      const legalTools    = TOOL_WORKFLOW_MAP[primaryArea?.area ?? ''] ?? DEFAULT_TOOLS;
      const corporateTools = (primaryCorporate && primaryCorporate.score >= 0.5)
        ? (CORPORATE_WORKFLOW_MAP[primaryCorporate.category] ?? [])
        : [];

      let suggestedTools: ToolSuggestion[];
      const practiceScore  = primaryArea?.score ?? 0;
      const corporateScore = primaryCorporate?.score ?? 0;

      if (corporateScore >= 0.5 && corporateScore > practiceScore) {
        // Corporate-led: corporate tools first, then dedupe against legal tools
        const allTools = [...corporateTools, ...legalTools];
        const seen = new Set<string>();
        suggestedTools = allTools.filter((t) => {
          if (seen.has(t.tool)) return false;
          seen.add(t.tool);
          return true;
        });
      } else if (practiceScore >= 0.5 && corporateScore >= 0.5) {
        // Both strong: merge with legal first
        const allTools = [...legalTools, ...corporateTools];
        const seen = new Set<string>();
        suggestedTools = allTools.filter((t) => {
          if (seen.has(t.tool)) return false;
          seen.add(t.tool);
          return true;
        });
      } else {
        // Legal-led (default)
        suggestedTools = legalTools;
      }

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'classify_legal_issue',
        query_text: input.text.slice(0, 200),
        result_count: practiceAreas.length,
        top_results: [],
        api_tokens_used: totalTokens,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          input_text: input.text.length > 200 ? `${input.text.slice(0, 200)}…` : input.text,

          // Legal practice area classification
          primary_practice_area:  primaryArea?.area ?? null,
          primary_score:          primaryArea?.score ?? null,
          all_practice_areas:     practiceAreas,

          // Proceeding type classification
          primary_proceeding_type:  proceedingTypes[0]?.type ?? null,
          primary_proceeding_score: proceedingTypes[0]?.score ?? null,
          all_proceeding_types:     proceedingTypes,

          // Corporate / entity intelligence classification
          primary_corporate_category: primaryCorporate?.score ?? 0 >= 0.5 ? primaryCorporate?.category : null,
          primary_corporate_score:    primaryCorporate?.score ?? null,
          all_corporate_categories:   corporateCategories,

          // Research routing
          suggested_jurisdictions: suggestedJurisdictions,
          suggested_tools:         suggestedTools,

          note: 'Scores > 0.5 indicate a positive match. Use suggested_jurisdictions with research_cases and follow suggested_tools in order.',
        }) }],
      };
    },
  );
}
