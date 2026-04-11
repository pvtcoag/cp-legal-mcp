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
