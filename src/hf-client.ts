import { HfInference } from '@huggingface/inference';
import { config } from './config.js';
import { logger } from './logger.js';

// Singleton — HfInference is a stateless HTTP client, safe to share across requests
const hf = new HfInference(config.HF_API_TOKEN);

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

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function candidateToText(c: RerankCandidate): string {
  return [c.title, c.citation, c.excerpt].filter(Boolean).join(' | ');
}

async function getEmbedding(text: string): Promise<number[]> {
  const raw = await hf.featureExtraction({
    model: config.HF_RERANK_MODEL,
    inputs: text,
  });
  return raw as unknown as number[];
}

async function getBatchEmbeddings(texts: string[]): Promise<number[][]> {
  const raw = await hf.featureExtraction({
    model: config.HF_RERANK_MODEL,
    inputs: texts,
  });
  return raw as unknown as number[][];
}

export async function rerank<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  topK: number = config.HF_RERANK_TOP_K,
): Promise<RankedResult<T>[]> {
  if (!config.HF_ENABLED || candidates.length === 0) {
    logger.debug('HF reranking disabled or no candidates — returning original order');
    return candidates.slice(0, topK).map((item) => ({ item, score: 1.0 }));
  }

  logger.debug(
    { candidateCount: candidates.length, model: config.HF_RERANK_MODEL },
    'HF reranking',
  );

  const [queryEmbedding, candidateEmbeddings] = await Promise.all([
    getEmbedding(query),
    getBatchEmbeddings(candidates.map(candidateToText)),
  ]);

  const scored: RankedResult<T>[] = candidates.map((item, i) => ({
    item,
    score: cosineSimilarity(queryEmbedding, candidateEmbeddings[i]),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}
