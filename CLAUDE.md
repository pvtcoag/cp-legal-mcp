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
2. `ask_legislation` — extract answers to specific questions (definitions, offence elements, penalties)
3. `get_legislation` — only when you need the full text for verbatim citation

### Comparing how courts have treated an issue
1. `classify_legal_issue` — confirm practice area and courts
2. `research_cases` — build the candidate pool
3. `compare_cases` — side-by-side extractive QA on two specific cases
4. `enrich_judgment` — on each case for citation reception sentiment

### Building a citation trail
1. `search_by_citation` — resolve the seed case
2. `find_citing_cases` — subsequent cases that have cited it
3. `enrich_judgment` on citing cases — see how each one received the seed case (positive/negative/distinguished)

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
| Extract answers from legislation | `ask_legislation` |
| Full text of an Act | `get_legislation` |
| Classify a new issue before researching | `classify_legal_issue` |
| Format a citation for a document | `format_citation` |
| Generate a pinpoint reference | `generate_pinpoint` |

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

Always include `matter_ref` in every tool call if one has been established for the current research session. This enables the matter history at `https://api.example.com/matters` to track all queries against the same matter.

- Format: alphanumeric, hyphens, underscores, spaces — e.g. `"Smith-2024"`, `"ABC v DEF"`, `"negligence-research"`
- If no matter ref was given, omit the field — do not invent one
- The server will apply a default matter ref if `DEFAULT_MATTER_REF` is configured

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
