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

export const LIBRARY_CORE_FALLBACK_PARALLELISM = 4;
export const RELATIONSHIP_ITEM_PARALLELISM = 4;
export const RELATIONSHIP_SUMMARY_BACKGROUND_FALLBACK_LIMIT = 12;
export const RELATIONSHIP_SUMMARY_BATCH_SIZE = 200;
export const CITATION_RECORD_WRITE_CHUNK_SIZE = 100;
export const SOURCE_RECORD_WRITE_CHUNK_SIZE = 100;
