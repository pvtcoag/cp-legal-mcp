import Isaacus from 'isaacus';
import { config } from './config.js';
import { logger } from './logger.js';

// Singleton — Isaacus client is stateless, safe to share across requests
const client = new Isaacus({ apiKey: config.ISAACUS_API_KEY });

function inputTokens(response: unknown): number {
  return (response as any)?.usage?.input_tokens ?? 0;
}

export interface RerankCandidate {
  title: string;
  excerpt?: string;
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
 * chunking_options enables accurate extraction from long judgments via a sliding window.
 */
export async function extractAnswer(
  question: string,
  documentText: string,
  topK = 5,
): Promise<{ answers: ExtractedAnswer[]; inextractable: boolean; inextractability_score: number; tokensUsed: number }> {
  const response = await client.extractions.qa.create({
    model: 'kanon-answer-extractor',
    query: question,
    texts: [documentText],
    top_k: topK,
    chunking_options: { size: 512, overlap_ratio: 0.1 },
  });

  type RawExtraction = {
    answers: Array<{ text: string; score: number; start: number; end: number }>;
    inextractability_score: number;
  };

  const extraction = (response.extractions as RawExtraction[])[0];
  if (!extraction) {
    return { answers: [], inextractable: true, inextractability_score: 1, tokensUsed: inputTokens(response) };
  }

  const { inextractability_score } = extraction;
  return {
    answers: extraction.answers as ExtractedAnswer[],
    inextractable: inextractability_score > 0.7,
    inextractability_score,
    tokensUsed: inputTokens(response),
  };
}

// ── Enrichment ────────────────────────────────────────────────────────────────

export interface EnrichedJudgment {
  document_type: string | null;
  jurisdiction: string | null;
  parties: Array<{ name: string; role: string | null; entity_type: string | null }>;
  key_dates: Array<{ type: string; value: string }>;
  citations_made: Array<{ text: string; sentiment: string | null }>;
  defined_terms: string[];
}

/**
 * Enrich a judgment using Kanon 2 Enricher.
 * overflow_strategy 'auto' handles judgments exceeding the model context window.
 * Returns structured entities plus the API token count for billing attribution.
 */
export async function enrichDocument(
  text: string,
): Promise<{ data: EnrichedJudgment; tokensUsed: number }> {
  const response = await client.enrichments.create({
    model: 'kanon-2-enricher',
    texts: [text],
    overflow_strategy: 'auto',
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
    data: {
      document_type: (doc.type as string) ?? null,
      jurisdiction: (doc.jurisdiction as string) ?? null,
      parties,
      key_dates,
      citations_made,
      defined_terms,
    },
    tokensUsed: inputTokens(response),
  };
}

// ── Reranking ─────────────────────────────────────────────────────────────────

/**
 * Rerank candidates against a query using the Kanon Universal Classifier.
 * chunking_options enables accurate scoring of full case excerpts without truncation.
 * Pass isIql: true to interpret query as an IQL boolean expression.
 */
export async function rerank<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  topK: number,
  options?: { isIql?: boolean },
): Promise<{ results: RankedResult<T>[]; tokensUsed: number }> {
  if (candidates.length === 0) {
    return { results: [], tokensUsed: 0 };
  }

  logger.debug({ candidateCount: candidates.length, topK }, 'Isaacus reranking');

  const response = await client.rerankings.create({
    model: 'kanon-universal-classifier',
    query,
    texts: candidates.map(candidateToText),
    top_n: topK,
    is_iql: options?.isIql ?? false,
    chunking_options: { size: 512, overlap_ratio: 0.1 },
  });

  return {
    results: response.results.map((result: { index: number; score: number }) => ({
      item: candidates[result.index],
      score: result.score,
    })),
    tokensUsed: inputTokens(response),
  };
}

// ── Zero-shot classification ──────────────────────────────────────────────────

export interface ClassificationResult {
  category: string;
  /** Score 0–1. >0.5 indicates the text matches the category. */
  score: number;
}

/**
 * Classify text against a list of category descriptions using zero-shot classification.
 * Pass text to classify as `text` and natural-language category descriptions as `categories`.
 * Scores > 0.5 indicate a positive match.
 */
export async function classifyText(
  text: string,
  categories: string[],
): Promise<{ results: ClassificationResult[]; tokensUsed: number }> {
  if (categories.length === 0) return { results: [], tokensUsed: 0 };

  logger.debug({ categoryCount: categories.length }, 'Isaacus classification');

  const response = await client.classifications.universal.create({
    model: 'kanon-universal-classifier',
    query: text,
    texts: categories,
    is_iql: false,
    scoring_method: 'auto',
  });

  return {
    results: (response.classifications as Array<{ index: number; score: number }>)
      .sort((a, b) => b.score - a.score)
      .map((c) => ({ category: categories[c.index]!, score: c.score })),
    tokensUsed: inputTokens(response),
  };
}

// ── Embeddings ────────────────────────────────────────────────────────────────

/**
 * Embed a text using Kanon 2 Embedder (1792 dimensions by default).
 * Use task 'retrieval/document' when embedding corpus documents,
 * 'retrieval/query' when embedding search queries.
 */
export async function embedText(
  text: string,
  task: 'retrieval/query' | 'retrieval/document' = 'retrieval/document',
): Promise<{ embedding: number[]; tokensUsed: number }> {
  logger.debug({ task, textLen: text.length }, 'Isaacus embedding');

  const response = await client.embeddings.create({
    model: 'kanon-2-embedder',
    texts: [text],
    task,
  });

  const embedding = (response.embeddings as Array<{ index: number; embedding: number[] }>)[0]
    ?.embedding;
  if (!embedding) throw new Error('Isaacus embeddings returned no results');

  return { embedding, tokensUsed: inputTokens(response) };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Cosine similarity between two equal-length vectors. Returns 0–1. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
