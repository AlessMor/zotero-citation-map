import type { CitationProviderID } from "../domain/citationTypes";
import {
  getOpenAlexAPIKey,
  getSemanticScholarAPIKey,
} from "./citationPreferences";

export interface ProviderExecutionPolicy {
  batchSize: number;
  requestParallelism: number;
  minimumStartDelayMs: number;
  relationshipPageSize: number;
}

const STATIC_POLICY: Record<CitationProviderID, ProviderExecutionPolicy> = {
  crossref: {
    batchSize: 1,
    requestParallelism: 3,
    minimumStartDelayMs: 350,
    relationshipPageSize: 100,
  },
  "semantic-scholar": {
    batchSize: 500,
    requestParallelism: 2,
    minimumStartDelayMs: 150,
    relationshipPageSize: 200,
  },
  opencitations: {
    batchSize: 1,
    requestParallelism: 3,
    minimumStartDelayMs: 400,
    relationshipPageSize: 1000,
  },
  inspire: {
    batchSize: 25,
    requestParallelism: 2,
    minimumStartDelayMs: 400,
    relationshipPageSize: 250,
  },
  openalex: {
    batchSize: 100,
    requestParallelism: 2,
    minimumStartDelayMs: 250,
    relationshipPageSize: 100,
  },
  ads: {
    batchSize: 1,
    requestParallelism: 2,
    minimumStartDelayMs: 250,
    relationshipPageSize: 200,
  },
};

/**
 * Internal provider policy. These values are deliberately not user settings:
 * each API has different request, payload, and rate-limit characteristics.
 */
export function providerExecutionPolicy(
  provider: CitationProviderID,
): ProviderExecutionPolicy {
  const base = STATIC_POLICY[provider];
  if (provider === "semantic-scholar" && !getSemanticScholarAPIKey()) {
    return {
      ...base,
      requestParallelism: 1,
      minimumStartDelayMs: 1100,
    };
  }
  if (provider === "openalex" && !getOpenAlexAPIKey()) {
    return {
      ...base,
      requestParallelism: 1,
      minimumStartDelayMs: 1100,
    };
  }
  return base;
}

export const LIBRARY_CORE_FALLBACK_PARALLELISM = 2;
/**
 * Relationship jobs combine network traffic with substantial synchronous
 * merging and JSON persistence. Keep this lower than ordinary request
 * parallelism so Zotero's main thread can continue painting during bulk work.
 */
export const RELATIONSHIP_ITEM_PARALLELISM = 1;
/**
 * Bulk updates hydrate exactly one bounded first hop. The returned neighbours
 * contain compact summaries only; their own relationships are never expanded.
 */
export const RELATIONSHIP_BULK_EAGER_LIMIT = 100;
export const RELATIONSHIP_SUMMARY_BACKGROUND_FALLBACK_LIMIT = 12;
export const RELATIONSHIP_SUMMARY_BATCH_SIZE = 200;
export const CITATION_RECORD_WRITE_CHUNK_SIZE = 100;
export const SOURCE_RECORD_WRITE_CHUNK_SIZE = 100;
