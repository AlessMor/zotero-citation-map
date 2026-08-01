import type { RelatedWorkMetadata } from "../domain/citationTypes";
import {
  CACHE_RELATED_WORK_MERGE,
  mergeRelatedWorkRecords,
} from "../domain/relatedWorkMetadata";
import {
  stableExternalWorkIdentity,
  stableWorkAliases,
} from "../domain/workIdentity";
import {
  registerProviderJSONResponseObserver,
  type ProviderJSONResponseContext,
} from "../providers/http";
import {
  collectOpenAlexWorks,
  openAlexWorkMetadata,
} from "../providers/openAlexMapper";
import {
  collectCrossrefWorks,
  crossrefWorkMetadata,
} from "../providers/crossrefMapper";
import {
  collectSemanticScholarPapers,
  semanticScholarWork,
} from "../providers/semanticScholarMapper";
import {
  cachedExternalWorkMetadata,
  saveExternalWorkCacheSuccesses,
} from "./externalWorkCacheService";
import {
  mergeRelatedWorkHydrationState,
  projectRelatedWorkSummary,
} from "./relatedWorkHydrationState";
import { SerializedTaskQueue } from "./serializedTaskQueue";

function providerRecords(
  context: ProviderJSONResponseContext,
): RelatedWorkMetadata[] {
  if (context.provider === "semantic-scholar") {
    return collectSemanticScholarPapers(context.data)
      .map(semanticScholarWork)
      .filter((work): work is RelatedWorkMetadata => Boolean(work));
  }
  if (context.provider === "openalex") {
    return collectOpenAlexWorks(context.data)
      .map(openAlexWorkMetadata)
      .filter((work): work is RelatedWorkMetadata => Boolean(work));
  }
  if (context.provider === "crossref") {
    return collectCrossrefWorks(context.data)
      .map(crossrefWorkMetadata)
      .filter((work): work is RelatedWorkMetadata => Boolean(work));
  }
  return [];
}

function mergeMetadata(
  current: RelatedWorkMetadata | null,
  incoming: RelatedWorkMetadata,
): RelatedWorkMetadata {
  const merged = mergeRelatedWorkRecords(
    current,
    incoming,
    CACHE_RELATED_WORK_MERGE,
  );
  return mergeRelatedWorkHydrationState(merged, incoming);
}

function isRelationshipResponse(url: string): boolean {
  if (/\/(?:references|citations)(?:\?|$)/i.test(url)) return true;
  const parsed = new URL(url);
  return /^cites:/i.test(parsed.searchParams.get("filter") ?? "");
}

const persistenceQueue = new SerializedTaskQueue();
let unregisterResponseObserver: (() => void) | null = null;

async function persistProviderResponse(
  context: ProviderJSONResponseContext,
): Promise<void> {
  const records = providerRecords(context);
  if (!records.length) return;
  const summaryOnly = isRelationshipResponse(context.url);
  const entries = new Map<string, RelatedWorkMetadata>();
  for (const raw of records) {
    const work = summaryOnly ? projectRelatedWorkSummary(raw, true) : raw;
    const aliases = new Set([
      ...stableWorkAliases(work),
      stableExternalWorkIdentity(work),
    ]);
    for (const alias of aliases) {
      if (!alias) continue;
      entries.set(
        alias,
        mergeMetadata(cachedExternalWorkMetadata(alias), work),
      );
    }
  }
  await saveExternalWorkCacheSuccesses(
    [...entries].map(([identityKey, metadata]) => ({ identityKey, metadata })),
  );
}

export function startProviderResponseCache(): void {
  if (unregisterResponseObserver) return;
  persistenceQueue.reopen();
  unregisterResponseObserver = registerProviderJSONResponseObserver((context) =>
    persistenceQueue.enqueue(() => persistProviderResponse(context)),
  );
}

export function stopProviderResponseCache(): void {
  unregisterResponseObserver?.();
  unregisterResponseObserver = null;
  persistenceQueue.close();
}

export function waitForProviderResponseCache(): Promise<void> {
  return persistenceQueue.drain();
}
