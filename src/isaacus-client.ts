import Isaacus from 'isaacus';
import { config } from './config.js';
import { logger } from './logger.js';

// Singleton — Isaacus client is stateless, safe to share across requests
const client = new Isaacus({ apiKey: config.ISAACUS_API_KEY });

export interface RerankCandidate {
  title: string;
  excerpt: string;
  url: string;
  citation?: string;
  [key: string]: unknown;
}

export interface RankedResult<T extends RerankCandidate> {
  item: T;
  score: number;
}

function candidateToText(c: RerankCandidate): string {
  return [c.title, c.citation, c.excerpt].filter(Boolean).join(' | ');
}

// ── Extractive QA ─────────────────────────────────────────────────────────────

export interface ExtractedAnswer {
  text: string;
  /** Confidence score 0–1. Higher = more confident. */
  score: number;
  /** Character start index in the source document. */
  start: number;
  /** Character end index in the source document. */
  end: number;
}

/**
 * Extract direct answers to a question from a document using Kanon Answer Extractor.
 * Returns answers sorted by confidence. Returns empty array if the answer is
 * not present in the document (high inextractability score).
 */
export async function extractAnswer(
  question: string,
  documentText: string,
  topK = 5,
): Promise<{ answers: ExtractedAnswer[]; inextractable: boolean; inextractability_score: number }> {
  const response = await client.extractions.qa.create({
    model: 'kanon-answer-extractor',
    query: question,
    texts: [documentText],
    top_k: topK,
  });

  type RawExtraction = {
    answers: Array<{ text: string; score: number; start: number; end: number }>;
    inextractability_score: number;
  };

  const extraction = (response.extractions as RawExtraction[])[0];
  if (!extraction) {
    return { answers: [], inextractable: true, inextractability_score: 1 };
  }

  const { inextractability_score } = extraction;
  const inextractable = inextractability_score > 0.7;

  return {
    answers: extraction.answers as ExtractedAnswer[],
    inextractable,
    inextractability_score,
  };
}

// ── Enrichment ────────────────────────────────────────────────────────────────

export interface EnrichedJudgment {
  document_type: string | null;
  jurisdiction: string | null;
  parties: Array<{ name: string; role: string | null; entity_type: string | null }>;
  key_dates: Array<{ type: string; value: string }>;
  /** Cases cited in this judgment, with reception sentiment where available. */
  citations_made: Array<{ text: string; sentiment: string | null }>;
  defined_terms: string[];
}

/**
 * Enrich a judgment using Kanon 2 Enricher, returning structured entities:
 * parties, dates, citations with reception sentiment, and defined terms.
 * Reception sentiment (positive/mixed/negative/neutral) is especially useful
 * for understanding how a cited case was treated.
 */
export async function enrichDocument(text: string): Promise<EnrichedJudgment> {
  const response = await client.enrichments.create({
    model: 'kanon-2-enricher',
    texts: [text],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = (response.results as any[])[0]?.document ?? {};

  const parties: EnrichedJudgment['parties'] = ((doc.persons ?? []) as any[]).map((p: any) => ({
    name: p.name ?? p.text ?? '',
    role: p.role ?? null,
    entity_type: p.kind ?? p.type ?? null,
  }));

  const key_dates: EnrichedJudgment['key_dates'] = ((doc.dates ?? []) as any[])
    .filter((d: any) => d.type && d.value)
    .map((d: any) => ({ type: d.type as string, value: d.value as string }));

  const citations_made: EnrichedJudgment['citations_made'] = ((doc.citations ?? []) as any[]).map(
    (c: any) => ({
      text: c.text ?? c.citation ?? '',
      sentiment: c.reception?.sentiment ?? c.sentiment ?? null,
    }),
  );

  const defined_terms: string[] = ((doc.terms ?? []) as any[]).map(
    (t: any) => t.text ?? t.term ?? '',
  );

  return {
    document_type: (doc.type as string) ?? null,
    jurisdiction: (doc.jurisdiction as string) ?? null,
    parties,
    key_dates,
    citations_made,
    defined_terms,
  };
}

/**
 * Rerank candidates against a query using the Kanon 2 Reranker.
 *
 * Uses Isaacus's Kanon Universal Classifier — purpose-built for Australian legal
 * text, ranked #1 on Legal RAG Bench. Automatically chunks long documents so full
 * case excerpts are scored accurately without truncation.
 */
export async function rerank<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  topK: number,
): Promise<RankedResult<T>[]> {
  if (candidates.length === 0) {
    return [];
  }

  logger.debug({ candidateCount: candidates.length, topK }, 'Isaacus reranking');

  const texts = candidates.map(candidateToText);

  const response = await client.rerankings.create({
    model: 'kanon-universal-classifier',
    query,
    texts,
    top_n: topK,
  });

  return response.results.map((result: { index: number; score: number }) => ({
    item: candidates[result.index],
    score: result.score,
  }));
}
