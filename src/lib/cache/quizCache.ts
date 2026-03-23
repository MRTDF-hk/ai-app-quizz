import type { QuizPayload } from "@/lib/quiz/types";

type CacheEntry = {
  payload: QuizPayload;
  createdAtMs: number;
  pdfSha256: string;
};

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_MAX_ENTRIES = 50;

function getTtlMs() {
  const raw = process.env.QUIZ_CACHE_TTL_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

function getMaxEntries() {
  const raw = process.env.QUIZ_CACHE_MAX_ENTRIES;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ENTRIES;
}

// In-memory cache for serverless warm instances.
// It will not be shared across all Vercel instances, but improves latency.
const globalKey = "__quizCache_v1";

export const quizCache: Map<string, CacheEntry> =
  (globalThis as unknown as Record<string, Map<string, CacheEntry>>)[globalKey] ??
  new Map<string, CacheEntry>();

if (!(globalThis as unknown as Record<string, Map<string, CacheEntry>>)[globalKey]) {
  (globalThis as unknown as Record<string, Map<string, CacheEntry>>)[globalKey] = quizCache;
}

export function getCachedQuiz(cacheKey: string) {
  const entry = quizCache.get(cacheKey);
  if (!entry) return null;
  const ttlMs = getTtlMs();
  if (Date.now() - entry.createdAtMs > ttlMs) {
    quizCache.delete(cacheKey);
    return null;
  }
  return entry.payload;
}

export function setCachedQuiz(
  cacheKey: string,
  pdfSha256: string,
  payload: QuizPayload,
) {
  const maxEntries = getMaxEntries();

  // Simple eviction: remove oldest entry when capacity exceeded.
  if (quizCache.size >= maxEntries) {
    let oldestKey: string | null = null;
    let oldestCreatedAt = Number.POSITIVE_INFINITY;
    for (const [k, v] of quizCache.entries()) {
      if (v.createdAtMs < oldestCreatedAt) {
        oldestCreatedAt = v.createdAtMs;
        oldestKey = k;
      }
    }
    if (oldestKey) quizCache.delete(oldestKey);
  }

  quizCache.set(cacheKey, {
    payload,
    pdfSha256,
    createdAtMs: Date.now(),
  });
}

