import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

// Jurisdiction codes most likely to yield relevant results per practice area
const AREA_JURISDICTION_MAP: Record<string, string[]> = {
  'Negligence / Tort':        ['hca', 'nswca', 'vsca', 'qca', 'fcafc'],
  'Contract':                 ['hca', 'nswca', 'vsca', 'fcafc'],
  'Administrative Law':       ['hca', 'fcafc', 'fca', 'nswca'],
  'Constitutional Law':       ['hca', 'fcafc'],
  'Criminal Law':             ['hca', 'nswca', 'vsca', 'qca'],
  'Equity & Trusts':          ['hca', 'nswca', 'vsca', 'fcafc'],
  'Family Law':               ['hca', 'fcafc', 'fca'],
  'Corporations & Commercial':['hca', 'fcafc', 'fca', 'nswca'],
  'Intellectual Property':    ['hca', 'fcafc', 'fca'],
  'Employment & Industrial':  ['hca', 'fcafc', 'fca'],
  'Property & Conveyancing':  ['nswca', 'nswsc', 'vsca', 'vsc', 'qca'],
  'Evidence & Procedure':     ['hca', 'fcafc', 'nswca', 'vsca'],
};

const DEFAULT_JURISDICTIONS = ['hca', 'fcafc', 'nswca'];

// ── Tool ──────────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  text: z
    .string()
    .min(10)
    .max(2000)
    .describe(
      'Legal text, query, or issue description to classify. Can be a research question, a case excerpt, a legal problem description, or a claim summary.',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Matter reference to tag this classification in the research log. If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.',
    ),
});

export function registerClassifyLegalIssue(server: McpServer): void {
  server.tool(
    'classify_legal_issue',
    'Classify a legal issue, query, or text passage into Australian law practice areas and proceeding types using zero-shot AI classification (Kanon Universal Classifier). Returns ranked practice areas and proceeding types with confidence scores, and suggests jurisdiction codes to use with research_cases. Ideal as a first step when starting research on a new legal issue to identify the most relevant courts and practice areas.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'classify_legal_issue' });

      const practiceDescriptions = PRACTICE_AREAS.map((a) => a.description);
      const proceedingDescriptions = PROCEEDING_TYPES.map((p) => p.description);

      let practiceResults, proceedingResults;
      try {
        [practiceResults, proceedingResults] = await Promise.all([
          classifyText(input.text, practiceDescriptions),
          classifyText(input.text, proceedingDescriptions),
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

      // Map description strings back to human-readable labels
      const practiceAreas = practiceResults.map((r) => {
        const area = PRACTICE_AREAS.find((a) => a.description === r.category);
        return { area: area?.label ?? r.category, score: Math.round(r.score * 1000) / 1000 };
      });

      const proceedingTypes = proceedingResults.map((r) => {
        const pt = PROCEEDING_TYPES.find((p) => p.description === r.category);
        return { type: pt?.label ?? r.category, score: Math.round(r.score * 1000) / 1000 };
      });

      const primaryArea = practiceAreas[0];
      const suggestedJurisdictions = primaryArea
        ? (AREA_JURISDICTION_MAP[primaryArea.area] ?? DEFAULT_JURISDICTIONS)
        : DEFAULT_JURISDICTIONS;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'classify_legal_issue',
        query_text: input.text.slice(0, 200),
        result_count: practiceAreas.length,
        top_results: [],
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          input_text: input.text.length > 200 ? `${input.text.slice(0, 200)}…` : input.text,
          primary_practice_area: primaryArea?.area ?? null,
          primary_score: primaryArea?.score ?? null,
          all_practice_areas: practiceAreas,
          primary_proceeding_type: proceedingTypes[0]?.type ?? null,
          primary_proceeding_score: proceedingTypes[0]?.score ?? null,
          all_proceeding_types: proceedingTypes,
          suggested_jurisdictions: suggestedJurisdictions,
          note: 'Scores > 0.5 indicate a positive match. Use suggested_jurisdictions with research_cases.',
        }, null, 2) }],
      };
    },
  );
}
