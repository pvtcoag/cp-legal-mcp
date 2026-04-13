import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ── Filing deadline data ───────────────────────────────────────────────────────
// Sources: UCPR (NSW), UCPR (Qld), Federal Court Rules 2011,
// Federal Circuit and Family Court Rules 2021, Court of Appeal Act 1984 (Qld).

interface FilingRule {
  days: number;           // calendar days (unless court_days: true)
  court_days?: boolean;   // if true, days are business/court days not calendar
  from: string;           // human-readable description of trigger event
  rule: string;           // rule citation
  notes?: string;
}

type FilingJurisdiction = 'nsw' | 'qld' | 'federal' | 'fcfcoa';
type ProceedingType = typeof PROCEEDING_TYPES[number]['value'];

const PROCEEDING_TYPES = [
  { value: 'defence',            label: 'Defence (response to statement of claim / originating process)' },
  { value: 'response',           label: 'Response to originating application (Federal Court)' },
  { value: 'reply',              label: 'Reply to defence' },
  { value: 'appeal_notice',      label: 'Notice of appeal / application for leave to appeal' },
  { value: 'summary_judgment',   label: 'Application for summary judgment' },
  { value: 'discovery',          label: 'Response to discovery / list of documents' },
  { value: 'interrogatories',    label: 'Responses to interrogatories' },
  { value: 'subpoena_objection', label: 'Objection to subpoena' },
] as const;

// Filing rules keyed by [proceeding_type][jurisdiction] → FilingRule
const FILING_RULES: Record<ProceedingType, Record<FilingJurisdiction, FilingRule>> = {

  defence: {
    nsw:     { days: 28, from: 'date of service', rule: 'UCPR (NSW) r 14.3(1)' },
    qld:     { days: 28, from: 'date of service', rule: 'UCPR (Qld) r 136(1)' },
    federal: { days: 28, from: 'date of service', rule: 'Federal Court Rules 2011 r 16.32(2)' },
    fcfcoa:  { days: 28, from: 'date of service', rule: 'Federal Circuit and Family Court Rules 2021 r 6.03' },
  },

  response: {
    nsw:     { days: 28, from: 'date of service', rule: 'UCPR (NSW) r 6.9', notes: 'Response to originating process' },
    qld:     { days: 28, from: 'date of service', rule: 'UCPR (Qld) r 136(1)' },
    federal: { days: 21, from: 'date of service', rule: 'Federal Court Rules 2011 r 5.02(2)' },
    fcfcoa:  { days: 28, from: 'date of service', rule: 'Federal Circuit and Family Court Rules 2021 r 6.03' },
  },

  reply: {
    nsw:     { days: 14, from: 'date defence filed/served', rule: 'UCPR (NSW) r 14.11(1)' },
    qld:     { days: 14, from: 'date defence filed',        rule: 'UCPR (Qld) r 178(1)' },
    federal: { days: 14, from: 'date defence filed',        rule: 'Federal Court Rules 2011 r 16.55(2)' },
    fcfcoa:  { days: 14, from: 'date defence filed',        rule: 'Federal Circuit and Family Court Rules 2021 r 6.06' },
  },

  appeal_notice: {
    nsw:     { days: 28, from: 'date of judgment/order appealed', rule: 'Court of Appeal Rules / UCPR (NSW) r 51.9' },
    qld:     { days: 28, from: 'date of judgment',                rule: 'Court of Appeal Act 1984 (Qld) s 26 / UCPR (Qld) r 747' },
    federal: { days: 21, from: 'date of judgment',                rule: 'Federal Court Rules 2011 r 36.03(1)' },
    fcfcoa:  { days: 28, from: 'date of judgment',                rule: 'Federal Circuit and Family Court Rules 2021 r 13.06' },
  },

  summary_judgment: {
    nsw:     { days: 14, from: 'hearing date (serve at least 14 days before)', rule: 'UCPR (NSW) r 13.3(2)',              notes: '14 days notice required' },
    qld:     { days: 5,  from: 'hearing date (serve at least 5 court days before)', rule: 'UCPR (Qld) r 292(1)',          court_days: true, notes: '5 court days notice required' },
    federal: { days: 5,  from: 'hearing date (serve at least 5 court days before)', rule: 'Federal Court Rules 2011 r 26.01', court_days: true, notes: '5 court days notice required' },
    fcfcoa:  { days: 14, from: 'hearing date (serve at least 14 days before)', rule: 'Federal Circuit and Family Court Rules 2021', notes: '14 days notice required' },
  },

  discovery: {
    nsw:     { days: 28, from: 'date of order', rule: 'UCPR (NSW) r 21.4' },
    qld:     { days: 28, from: 'date of order', rule: 'UCPR (Qld) r 221(1)' },
    federal: { days: 0,  from: 'date specified by court order', rule: 'Federal Court Rules 2011 r 20.14', notes: 'Deadline set by court order — no default period' },
    fcfcoa:  { days: 28, from: 'date of order', rule: 'Federal Circuit and Family Court Rules 2021' },
  },

  interrogatories: {
    nsw:     { days: 28, from: 'date of service', rule: 'UCPR (NSW) r 22.6(1)' },
    qld:     { days: 28, from: 'date of service', rule: 'UCPR (Qld) r 236(1)' },
    federal: { days: 14, from: 'date of service', rule: 'Federal Court Rules 2011 r 21.03', notes: 'Or as ordered' },
    fcfcoa:  { days: 28, from: 'date of service', rule: 'Federal Circuit and Family Court Rules 2021' },
  },

  subpoena_objection: {
    nsw:     { days: 0, from: 'return date (file and serve before return date)', rule: 'UCPR (NSW) r 33.4', notes: 'File and serve before return date' },
    qld:     { days: 5, from: 'return date (5 court days before)',              rule: 'UCPR (Qld) r 394B(1)',                         court_days: true },
    federal: { days: 3, from: 'return date (3 court days before)',              rule: 'Federal Court Rules 2011 r 24.19',              court_days: true },
    fcfcoa:  { days: 3, from: 'return date (3 court days before)',              rule: 'Federal Circuit and Family Court Rules 2021 r 11.09', court_days: true },
  },

};

// ── Date parsing & arithmetic ──────────────────────────────────────────────────

/** Parse ISO (YYYY-MM-DD) or DD/MM/YYYY → Date, or null if invalid. */
function parseEventDate(raw: string): Date | null {
  // ISO 8601: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(raw + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }
  // DD/MM/YYYY
  const ddmm = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmm) {
    const [, dd, mm, yyyy] = ddmm;
    const d = new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00`);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function addCalendarDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysRemaining(deadlineDate: Date, today: Date): number {
  return Math.round((deadlineDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

// ── Tool ──────────────────────────────────────────────────────────────────────

const proceedingTypeValues = PROCEEDING_TYPES.map((p) => p.value) as [ProceedingType, ...ProceedingType[]];
const jurisdictionValues: [FilingJurisdiction, ...FilingJurisdiction[]] = ['nsw', 'qld', 'federal', 'fcfcoa'];

const inputSchema = z.object({
  proceeding_type: z
    .enum(proceedingTypeValues)
    .describe(
      'The type of filing deadline. ' +
      PROCEEDING_TYPES.map((p) => `${p.value} — ${p.label}`).join(' | '),
    ),
  jurisdiction: z
    .enum(jurisdictionValues)
    .describe(
      'The court jurisdiction: nsw (NSW Supreme/District/Local Court), ' +
      'qld (QLD Supreme/District/Magistrates Court), ' +
      'federal (Federal Court of Australia), ' +
      'fcfcoa (Federal Circuit and Family Court of Australia)',
    ),
  event_date: z
    .string()
    .optional()
    .describe(
      'The triggering event date in ISO 8601 (YYYY-MM-DD) or DD/MM/YYYY format — ' +
      'e.g. the date of service, date of judgment, or date of the order. ' +
      'If provided, the actual deadline date and days remaining are calculated.',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Optional matter reference for tracking purposes (max 100 characters).'),
});

export function registerCheckFilingDeadline(server: McpServer): void {
  server.tool(
    'check_filing_deadline',
    '[Matter] Calculate court filing deadlines based on proceeding type and jurisdiction. ' +
    'Returns the applicable rule, day count, trigger event description, and (if event_date is provided) ' +
    'the calculated deadline date and days remaining. ' +
    'Covers NSW, QLD, Federal Court, and FCFCOA for defence, response, reply, appeal notices, ' +
    'summary judgment, discovery, interrogatories, and subpoena objections. ' +
    'Use for any time-sensitive procedural step to confirm the filing window.',
    inputSchema.shape,
    (input) => {
      const proceedingEntry = PROCEEDING_TYPES.find((p) => p.value === input.proceeding_type);
      const rule = FILING_RULES[input.proceeding_type as ProceedingType][input.jurisdiction as FilingJurisdiction];

      // Build deadline calculation if event_date supplied
      let deadline_calculation:
        | {
            event_date: string;
            deadline_date: string;
            days_remaining: number;
            urgent: boolean;
            overdue: boolean;
            court_days_note?: string;
          }
        | undefined;

      if (input.event_date) {
        const eventDate = parseEventDate(input.event_date);
        if (!eventDate) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'invalid_date',
                message: `Could not parse event_date "${input.event_date}". Use ISO 8601 (YYYY-MM-DD) or DD/MM/YYYY format.`,
              }),
            }],
          };
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // If no fixed day count (days === 0), skip deadline date calculation
        if (rule.days > 0) {
          const deadlineDate = addCalendarDays(eventDate, rule.days);
          const remaining = daysRemaining(deadlineDate, today);

          deadline_calculation = {
            event_date: formatIsoDate(eventDate),
            deadline_date: formatIsoDate(deadlineDate),
            days_remaining: remaining,
            urgent: remaining >= 0 && remaining <= 7,
            overdue: remaining < 0,
            ...(rule.court_days
              ? { court_days_note: 'This deadline is measured in court/business days, not calendar days. The calculated date uses calendar days as an approximation — verify against the court calendar.' }
              : {}),
          };
        } else {
          // days === 0 means no fixed period (e.g. discovery/federal, subpoena_objection/nsw)
          deadline_calculation = {
            event_date: formatIsoDate(eventDate),
            deadline_date: 'N/A — no fixed calendar period',
            days_remaining: 0,
            urgent: false,
            overdue: false,
          };
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            proceeding_type: proceedingEntry?.label ?? input.proceeding_type,
            jurisdiction: input.jurisdiction.toUpperCase(),
            rule: {
              days: rule.days,
              ...(rule.court_days ? { court_days: true } : {}),
              from: rule.from,
              rule: rule.rule,
              ...(rule.notes ? { notes: rule.notes } : {}),
            },
            ...(deadline_calculation ? { deadline_calculation } : {}),
            disclaimer: 'Verify deadlines with applicable court rules and practice notes before relying on them.',
          }),
        }],
      };
    },
  );
}
