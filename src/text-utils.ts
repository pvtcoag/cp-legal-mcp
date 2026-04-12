/**
 * Text utilities for pre-processing legal documents before Isaacus API calls.
 *
 * The primary goal is reducing token usage (and therefore cost) by sending only
 * the most relevant portions of a document to Kanon Answer Extractor or Kanon 2 Enricher,
 * rather than the full text of potentially very long judgments.
 */

// Common English stop words that don't discriminate legal content
const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'been', 'were', 'they', 'their',
  'what', 'which', 'when', 'where', 'will', 'would', 'could', 'should',
  'about', 'into', 'over', 'also', 'does', 'said', 'than', 'then', 'them',
  'some', 'such', 'only', 'both', 'each', 'more', 'most', 'other', 'very',
  'just', 'make', 'like', 'know', 'used', 'well', 'here', 'there', 'after',
  'before', 'under', 'while', 'these', 'those', 'being', 'made', 'take',
]);

function extractKeywords(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

function countOccurrences(text: string, keyword: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(keyword, pos)) !== -1) {
    count++;
    pos += keyword.length;
  }
  return Math.min(count, 3); // cap contribution per keyword — stops repetitive chunks dominating
}

/**
 * Given a long legal document and a question, return only the most relevant
 * passages — up to maxChars — scored by keyword overlap with the question.
 *
 * Strategy:
 * - Split on paragraph breaks
 * - Score each paragraph by keyword frequency overlap with the question
 * - Apply mild position bonus to intro (first 10%) and conclusion (last 20%) paragraphs,
 *   since judgments often state holding at end and parties at start
 * - Always include the first 3 paragraphs (court header / catchwords)
 * - Return selected paragraphs in their original document order
 *
 * For multi-question contexts (e.g. summarise_judgment) pass all questions joined
 * as a single string — this combines all keyword sets.
 */
export function extractRelevantPassages(
  text: string,
  question: string,
  maxChars = 24_000,
): string {
  if (text.length <= maxChars) return text;

  const chunks = text.split(/\n{2,}/).map((s) => s.trim()).filter((s) => s.length >= 40);
  if (chunks.length <= 5) return text.slice(0, maxChars);

  const keywords = extractKeywords(question);
  if (keywords.length === 0) return text.slice(0, maxChars);

  const total = chunks.length;

  const scored = chunks.map((chunk, idx) => {
    const lower = chunk.toLowerCase();
    const kwScore = keywords.reduce((s, kw) => s + countOccurrences(lower, kw), 0);
    // Mild positional bias: intro (parties, catchwords) and conclusion (orders, holding)
    const posBonus = (idx < total * 0.10 || idx > total * 0.80) ? 1 : 0;
    return { chunk, score: kwScore + posBonus, idx };
  });

  // Greedy fill: highest-scoring paragraphs first, up to maxChars budget
  const selected = new Set<number>();

  // Always include the first 3 chunks (court/catchword header)
  for (let i = 0; i < Math.min(3, chunks.length); i++) selected.add(i);

  // Fill remaining budget with highest-scoring chunks
  let budget = maxChars - chunks.slice(0, 3).reduce((s, c) => s + c.length + 2, 0);
  for (const { chunk, idx } of scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score)) {
    if (selected.has(idx)) continue;
    if (budget <= chunk.length) break;
    selected.add(idx);
    budget -= chunk.length + 2;
  }

  // Reconstruct in original document order
  return chunks
    .filter((_, i) => selected.has(i))
    .join('\n\n');
}

/**
 * Hard-truncate a document to maxChars, preserving both the start and end.
 *
 * Keeps 70% from the start and 30% from the end with a visible `[…]` marker.
 * Preserving the end is important for enrichment: orders, final determinations,
 * and cost decisions often appear at the conclusion of a judgment.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.70);
  const tail = maxChars - head;
  return text.slice(0, head) + '\n\n[… document truncated for processing …]\n\n' + text.slice(-tail);
}
