import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ── Limitation period data ─────────────────────────────────────────────────────
// Sources: NSW Limitation Act 1969, QLD Limitation of Actions Act 1974,
// VIC Limitation of Actions Act 1958, Federal ADJR Act, Fair Work Act 2009,
// Corporations Act 2001, Competition and Consumer Act 2010.
// Personal injury periods reflect discoverability regimes.

type FromBasis = 'accrual' | 'discoverability' | 'dismissal' | 'decision' | 'first_occurrence';

interface LimitationRule {
  years?: number;
  days?: number;
  // For personal injury / latent damage: short period from discoverability + long-stop
  long_stop_years?: number;
  from: FromBasis;
  act: string;
  section?: string;
  notes?: string;
  extension_available?: boolean;
}

type Jurisdiction = 'nsw' | 'qld' | 'vic' | 'sa' | 'wa' | 'tas' | 'act' | 'nt' | 'federal';
type CauseOfAction = typeof CAUSES_OF_ACTION[number]['value'];

const CAUSES_OF_ACTION = [
  { value: 'contract',              label: 'Contract (general)',             group: 'Contract' },
  { value: 'deed',                  label: 'Deed / Specialty contract',       group: 'Contract' },
  { value: 'debt',                  label: 'Debt / Recovery of money',        group: 'Contract' },
  { value: 'negligence_general',    label: 'Negligence (general tort)',        group: 'Tort' },
  { value: 'negligence_pi',         label: 'Negligence (personal injury)',     group: 'Tort' },
  { value: 'defamation',            label: 'Defamation',                      group: 'Tort' },
  { value: 'fraud',                 label: 'Fraud / Fraudulent concealment',  group: 'Tort' },
  { value: 'contribution',          label: 'Contribution between tortfeasors', group: 'Tort' },
  { value: 'property_recovery',     label: 'Recovery of land / property',     group: 'Property' },
  { value: 'judicial_review',       label: 'Judicial review (ADJR Act)',       group: 'Administrative' },
  { value: 'unfair_dismissal',      label: 'Unfair dismissal (Fair Work Act)', group: 'Employment' },
  { value: 'general_protections',   label: 'General protections (Fair Work)',  group: 'Employment' },
  { value: 'underpayment',          label: 'Underpayment of wages (Fair Work)', group: 'Employment' },
  { value: 'corporations_civil',    label: 'Civil penalty (Corporations Act)', group: 'Corporations' },
  { value: 'oppression',            label: 'Oppression remedy (Corporations Act s232)', group: 'Corporations' },
  { value: 'competition',           label: 'Competition / consumer law (CCA)', group: 'Competition' },
  { value: 'misleading_conduct',    label: 'Misleading or deceptive conduct (ACL)', group: 'Competition' },
] as const;

// Limitation rules keyed by [cause_of_action][jurisdiction]
// Jurisdictions not listed inherit the most common rule or indicate "no specific limit"
const RULES: Partial<Record<CauseOfAction, Partial<Record<Jurisdiction, LimitationRule>>>> = {

  contract: {
    nsw:     { years: 6, from: 'accrual',  act: 'Limitation Act 1969 (NSW)',          section: 's 14(1)(b)' },
    qld:     { years: 6, from: 'accrual',  act: 'Limitation of Actions Act 1974 (Qld)', section: 's 10(1)(a)' },
    vic:     { years: 6, from: 'accrual',  act: 'Limitation of Actions Act 1958 (Vic)', section: 's 5(1)(a)' },
    sa:      { years: 6, from: 'accrual',  act: 'Limitation of Actions Act 1936 (SA)', section: 's 35' },
    wa:      { years: 6, from: 'accrual',  act: 'Limitation Act 2005 (WA)',             section: 's 13' },
    federal: { years: 6, from: 'accrual',  act: 'Limitation Act 1953 (Cth)',            section: 's 21' },
  },

  deed: {
    nsw:     { years: 12, from: 'accrual', act: 'Limitation Act 1969 (NSW)',           section: 's 16' },
    qld:     { years: 12, from: 'accrual', act: 'Limitation of Actions Act 1974 (Qld)', section: 's 10(3)' },
    vic:     { years: 15, from: 'accrual', act: 'Limitation of Actions Act 1958 (Vic)', section: 's 5(3)' },
    sa:      { years: 15, from: 'accrual', act: 'Limitation of Actions Act 1936 (SA)', section: 's 35' },
    wa:      { years: 12, from: 'accrual', act: 'Limitation Act 2005 (WA)',             section: 's 14' },
    federal: { years: 12, from: 'accrual', act: 'Limitation Act 1953 (Cth)',            section: 's 21' },
  },

  debt: {
    nsw:     { years: 6, from: 'accrual', act: 'Limitation Act 1969 (NSW)',            section: 's 14(1)(b)' },
    qld:     { years: 6, from: 'accrual', act: 'Limitation of Actions Act 1974 (Qld)', section: 's 10(1)(a)' },
    vic:     { years: 6, from: 'accrual', act: 'Limitation of Actions Act 1958 (Vic)', section: 's 5(1)(a)' },
    federal: { years: 6, from: 'accrual', act: 'Limitation Act 1953 (Cth)',             section: 's 21' },
  },

  negligence_general: {
    nsw:     { years: 6, from: 'accrual', act: 'Limitation Act 1969 (NSW)',             section: 's 14(1)(b)', notes: 'Accrues when damage is suffered. Latent property damage may benefit from discoverability under s 14(1)(c).' },
    qld:     { years: 6, from: 'accrual', act: 'Limitation of Actions Act 1974 (Qld)',  section: 's 10(1)(a)' },
    vic:     { years: 6, from: 'accrual', act: 'Limitation of Actions Act 1958 (Vic)',  section: 's 5(1)(a)' },
    sa:      { years: 6, from: 'accrual', act: 'Limitation of Actions Act 1936 (SA)',   section: 's 35' },
    wa:      { years: 6, from: 'accrual', act: 'Limitation Act 2005 (WA)',              section: 's 13' },
    federal: { years: 6, from: 'accrual', act: 'Limitation Act 1953 (Cth)',             section: 's 21' },
  },

  negligence_pi: {
    nsw: {
      years: 3, long_stop_years: 12,
      from: 'discoverability',
      act: 'Limitation Act 1969 (NSW)',
      section: 'ss 18A, 62A',
      notes: '3 years from date the cause of action was discoverable (or reasonably discoverable). 12-year long-stop from act or omission. Court may extend under s 60G.',
      extension_available: true,
    },
    qld: {
      years: 3, long_stop_years: 12,
      from: 'discoverability',
      act: 'Limitation of Actions Act 1974 (Qld)',
      section: 'ss 11, 31',
      notes: '3 years from accrual (generally date of injury). Late notice application available under s 31. Court may allow out-of-time claims.',
      extension_available: true,
    },
    vic: {
      years: 3, long_stop_years: 12,
      from: 'discoverability',
      act: 'Limitation of Actions Act 1958 (Vic)',
      section: 'Part IIA',
      notes: '3 years from date of discoverability. 12-year long-stop. Courts have broad extension discretion.',
      extension_available: true,
    },
    sa: {
      years: 3, long_stop_years: 12,
      from: 'discoverability',
      act: 'Limitation of Actions Act 1936 (SA)',
      section: 'ss 36–48',
      extension_available: true,
    },
    wa: {
      years: 3,
      from: 'discoverability',
      act: 'Limitation Act 2005 (WA)',
      section: 'ss 14, 55',
      extension_available: true,
    },
    federal: {
      years: 3,
      from: 'discoverability',
      act: 'Limitation Act 1953 (Cth)',
      section: 's 21',
      notes: 'Federal personal injury claims are rare. State limitation law typically applies via s 79 Judiciary Act 1903 (Cth).',
    },
  },

  defamation: {
    nsw:     { years: 1, from: 'first_occurrence', act: 'Defamation Act 2005 (NSW)',  section: 's 14B (via Limitation Act 1969 s 14C)', notes: '1 year from publication. Single publication rule: for online/digital content, period runs from first publication. Extension available in limited circumstances.', extension_available: true },
    qld:     { years: 1, from: 'first_occurrence', act: 'Defamation Act 2005 (Qld)',  section: 's 10AA (via Limitation of Actions Act 1974)', extension_available: true },
    vic:     { years: 1, from: 'first_occurrence', act: 'Defamation Act 2005 (Vic)',  section: 'Limitation of Actions Act 1958 Pt IA', extension_available: true },
    sa:      { years: 1, from: 'first_occurrence', act: 'Defamation Act 2005 (SA)',   extension_available: true },
    wa:      { years: 1, from: 'first_occurrence', act: 'Defamation Act 2005 (WA)',   extension_available: true },
    federal: { years: 1, from: 'first_occurrence', act: 'Defamation Act 2005 (uniform model law)', notes: 'Defamation law is state-based. There is no federal cause of action in defamation.' },
  },

  fraud: {
    nsw: {
      years: 6, from: 'discoverability',
      act: 'Limitation Act 1969 (NSW)',
      section: 's 55',
      notes: 'For claims based on fraud, time does not run until the plaintiff discovers (or could reasonably have discovered) the fraud.',
    },
    qld: {
      years: 6, from: 'discoverability',
      act: 'Limitation of Actions Act 1974 (Qld)',
      section: 's 38',
      notes: 'Fraud exception defers the limitation period until discovery of the fraud.',
    },
    vic: {
      years: 6, from: 'discoverability',
      act: 'Limitation of Actions Act 1958 (Vic)',
      section: 's 27',
    },
    federal: {
      years: 6, from: 'discoverability',
      act: 'Limitation Act 1953 (Cth)',
      section: 's 30',
    },
  },

  contribution: {
    nsw:     { years: 2, from: 'accrual', act: 'Limitation Act 1969 (NSW)',             section: 's 26B', notes: '2 years from the date judgment is given or any settlement or compromise is agreed.' },
    qld:     { years: 2, from: 'accrual', act: 'Law Reform Act 1995 (Qld)',              section: 's 7(3)' },
    vic:     { years: 2, from: 'accrual', act: 'Wrongs Act 1958 (Vic)',                  section: 's 24(3)' },
    federal: { years: 2, from: 'accrual', act: 'Proportionate Liability (federal claims)', notes: 'Contribution period generally mirrors applicable state law.' },
  },

  property_recovery: {
    nsw:     { years: 12, from: 'accrual', act: 'Limitation Act 1969 (NSW)',              section: 's 27(2)' },
    qld:     { years: 12, from: 'accrual', act: 'Limitation of Actions Act 1974 (Qld)',   section: 's 13(2)' },
    vic:     { years: 15, from: 'accrual', act: 'Limitation of Actions Act 1958 (Vic)',   section: 's 8' },
    sa:      { years: 15, from: 'accrual', act: 'Real Property Act 1886 (SA)',             section: 's 204' },
    wa:      { years: 12, from: 'accrual', act: 'Limitation Act 2005 (WA)',               section: 's 20' },
    federal: { years: 12, from: 'accrual', act: 'Limitation Act 1953 (Cth)',               section: 's 21' },
  },

  judicial_review: {
    federal: {
      days: 28, from: 'decision',
      act: 'Administrative Decisions (Judicial Review) Act 1977 (Cth)',
      section: 's 11(3)',
      notes: '28 days from the decision date or notification of the decision. Court has discretion to extend under s 11(1)(c).',
      extension_available: true,
    },
    nsw: {
      days: 28, from: 'decision',
      act: 'Administrative Decisions Review Act 1997 (NSW) / Judicial Review Act',
      notes: 'NSW Supreme Court judicial review is exercised under common law prerogative writs and the Civil Procedure Act. No fixed limitation period — courts apply promptness principles.',
      extension_available: true,
    },
    qld: {
      days: 28, from: 'decision',
      act: 'Judicial Review Act 1991 (Qld)',
      section: 's 39',
      notes: '28 days from the decision or notification. Court may extend.',
      extension_available: true,
    },
    vic: {
      from: 'decision',
      act: 'Administrative Law Act 1978 (Vic)',
      notes: 'No fixed statutory period. Apply promptly — courts may decline relief where there is undue delay.',
      extension_available: true,
    },
  },

  unfair_dismissal: {
    federal: {
      days: 21, from: 'dismissal',
      act: 'Fair Work Act 2009 (Cth)',
      section: 's 394(2)',
      notes: '21 days from the day the dismissal takes effect. FWC may extend in exceptional circumstances under s 394(3).',
      extension_available: true,
    },
  },

  general_protections: {
    federal: {
      days: 21, from: 'dismissal',
      act: 'Fair Work Act 2009 (Cth)',
      section: 's 366(1)',
      notes: '21 days from the day the dismissal takes effect (for dismissal disputes). FWC may extend under s 366(2).',
      extension_available: true,
    },
  },

  underpayment: {
    federal: {
      years: 6, from: 'accrual',
      act: 'Fair Work Act 2009 (Cth)',
      section: 'ss 544–545',
      notes: '6 years for civil penalty / underpayment recovery. Each pay period gives rise to a separate cause of action.',
    },
    nsw: {
      years: 6, from: 'accrual',
      act: 'Limitation Act 1969 (NSW)',
      section: 's 14(1)(b)',
      notes: 'State award / industrial instrument claims follow standard contract period.',
    },
  },

  corporations_civil: {
    federal: {
      years: 6, from: 'accrual',
      act: 'Corporations Act 2001 (Cth)',
      section: 's 1317K',
      notes: '6 years from the contravention for civil penalty proceedings commenced by ASIC or APRA. Private parties relying on derivative civil penalty claims may be subject to different periods.',
    },
  },

  oppression: {
    federal: {
      from: 'accrual',
      act: 'Corporations Act 2001 (Cth)',
      section: 'ss 232–235',
      notes: 'No fixed limitation period. Equitable principles apply. Delay (laches) may bar relief. Courts expect prompt action once the shareholder becomes aware of the conduct. Generally should not delay beyond 6 years.',
      extension_available: false,
    },
  },

  competition: {
    federal: {
      years: 6, from: 'accrual',
      act: 'Competition and Consumer Act 2010 (Cth)',
      section: 's 82(2)',
      notes: '6 years from the date the cause of action accrues (typically when the anti-competitive conduct first caused loss).',
    },
  },

  misleading_conduct: {
    federal: {
      years: 6, from: 'accrual',
      act: 'Australian Consumer Law (Sch 2, Competition and Consumer Act 2010 (Cth))',
      section: 's 236(2)',
      notes: '6 years from when the cause of action accrues. Accrual is generally when the loss first occurs, which may differ from when the misleading conduct occurred.',
    },
    nsw: {
      years: 6, from: 'accrual',
      act: 'Australian Consumer Law (NSW) via Fair Trading Act 1987 (NSW)',
      section: 's 68',
      notes: 'Same as federal ACL. State-based claims for misleading conduct follow the 6-year period.',
    },
    qld: {
      years: 6, from: 'accrual',
      act: 'Australian Consumer Law (Qld) via Fair Trading Act 1989 (Qld)',
      section: 's 50A',
    },
    vic: {
      years: 6, from: 'accrual',
      act: 'Australian Consumer Law (Vic) via Australian Consumer Law and Fair Trading Act 2012 (Vic)',
    },
  },
};

// ── Date arithmetic ────────────────────────────────────────────────────────────

function addYears(date: Date, years: number): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysUntil(date: Date, from: Date): number {
  return Math.round((date.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

// ── Tool ──────────────────────────────────────────────────────────────────────

const causeOfActionValues = CAUSES_OF_ACTION.map((c) => c.value) as [CauseOfAction, ...CauseOfAction[]];
const jurisdictionValues: [Jurisdiction, ...Jurisdiction[]] = ['nsw', 'qld', 'vic', 'sa', 'wa', 'tas', 'act', 'nt', 'federal'];

const inputSchema = z.object({
  cause_of_action: z
    .enum(causeOfActionValues)
    .describe(
      'The type of cause of action. ' +
      CAUSES_OF_ACTION.map((c) => `${c.value} — ${c.label}`).join(' | '),
    ),
  jurisdiction: z
    .enum(jurisdictionValues)
    .describe('The jurisdiction where the claim would be brought'),
  date_of_accrual: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      'ISO date (YYYY-MM-DD) when the cause of action accrued. ' +
      'For personal injury: date of discovery/awareness. ' +
      'For employment: date dismissal took effect. ' +
      'For judicial review: date of the decision. ' +
      'If provided, expiry date and urgency are calculated.',
    ),
});

export function registerCheckLimitationPeriod(server: McpServer): void {
  server.tool(
    'check_limitation_period',
    '[Matter] Look up the limitation period for a cause of action by jurisdiction. ' +
    'Returns the period length, governing Act, relevant section, and (if date_of_accrual is provided) ' +
    'the calculated expiry date and days remaining. ' +
    'Covers NSW, QLD, VIC, SA, WA, and Federal causes of action including contract, tort, personal injury, defamation, ' +
    'Fair Work claims, ADJR judicial review, Corporations Act civil penalties, and ACL/competition claims. ' +
    'Use as a first step in any time-sensitive matter or crisis situation.',
    inputSchema.shape,
    (input) => {
      const causeEntry = CAUSES_OF_ACTION.find((c) => c.value === input.cause_of_action);
      const rulesForCause = RULES[input.cause_of_action as CauseOfAction];

      const rule: LimitationRule | undefined =
        rulesForCause?.[input.jurisdiction as Jurisdiction] ??
        rulesForCause?.['federal'];  // Federal as fallback for some causes

      if (!rule) {
        const availableJurisdictions = rulesForCause
          ? Object.keys(rulesForCause).join(', ')
          : 'none';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'not_found',
            cause_of_action: input.cause_of_action,
            jurisdiction: input.jurisdiction,
            message:
              `No limitation period data available for "${causeEntry?.label ?? input.cause_of_action}" ` +
              `in ${input.jurisdiction.toUpperCase()}. ` +
              (availableJurisdictions !== 'none'
                ? `Data available for: ${availableJurisdictions}.`
                : 'Consult a legal practitioner or the applicable state Limitation Act.'),
          }) }],
        };
      }

      // Build response
      const periodDescription = rule.days != null
        ? `${rule.days} days`
        : rule.years != null
          ? `${rule.years} year${rule.years === 1 ? '' : 's'}`
          : 'No fixed period (equitable principles apply)';

      const longStopDescription = rule.long_stop_years != null
        ? `${rule.long_stop_years}-year long-stop from act or omission`
        : null;

      // Expiry calculation
      let expiry: { expiry_date: string; days_remaining: number; urgent: boolean; long_stop_date?: string } | null = null;

      if (input.date_of_accrual) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const accrual = new Date(input.date_of_accrual);

        let expiryDate: Date;
        if (rule.days != null) {
          expiryDate = addDays(accrual, rule.days);
        } else if (rule.years != null) {
          expiryDate = addYears(accrual, rule.years);
        } else {
          expiryDate = addYears(accrual, 6); // Conservative default for no-fixed-period
        }

        const remaining = daysUntil(expiryDate, today);
        const longStopDate = rule.long_stop_years != null
          ? formatDate(addYears(accrual, rule.long_stop_years))
          : undefined;

        expiry = {
          expiry_date: formatDate(expiryDate),
          days_remaining: remaining,
          urgent: remaining >= 0 && remaining <= 60,
          ...(longStopDate ? { long_stop_date: longStopDate } : {}),
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          cause_of_action: causeEntry?.label ?? input.cause_of_action,
          group: causeEntry?.group ?? null,
          jurisdiction: input.jurisdiction.toUpperCase(),
          period: periodDescription,
          ...(longStopDescription ? { long_stop: longStopDescription } : {}),
          runs_from: rule.from,
          governing_act: rule.act,
          ...(rule.section ? { section: rule.section } : {}),
          ...(rule.notes ? { notes: rule.notes } : {}),
          ...(rule.extension_available != null ? { extension_available: rule.extension_available } : {}),
          ...(expiry ? { expiry_calculation: expiry } : {}),
          disclaimer:
            'This is a reference guide only. Limitation periods are fact-specific — ' +
            'verify against the current Act and seek legal advice before relying on this information.',
        }) }],
      };
    },
  );
}
