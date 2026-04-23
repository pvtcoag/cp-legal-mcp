import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// MCP prompts return a sequence of messages the client then injects. We use
// short, practitioner-voiced `user` messages that name the exact tools to call
// in order — mirroring the Research Workflows section of CLAUDE.md.
//
// Prompt argsSchema values must be zod string schemas (PromptArgsRawShape).
// Optional args use `.optional()`.

function userMessage(text: string) {
  return {
    role: 'user' as const,
    content: { type: 'text' as const, text },
  };
}

export function registerPrompts(server: McpServer): void {
  // 1. research_legal_issue ────────────────────────────────────────────────
  server.registerPrompt(
    'research_legal_issue',
    {
      title: 'Research a new legal issue from scratch',
      description:
        'Classify a legal issue, research candidate cases in the suggested jurisdictions, summarise the top results, then ask targeted follow-ups on the most relevant judgments.',
      argsSchema: {
        issue: z.string().describe('Plain-English description of the legal issue to research.'),
        jurisdiction_hint: z
          .string()
          .optional()
          .describe('Optional jurisdiction hint (e.g. "NSW", "Federal", "QLD").'),
      },
    },
    ({ issue, jurisdiction_hint }) => ({
      messages: [
        userMessage(
          `I need to research a new legal issue: ${issue}${
            jurisdiction_hint ? ` (jurisdiction focus: ${jurisdiction_hint})` : ''
          }.\n\n` +
            `Start with classify_legal_issue to identify the practice area and suggested jurisdictions. Then call research_cases using those jurisdictions. Run summarise_judgment on the top three results, and finish with ask_judgment for targeted follow-ups on anything the summaries don't cover.`,
        ),
      ],
    }),
  );

  // 2. research_known_case ─────────────────────────────────────────────────
  server.registerPrompt(
    'research_known_case',
    {
      title: 'Research a known case by citation or name',
      description:
        'Resolve a known case, summarise it, enrich its citation network, and find subsequent cases that have cited it.',
      argsSchema: {
        citation_or_name: z
          .string()
          .describe('Citation (e.g. "[2023] HCA 12") or case name to look up.'),
      },
    },
    ({ citation_or_name }) => ({
      messages: [
        userMessage(
          `I'm researching this case: ${citation_or_name}.\n\n` +
            `Resolve it with search_by_citation, then run summarise_judgment for a structured overview. Call enrich_judgment to get the citation network with reception sentiment, and finish with find_citing_cases to see how courts have treated it since.`,
        ),
      ],
    }),
  );

  // 3. research_legislation_topic ──────────────────────────────────────────
  server.registerPrompt(
    'research_legislation_topic',
    {
      title: 'Research legislation on a topic',
      description:
        'Identify the Act or regulation governing a topic, and fetch full text only if verbatim citation is needed.',
      argsSchema: {
        topic: z.string().describe('Topic or question to find relevant legislation for.'),
        jurisdiction_hint: z
          .string()
          .optional()
          .describe('Optional jurisdiction hint (e.g. "Commonwealth", "NSW").'),
      },
    },
    ({ topic, jurisdiction_hint }) => ({
      messages: [
        userMessage(
          `I need to find the legislation governing: ${topic}${
            jurisdiction_hint ? ` (jurisdiction: ${jurisdiction_hint})` : ''
          }.\n\n` +
            `Start with research_legislation to identify the relevant Act or regulation. Only call get_legislation if I need the full verbatim text for direct citation.`,
        ),
      ],
    }),
  );

  // 4. compare_court_treatment ─────────────────────────────────────────────
  server.registerPrompt(
    'compare_court_treatment',
    {
      title: 'Compare how courts have treated an issue',
      description:
        'Classify the issue, build a candidate pool of cases in a given jurisdiction, then run a side-by-side comparison on the two most relevant cases and check reception sentiment.',
      argsSchema: {
        issue: z.string().describe('The legal issue to compare treatment of.'),
        jurisdiction_hint: z.string().describe('Jurisdiction to focus on (e.g. "NSW", "Federal").'),
      },
    },
    ({ issue, jurisdiction_hint }) => ({
      messages: [
        userMessage(
          `Compare how courts in ${jurisdiction_hint} have treated this issue: ${issue}.\n\n` +
            `Call classify_legal_issue to confirm practice area and courts, then research_cases to build the candidate pool. Run compare_cases on the top two cases side-by-side, and enrich_judgment on each to see citation reception sentiment.`,
        ),
      ],
    }),
  );

  // 5. build_citation_trail ────────────────────────────────────────────────
  server.registerPrompt(
    'build_citation_trail',
    {
      title: 'Build a citation trail from a seed case',
      description:
        'Resolve a seed case, list subsequent cases that have cited it, and enrich each citing case to see how the seed was received.',
      argsSchema: {
        seed_citation: z
          .string()
          .describe('Citation of the seed case to trace forward (e.g. "[2012] HCA 42").'),
      },
    },
    ({ seed_citation }) => ({
      messages: [
        userMessage(
          `Build a forward citation trail from this seed case: ${seed_citation}.\n\n` +
            `Resolve it with search_by_citation, then call find_citing_cases to list subsequent cases. For each citing case, run enrich_judgment to see how it received the seed — positive, negative, or distinguished.`,
        ),
      ],
    }),
  );

  // 6. compile_matter_file ─────────────────────────────────────────────────
  server.registerPrompt(
    'compile_matter_file',
    {
      title: 'Compile a matter file into a research memo',
      description:
        'Review all research logged against a matter, extract a chronology, compile a research memo, and verify deadlines before finalising.',
      argsSchema: {
        matter_ref: z.string().describe('Matter reference (e.g. "Smith-2024", "ABC v DEF").'),
      },
    },
    ({ matter_ref }) => ({
      messages: [
        userMessage(
          `Compile the matter file for ${matter_ref} into a finalised brief.\n\n` +
            `Start with get_matter_history to review every query logged against ${matter_ref}. Build a timeline with build_chronology from the key documents, then run draft_research_memo to compile a structured brief. Finish with check_deadlines to confirm any limitation periods or filing dates.`,
        ),
      ],
    }),
  );

  // 7. research_entity ─────────────────────────────────────────────────────
  server.registerPrompt(
    'research_entity',
    {
      title: 'Research a corporate entity',
      description:
        'Resolve a business entity via ABR, check ASIC/ACCC enforcement history, and (if listed) review recent ASX announcements.',
      argsSchema: {
        entity_name_or_abn: z
          .string()
          .describe('Entity name, ABN, or ACN to research.'),
      },
    },
    ({ entity_name_or_abn }) => ({
      messages: [
        userMessage(
          `Research this entity: ${entity_name_or_abn}.\n\n` +
            `Resolve ABN/ACN and registered details with lookup_entity. Then run search_regulatory_decisions to check ASIC and ACCC enforcement history. If the entity is ASX-listed, finish with search_asx_announcements for recent disclosures.`,
        ),
      ],
    }),
  );
}
