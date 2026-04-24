# CP Legal Research — Claude Guidance

This file is read by Claude Code. For Claude Desktop / Claude.ai project instructions, copy the **Research Workflows** and **Tool Selection** sections into your project's system prompt.

---

## Research Workflows

### Starting a new legal issue from scratch
1. `classify_legal_issue` — identify the practice area and get suggested jurisdiction codes
2. `research_cases` — use the suggested jurisdictions; add `from_year` if recency matters
3. `summarise_judgment` — structured overview of the most relevant cases
4. `ask_judgment` — targeted follow-up questions on specific cases

### Researching a known case
1. `summarise_judgment` — start here, not `get_judgment`; covers holding, orders, facts, principles, outcome
2. `enrich_judgment` — if you need the citation network (cases cited with reception sentiment)
3. `find_citing_cases` — how courts have treated this case since
4. `find_related_cases` — semantically similar cases addressing the same issue
5. `ask_judgment` — only for questions not answered by the summary

### Researching legislation
1. `research_legislation` — find the Act or regulation by topic
2. `get_legislation` — only when you need the full text for verbatim citation

### Comparing how courts have treated an issue
1. `classify_legal_issue` — confirm practice area and courts
2. `research_cases` — build the candidate pool
3. `compare_cases` — side-by-side extractive QA on two specific cases
4. `enrich_judgment` — on each case for citation reception sentiment

### Building a citation trail
1. `search_by_citation` — resolve the seed case
2. `find_citing_cases` — subsequent cases that have cited it
3. `enrich_judgment` on citing cases — see how each one received the seed case (positive/negative/distinguished)

### Compiling a matter file
1. `get_matter_history` — review all research logged against this matter
2. `build_chronology` — extract a timeline from key documents or judgments
3. `draft_research_memo` — compile all matter research into a structured brief
4. `check_deadlines` — verify limitation periods or filing deadlines before finalising

### Researching an entity (corporate / regulatory)
1. `lookup_entity` — resolve the entity's ABN, ACN, and registered details via ABR (requires ABR_GUID); returns `manual_url` and `asic_search_url` for follow-up on ASIC
2. `search_regulatory_decisions` — check ASIC/ACCC enforcement history for the entity
3. `search_asx_announcements` — if listed, review recent ASX disclosures

---

## Tool Selection Guide

| Situation | Tool |
|---|---|
| Open-ended research on a legal issue | `research_cases` |
| You have a citation or case name to look up | `search_by_citation` |
| Quick structured overview of a case | `summarise_judgment` |
| Specific targeted question about a case | `ask_judgment` |
| Full verbatim text needed | `get_judgment` |
| Entities, parties, citations made | `enrich_judgment` |
| Who has cited this case | `find_citing_cases` |
| Cases on similar issues | `find_related_cases` |
| Head-to-head comparison of two cases | `compare_cases` |
| Find an Act or regulation | `research_legislation` |
| Full text of an Act | `get_legislation` |
| Classify a new issue before researching | `classify_legal_issue` |
| Format a citation for a document | `format_citation` |
| Look up a business entity (ABN/ACN/name) | `lookup_entity` |
| ASIC or ACCC enforcement decisions | `search_regulatory_decisions` |
| ASX company announcements | `search_asx_announcements` |
| Build a timeline from documents | `build_chronology` |
| Check limitation periods or filing deadlines | `check_deadlines` |
| Compile matter research into a brief | `draft_research_memo` |
| Monitor a key case for new citations | `monitor_precedents` |
| Review all queries logged against a matter | `get_matter_history` |

---

## Using the Tools Alongside Direct Web Access

The CP Legal tools are a **first preference**, not a dependency. They provide structured, citation-ready results from authoritative Australian legal sources. But they are not a ceiling on what you can do — direct web search and web fetch remain available at all times and you should use them freely.

**When a tool is unavailable or returns no results:**
- Fall back to a direct web search or `WebFetch` to the primary source (e.g. AustLII, caselaw.nsw.gov.au, asic.gov.au, accc.gov.au, abr.business.gov.au)
- Tell the user which tool failed and what you found through the fallback — transparency matters
- If a tool returns an error with `manual_url` fields, use those URLs directly

**When cross-referencing makes sense:**
- It is entirely appropriate to use a tool for the initial search, then fetch the source document directly to get more detail
- Using `WebFetch` on an AustLII judgment URL to verify or extend what `get_judgment` returned is encouraged
- Checking an ASX announcement PDF directly after `search_asx_announcements` identifies it is a valid workflow

**Tools that commonly benefit from web fallback:**
- `lookup_entity` fails → search ABR directly at `https://abr.business.gov.au/` or ASIC Connect at `https://connectonline.asic.gov.au/`
- `search_regulatory_decisions` returns nothing → search `site:asic.gov.au [entity name] enforcement` or browse the register directly
- `search_asx_announcements` fails → visit `https://www.asx.com.au/asx/statistics/announcements.do?by=asxCode&asxCode=[CODE]` directly
- `research_cases` / `search_by_citation` fails → search AustLII directly at `https://www.austlii.edu.au/`

**Session errors:**
If you see an MCP session error (e.g. "session not found" or "Error occurred during tool execution"), this usually means the server was restarted. Start a fresh conversation to re-establish the connection — the tools will work normally in a new session.

---

## Avoid These Patterns

**Don't call `ask_judgment` after `summarise_judgment` for the same questions.**
`summarise_judgment` already extracts holding, orders, key facts, legal principles, and outcome. Only call `ask_judgment` for questions outside those five dimensions.

**Don't call `get_judgment` when `summarise_judgment` will do.**
`get_judgment` returns raw full text — useful when you need verbatim paragraphs for quoting. For understanding a case, `summarise_judgment` is faster and more structured.

**Don't skip `classify_legal_issue` on unfamiliar areas.**
The jurisdiction suggestions it returns meaningfully improve `research_cases` results. It's one cheap call that saves multiple rounds of searching in the wrong courts.

**Don't use `research_cases` when you already have the citation.**
Use `search_by_citation` — it resolves faster and returns exact matches.

---

## Matter References

Include `matter_ref` in every tool call if one has been established for the current research session. This enables the matter history at `https://mcp.example.com/mcp/matters` to track all queries against the same matter.

- Format: alphanumeric, hyphens, underscores, spaces — e.g. `"Smith-2024"`, `"ABC v DEF"`, `"negligence-research"`
- If no matter ref has been given for this session, omit the field entirely — do not invent one
- The server will infer a contextual matter name from the first query in a session and group all subsequent untagged calls under it; explicit `matter_ref` values always take precedence

---

## Date Filtering

`research_cases` accepts `from_year` and `to_year` to restrict results by decision date. Use these when:
- The client asks for "recent" decisions → set `from_year` to 3–5 years ago
- Researching the historical development of a doctrine → use both to bracket a period
- Checking if a principle was established before a particular date → set `to_year`

---

## IQL Queries

`research_cases` and `research_legislation` accept `use_iql: true` to treat the query as a boolean expression:

```
"duty of care" AND negligence NOT "contributory negligence"
"s 18C" AND "racial discrimination"
"restraint of trade" AND (employer OR "post-employment")
```

Use IQL when the natural language query is returning too-broad results and you need precise term matching.
