import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMatterHistory, getCachedJudgmentsByUrls, isDbEnabled } from '../db.js';
import { extractAnswer } from '../isaacus-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

// ── Tool ──────────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  matter_ref: z
    .string()
    .min(1)
    .max(100)
    .describe('Matter reference to compile research for'),
  issue_summary: z
    .string()
    .min(10)
    .max(500)
    .optional()
    .describe(
      'Brief description of the legal issue (1–3 sentences). ' +
      'If omitted, the tool compiles the research without issue framing.',
    ),
  with_case_analysis: z
    .boolean()
    .default(false)
    .describe(
      'If true, run extractive QA on cached case texts to extract holdings and key legal principles. ' +
      'Produces richer output but makes additional Isaacus API calls. ' +
      'Only applies to cases already in the judgment cache — no fresh fetches are made.',
    ),
  max_cases: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('Maximum number of cases to include in the compiled output (highest-frequency cases first)'),
});

// Questions to extract per case when with_case_analysis is true
const CASE_EXTRACT_QUESTIONS = [
  "What was the court's decision, holding, or order?",
  'What legal principle or rule of law was established or applied?',
];

// Extract unique case URLs from matter history top_results
function extractCaseUrls(
  rows: Awaited<ReturnType<typeof getMatterHistory>>,
): Array<{ url: string; title: string | null; citation: string | null; frequency: number }> {
  const urlMap = new Map<string, { title: string | null; citation: string | null; frequency: number }>();

  for (const row of rows) {
    for (const result of row.top_results ?? []) {
      if (!result.url) continue;
      const existing = urlMap.get(result.url);
      if (existing) {
        existing.frequency += 1;
        if (!existing.title && result.title) existing.title = result.title;
        if (!existing.citation && result.citation) existing.citation = result.citation;
      } else {
        urlMap.set(result.url, {
          title: result.title ?? null,
          citation: result.citation ?? null,
          frequency: 1,
        });
      }
    }
  }

  return Array.from(urlMap.entries())
    .map(([url, data]) => ({ url, ...data }))
    .sort((a, b) => b.frequency - a.frequency);
}

// Extract unique legislation references from research_legislation tool calls
function extractLegislation(
  rows: Awaited<ReturnType<typeof getMatterHistory>>,
) {
  const seen = new Set<string>();
  const results: Array<{ title: string; url: string }> = [];
  for (const row of rows) {
    if (row.tool_name !== 'research_legislation' && row.tool_name !== 'get_legislation') continue;
    for (const result of row.top_results ?? []) {
      if (!seen.has(result.url)) {
        seen.add(result.url);
        results.push({ title: result.title ?? result.url, url: result.url });
      }
    }
  }
  return results;
}

// Extract entity lookups from lookup_entity / lookup_entities_bulk calls
function extractEntities(
  rows: Awaited<ReturnType<typeof getMatterHistory>>,
) {
  return rows
    .filter((r) => r.tool_name === 'lookup_entity' || r.tool_name === 'lookup_entities_bulk')
    .map((r) => ({ query: r.query_text, looked_up_at: r.created_at }));
}

// Extract regulatory decisions found
function extractRegulatoryFindings(
  rows: Awaited<ReturnType<typeof getMatterHistory>>,
) {
  const seen = new Set<string>();
  const results: Array<{ title: string; url: string }> = [];
  for (const row of rows) {
    if (row.tool_name !== 'search_regulatory_decisions') continue;
    for (const result of row.top_results ?? []) {
      if (!seen.has(result.url)) {
        seen.add(result.url);
        results.push({ title: result.title, url: result.url });
      }
    }
  }
  return results;
}

// Extract unique research queries (excluding entity lookups)
function extractResearchQueries(
  rows: Awaited<ReturnType<typeof getMatterHistory>>,
) {
  const research_tools = new Set([
    'research_cases', 'research_legislation', 'search_by_citation',
    'find_citing_cases', 'find_related_cases', 'classify_legal_issue',
    'search_regulatory_decisions', 'search_asx_announcements',
  ]);
  const seen = new Set<string>();
  return rows
    .filter((r) => research_tools.has(r.tool_name) && !seen.has(r.query_text) && seen.add(r.query_text) !== undefined)
    .map((r) => ({ query: r.query_text, tool: r.tool_name, at: r.created_at }));
}

// Detect practice area from classify_legal_issue calls if any exist
function detectPracticeArea(
  rows: Awaited<ReturnType<typeof getMatterHistory>>,
): string | null {
  const classifyRow = rows
    .filter((r) => r.tool_name === 'classify_legal_issue')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  // We can't reconstruct the classified area from the log row alone
  // (it's stored only in the response, not in matter_queries).
  // Return the query_text as context for Claude to classify if needed.
  return classifyRow?.query_text ?? null;
}

export function registerDraftResearchMemo(server: McpServer): void {
  server.tool(
    'draft_research_memo',
    '[Matter] Compile all research for a matter into a structured brief ready for memo drafting. ' +
    'Aggregates cases researched, legislation consulted, entities checked, regulatory decisions found, ' +
    'and research queries — pulling from the matter research log and judgment cache. ' +
    'Optionally runs extractive QA (with_case_analysis: true) on cached case texts to pre-extract ' +
    'holdings and legal principles for each case. ' +
    'Returns structured data and a memo scaffold; use this as context when writing the final research memorandum.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'draft_research_memo' });

      if (!isDbEnabled()) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'not_configured',
            message: 'Database not enabled on this deployment — matter history is unavailable.',
          }) }],
          isError: true,
        };
      }

      // Pull full matter history (up to 200 entries)
      const rows = await getMatterHistory(input.matter_ref, 200);

      if (rows.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'no_history',
            message: `No research history found for matter "${input.matter_ref}". ` +
              'Ensure matter_ref was included in all tool calls, or check the spelling.',
            matter_ref: input.matter_ref,
          }) }],
          isError: true,
        };
      }

      const researchPeriod = {
        from: rows[rows.length - 1]!.created_at,
        to:   rows[0]!.created_at,
      };

      // Compile all research dimensions
      const allCaseRefs   = extractCaseUrls(rows);
      const topCases      = allCaseRefs.slice(0, input.max_cases);
      const legislation   = extractLegislation(rows);
      const entities      = extractEntities(rows);
      const regulatory    = extractRegulatoryFindings(rows);
      const queries       = extractResearchQueries(rows);
      const classifyQuery = detectPracticeArea(rows);

      const toolsUsed = [...new Set(rows.map((r) => r.tool_name))].sort();
      const totalTokens = rows.reduce((sum, r) => sum + (r.api_tokens_used ?? 0), 0);

      // Optional case extract via Isaacus
      interface CaseExtract {
        url: string;
        title: string | null;
        citation: string | null;
        frequency: number;
        extracts?: Array<{ question: string; answer: string | null; confidence: number | null }>;
        cached: boolean;
      }

      let caseDetails: CaseExtract[] = topCases.map((c) => ({ ...c, cached: false }));

      if (input.with_case_analysis && topCases.length > 0) {
        const caseUrls = topCases.map((c) => c.url);
        const cached = await getCachedJudgmentsByUrls(caseUrls).catch(() => []);
        const cachedByUrl = new Map(cached.map((c) => [c.url, c]));

        let totalExtractTokens = 0;

        caseDetails = await Promise.all(
          topCases.map(async (c) => {
            const judgment = cachedByUrl.get(c.url);
            if (!judgment) return { ...c, cached: false };

            // Limit text to first 50k chars to control token usage
            const text = judgment.body_text.slice(0, 50_000);
            const extracts: CaseExtract['extracts'] = [];

            for (const question of CASE_EXTRACT_QUESTIONS) {
              try {
                const result = await extractAnswer(question, text, 1);
                totalExtractTokens += result.tokensUsed;
                if (!result.inextractable && result.answers.length > 0) {
                  extracts.push({
                    question,
                    answer:     result.answers[0]!.text,
                    confidence: Math.round(result.answers[0]!.score * 1000) / 1000,
                  });
                } else {
                  extracts.push({ question, answer: null, confidence: null });
                }
              } catch (err) {
                log.warn({ err, url: c.url, question }, 'extractAnswer failed for case — skipping');
                extracts.push({ question, answer: null, confidence: null });
              }
            }

            return { ...c, cached: true, extracts };
          }),
        );

        log.debug({ totalExtractTokens, caseCount: caseDetails.length }, 'case extract complete');
      }

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'draft_research_memo',
        query_text: input.issue_summary ?? `Compile memo for ${input.matter_ref}`,
        result_count: rows.length,
        top_results: [],
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          matter_ref: input.matter_ref,
          ...(input.issue_summary ? { issue_summary: input.issue_summary } : {}),
          research_period: researchPeriod,
          research_summary: {
            total_queries: rows.length,
            tools_used: toolsUsed,
            total_api_tokens: totalTokens,
            cases_researched: allCaseRefs.length,
            legislation_consulted: legislation.length,
            entities_checked: entities.length,
            regulatory_decisions_found: regulatory.length,
          },
          ...(classifyQuery ? { classification_context: { original_classify_text: classifyQuery.slice(0, 300) } } : {}),
          cases: caseDetails,
          legislation,
          entities_checked: entities,
          regulatory_decisions: regulatory,
          research_queries: queries,
          memo_scaffold: {
            suggested_sections: [
              '1. Issue',
              '2. Applicable Law',
              '3. Key Authorities',
              '4. Analysis',
              '5. Risk Assessment',
              '6. Options',
              '7. Recommendation',
            ],
            advisory_frameworks: {
              crisis_72hr: 'If this is an urgent matter: lead with immediate actions required within 24–72 hours before deeper analysis.',
              negotiation: 'If advising on a negotiation: identify BATNA, ZOPA, and key pressure points for each party.',
              board_advisory: 'If advising a board: structure around governance obligations → director duties → risk → recommended resolution.',
            },
            note:
              'Use the research data above to populate each section. ' +
              'For cases, cite by [title] [citation] and quote key passages verbatim from the judgment text. ' +
              'Include matter_ref in all further tool calls to keep the research log complete.',
          },
        }) }],
      };
    },
  );
}
