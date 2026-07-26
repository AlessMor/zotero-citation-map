import type {
  CitationMetricRecord,
  SourceMetrics,
} from "../domain/citationTypes";
import {
  isCitationRequestCancellationRequested,
  requestJSON,
} from "../providers/http";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
import { getOpenAlexAPIKey, isProviderEnabled } from "./citationPreferences";
import { cachedExternalWorkMetadata } from "./externalWorkCacheService";
import {
  providerExecutionPolicy,
  SOURCE_RECORD_WRITE_CHUNK_SIZE,
} from "./providerExecutionPolicy";
import { saveCitationMetricRecord } from "./citationMetricsStore";
import { LIBRARY_UPDATE_COMPLETION_VERSION } from "./libraryUpdatePolicy";

interface OpenAlexSource {
  id?: string;
  display_name?: string;
  issn_l?: string | null;
  issn?: string[] | null;
  summary_stats?: {
    "2yr_mean_citedness"?: number | null;
    h_index?: number | null;
    i10_index?: number | null;
  } | null;
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  primary_location?: { source?: OpenAlexSource | null } | null;
  locations?: Array<{ source?: OpenAlexSource | null }> | null;
}

interface OpenAlexList<T> {
  results?: T[];
}

interface SourceTarget {
  recordIndex: number;
  item: Zotero.Item;
  record: CitationMetricRecord;
  sourceID: string | null;
  sourceTitle: string | null;
  issns: string[];
}

export interface LibrarySourceMetricProgress {
  completed: number;
  total: number;
  message: string;
}

export interface LibrarySourceMetricResult {
  records: CitationMetricRecord[];
  updated: number;
  unresolved: number;
  failedRequests: number;
}

function chunked<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

async function runBounded(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
): Promise<number> {
  let nextIndex = 0;
  let failed = 0;
  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await tasks[index]();
      } catch (error) {
        failed += 1;
        Zotero.debug(
          `Citation Map: source-metric batch failed: ${String(error)}`,
        );
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), tasks.length) },
      () => worker(),
    ),
  );
  return failed;
}

function openAlexURL(
  path: string,
  parameters: Record<string, string | number> = {},
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`https://api.openalex.org${normalizedPath}`);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, String(value));
  }
  const apiKey = getOpenAlexAPIKey();
  if (apiKey) url.searchParams.set("api_key", apiKey);
  return url.toString();
}

function shortOpenAlexID(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text.replace(/^https:\/\/openalex\.org\//i, "") : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function metricsFromSource(
  source: OpenAlexSource | null,
): SourceMetrics | null {
  const stats = source?.summary_stats;
  const metrics: SourceMetrics = {
    sourceID: shortOpenAlexID(source?.id),
    sourceTitle: String(source?.display_name ?? "").trim() || null,
    twoYearMeanCitedness: numberOrNull(stats?.["2yr_mean_citedness"]),
    hIndex: numberOrNull(stats?.h_index),
    i10Index: numberOrNull(stats?.i10_index),
    updatedAt: new Date().toISOString(),
    libraryUpdateVersion: LIBRARY_UPDATE_COMPLETION_VERSION,
  };
  return metrics.twoYearMeanCitedness !== null ||
    metrics.hIndex !== null ||
    metrics.i10Index !== null
    ? metrics
    : null;
}

function sourceFromWork(work: OpenAlexWork): OpenAlexSource | null {
  const candidates = [
    work.primary_location?.source ?? null,
    ...(work.locations ?? []).map((location) => location.source ?? null),
  ];
  return candidates.find((source) => Boolean(source?.id)) ?? null;
}

function itemISSNs(item: Zotero.Item): string[] {
  const raw = String(item.getField?.("ISSN") ?? "");
  const matches = raw.match(/\b\d{4}-?\d{3}[\dXx]\b/g) ?? [];
  return [
    ...new Set(
      matches.map((value) => {
        const compact = value.replace(/[^0-9Xx]/g, "").toUpperCase();
        return `${compact.slice(0, 4)}-${compact.slice(4)}`;
      }),
    ),
  ];
}

function itemSourceTitle(
  item: Zotero.Item,
  record: CitationMetricRecord,
): string | null {
  return (
    String(
      record.sourceTitle ??
        item.getField?.("publicationTitle") ??
        item.getField?.("conferenceName") ??
        item.getField?.("publisher") ??
        "",
    ).trim() || null
  );
}

function hasSourceMetrics(metrics: SourceMetrics | null | undefined): boolean {
  return Boolean(
    metrics &&
    (metrics.twoYearMeanCitedness !== null ||
      metrics.hIndex !== null ||
      metrics.i10Index !== null),
  );
}

function workIdentifier(
  record: CitationMetricRecord,
): { kind: "openalex" | "doi"; key: string } | null {
  if (record.provider === "openalex") {
    const id = shortOpenAlexID(record.providerWorkID);
    if (id && /^W\d+$/i.test(id)) {
      return { kind: "openalex", key: id.toLocaleUpperCase() };
    }
  }
  const doi = normalizeDOI(record.doi);
  return doi ? { kind: "doi", key: doi } : null;
}

function workIdentityKeys(work: OpenAlexWork): string[] {
  const keys: string[] = [];
  const id = shortOpenAlexID(work.id);
  const doi = normalizeDOI(work.doi);
  if (id) keys.push(`openalex:${id.toLocaleUpperCase()}`);
  if (doi) keys.push(`doi:${doi}`);
  return keys;
}

async function fetchSourcesByIDs(
  sourceIDs: string[],
): Promise<Map<string, SourceMetrics>> {
  const resolved = new Map<string, SourceMetrics>();
  const policy = providerExecutionPolicy("openalex");
  const batchSize = Math.min(100, policy.batchSize);
  const tasks = chunked([...new Set(sourceIDs)], batchSize).map(
    (batch) => async (): Promise<void> => {
      const response = await requestJSON<OpenAlexList<OpenAlexSource>>(
        "openalex",
        openAlexURL("/sources", {
          filter: `ids.openalex:${batch.join("|")}`,
          per_page: batch.length,
          select: "id,display_name,issn_l,issn,summary_stats",
        }),
      );
      if (!response.ok || !response.data) {
        throw new Error(response.message || "OpenAlex source batch failed.");
      }
      for (const source of response.data.results ?? []) {
        const id = shortOpenAlexID(source.id);
        const metrics = metricsFromSource(source);
        if (id && metrics) resolved.set(id.toLocaleUpperCase(), metrics);
      }
    },
  );
  await runBounded(tasks, policy.requestParallelism);
  return resolved;
}

async function fetchSourceByISSN(issn: string): Promise<SourceMetrics | null> {
  const response = await requestJSON<OpenAlexList<OpenAlexSource>>(
    "openalex",
    openAlexURL("/sources", {
      filter: `issn:${issn}`,
      per_page: 5,
      select: "id,display_name,issn_l,issn,summary_stats",
    }),
  );
  if (!response.ok || !response.data) return null;
  for (const source of response.data.results ?? []) {
    const metrics = metricsFromSource(source);
    if (metrics) return metrics;
  }
  return null;
}

async function fetchSourceByTitle(
  title: string,
): Promise<SourceMetrics | null> {
  const normalized = normalizeExactTitle(title);
  if (!normalized) return null;
  const response = await requestJSON<OpenAlexList<OpenAlexSource>>(
    "openalex",
    openAlexURL("/sources", {
      search: title,
      per_page: 20,
      select: "id,display_name,issn_l,issn,summary_stats",
    }),
  );
  if (!response.ok || !response.data) return null;
  const candidates = response.data.results ?? [];
  const exact = candidates.find(
    (source) => normalizeExactTitle(source.display_name) === normalized,
  );
  const selected = exact ?? (candidates.length === 1 ? candidates[0] : null);
  return selected ? metricsFromSource(selected) : null;
}

/**
 * Resolve journal/source metrics for Zotero library items as an update phase.
 * Work and source identities are deduplicated across the complete update job,
 * so papers from the same journal reuse one source lookup.
 */
export async function enrichLibrarySourceMetrics(
  items: Zotero.Item[],
  input: CitationMetricRecord[],
  onProgress?: (progress: LibrarySourceMetricProgress) => void,
  options: { force?: boolean } = {},
): Promise<LibrarySourceMetricResult> {
  const records = input.map((record) => ({ ...record }));
  const itemByKey = new Map(items.map((item) => [String(item.key), item]));
  const targets: SourceTarget[] = [];
  let cachedResolved = 0;
  for (const [recordIndex, record] of records.entries()) {
    if (
      !options.force &&
      record.sourceMetrics?.libraryUpdateVersion ===
        LIBRARY_UPDATE_COMPLETION_VERSION
    ) {
      continue;
    }
    const doi = normalizeDOI(record.doi);
    const openAlexID =
      record.provider === "openalex"
        ? shortOpenAlexID(record.providerWorkID)
        : null;
    const cachedWork =
      (doi ? cachedExternalWorkMetadata(`doi:${doi}`) : null) ??
      (openAlexID
        ? cachedExternalWorkMetadata(`openalex:${openAlexID}`)
        : null);
    const cachedSourceMetrics = cachedWork?.sourceMetrics;
    if (cachedSourceMetrics && hasSourceMetrics(cachedSourceMetrics)) {
      records[recordIndex] = {
        ...record,
        sourceMetrics: {
          ...cachedSourceMetrics,
          libraryUpdateVersion: LIBRARY_UPDATE_COMPLETION_VERSION,
        },
      };
      cachedResolved += 1;
      continue;
    }
    const item = itemByKey.get(record.itemKey);
    if (!item) continue;
    targets.push({
      recordIndex,
      item,
      record,
      sourceID: shortOpenAlexID(
        record.sourceMetrics?.sourceID ?? cachedWork?.sourceMetrics?.sourceID,
      ),
      sourceTitle:
        itemSourceTitle(item, record) ??
        cachedWork?.sourceMetrics?.sourceTitle ??
        cachedWork?.sourceTitle ??
        null,
      issns: itemISSNs(item),
    });
  }

  if (!targets.length) {
    return {
      records,
      updated: cachedResolved,
      unresolved: 0,
      failedRequests: 0,
    };
  }

  if (!getOpenAlexAPIKey() || !isProviderEnabled("openalex")) {
    for (const batch of chunked(targets, SOURCE_RECORD_WRITE_CHUNK_SIZE)) {
      const changed = batch.map((target) => {
        const existing = target.record.sourceMetrics;
        const sourceMetrics: SourceMetrics = existing
          ? {
              ...existing,
              updatedAt: new Date().toISOString(),
              libraryUpdateVersion: LIBRARY_UPDATE_COMPLETION_VERSION,
            }
          : {
              sourceID: null,
              sourceTitle: target.sourceTitle,
              twoYearMeanCitedness: null,
              hIndex: null,
              i10Index: null,
              updatedAt: new Date().toISOString(),
              libraryUpdateVersion: LIBRARY_UPDATE_COMPLETION_VERSION,
            };
        const updatedRecord: CitationMetricRecord = {
          ...target.record,
          sourceMetrics,
        };
        records[target.recordIndex] = updatedRecord;
        return updatedRecord;
      });
      await Promise.all(
        changed.map((record) => saveCitationMetricRecord(record)),
      );
    }
    return {
      records,
      updated:
        cachedResolved +
        targets.filter((target) =>
          hasSourceMetrics(target.record.sourceMetrics),
        ).length,
      unresolved: targets.filter(
        (target) => !hasSourceMetrics(target.record.sourceMetrics),
      ).length,
      failedRequests: 0,
    };
  }

  const metricsByTarget = new Map<number, SourceMetrics>();
  const sourceIDByTarget = new Map<number, string>();
  for (const [targetIndex, target] of targets.entries()) {
    const existingMetrics = target.record.sourceMetrics;
    if (existingMetrics && hasSourceMetrics(existingMetrics)) {
      metricsByTarget.set(targetIndex, {
        ...existingMetrics,
        updatedAt: new Date().toISOString(),
        libraryUpdateVersion: LIBRARY_UPDATE_COMPLETION_VERSION,
      });
    }
    if (target.sourceID) sourceIDByTarget.set(targetIndex, target.sourceID);
  }

  const workCandidates = targets
    .map((target, targetIndex) => ({
      targetIndex,
      identifier: workIdentifier(target.record),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        targetIndex: number;
        identifier: { kind: "openalex" | "doi"; key: string };
      } =>
        Boolean(candidate.identifier) &&
        !metricsByTarget.has(candidate.targetIndex),
    );
  const openAlexPolicy = providerExecutionPolicy("openalex");
  const workBatchSize = Math.min(100, openAlexPolicy.batchSize);
  const workTasks: Array<() => Promise<void>> = [];
  for (const kind of ["openalex", "doi"] as const) {
    for (const batch of chunked(
      workCandidates.filter((candidate) => candidate.identifier.kind === kind),
      workBatchSize,
    )) {
      workTasks.push(async (): Promise<void> => {
        const filterName = kind === "openalex" ? "ids.openalex" : "doi";
        const response = await requestJSON<OpenAlexList<OpenAlexWork>>(
          "openalex",
          openAlexURL("/works", {
            filter: `${filterName}:${batch
              .map((candidate) => candidate.identifier.key)
              .join("|")}`,
            per_page: batch.length,
            select: "id,doi,primary_location,locations",
          }),
        );
        if (!response.ok || !response.data) {
          throw new Error(
            response.message || "OpenAlex work-source batch failed.",
          );
        }
        const workByIdentity = new Map<string, OpenAlexWork>();
        for (const work of response.data.results ?? []) {
          for (const key of workIdentityKeys(work))
            workByIdentity.set(key, work);
        }
        for (const candidate of batch) {
          const key = `${candidate.identifier.kind}:${candidate.identifier.key}`;
          const work = workByIdentity.get(key);
          const source = work ? sourceFromWork(work) : null;
          const sourceID = shortOpenAlexID(source?.id);
          const direct = metricsFromSource(source);
          if (direct) metricsByTarget.set(candidate.targetIndex, direct);
          if (sourceID) sourceIDByTarget.set(candidate.targetIndex, sourceID);
        }
      });
    }
  }

  let failedRequests = await runBounded(
    workTasks,
    openAlexPolicy.requestParallelism,
  );

  const sourceMetricsByID = await fetchSourcesByIDs([
    ...sourceIDByTarget.values(),
  ]);
  for (const [targetIndex, sourceID] of sourceIDByTarget) {
    const metrics = sourceMetricsByID.get(sourceID.toLocaleUpperCase());
    if (metrics) metricsByTarget.set(targetIndex, metrics);
  }

  const unresolvedGroups = new Map<
    string,
    { targetIndexes: number[]; resolve: () => Promise<SourceMetrics | null> }
  >();
  for (const [targetIndex, target] of targets.entries()) {
    if (metricsByTarget.has(targetIndex)) continue;
    const issn = target.issns[0];
    const key = issn
      ? `issn:${issn}`
      : target.sourceTitle
        ? `title:${normalizeExactTitle(target.sourceTitle)}`
        : null;
    if (!key) continue;
    const existing = unresolvedGroups.get(key);
    if (existing) {
      existing.targetIndexes.push(targetIndex);
      continue;
    }
    const sourceTitle = target.sourceTitle;
    unresolvedGroups.set(key, {
      targetIndexes: [targetIndex],
      resolve: issn
        ? () => fetchSourceByISSN(issn)
        : () => fetchSourceByTitle(sourceTitle ?? ""),
    });
  }

  const fallbackTasks = [...unresolvedGroups.values()].map(
    (group) => async (): Promise<void> => {
      const metrics = await group.resolve();
      if (!metrics) return;
      for (const targetIndex of group.targetIndexes) {
        metricsByTarget.set(targetIndex, metrics);
      }
    },
  );
  failedRequests += await runBounded(
    fallbackTasks,
    openAlexPolicy.requestParallelism,
  );

  let updated = cachedResolved;
  let completed = 0;
  const total = targets.length;
  for (const batch of chunked(
    targets.map((_, index) => index),
    SOURCE_RECORD_WRITE_CHUNK_SIZE,
  )) {
    if (isCitationRequestCancellationRequested()) break;
    const changed: CitationMetricRecord[] = [];
    for (const targetIndex of batch) {
      const target = targets[targetIndex];
      const resolvedMetrics = metricsByTarget.get(targetIndex);
      const metrics: SourceMetrics = resolvedMetrics
        ? {
            ...resolvedMetrics,
            libraryUpdateVersion: LIBRARY_UPDATE_COMPLETION_VERSION,
          }
        : {
            sourceID: target.sourceID,
            sourceTitle: target.sourceTitle,
            twoYearMeanCitedness: null,
            hIndex: null,
            i10Index: null,
            updatedAt: new Date().toISOString(),
            libraryUpdateVersion: LIBRARY_UPDATE_COMPLETION_VERSION,
          };
      completed += 1;
      const current = records[target.recordIndex];
      const updatedRecord: CitationMetricRecord = {
        ...current,
        sourceTitle: current.sourceTitle ?? metrics.sourceTitle,
        sourceMetrics: metrics,
      };
      records[target.recordIndex] = updatedRecord;
      changed.push(updatedRecord);
      if (resolvedMetrics) updated += 1;
      onProgress?.({
        completed,
        total,
        message: `Retrieving journal metrics · ${completed}/${total}`,
      });
    }
    await Promise.all(
      changed.map((record) => saveCitationMetricRecord(record)),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  return {
    records,
    updated,
    unresolved: Math.max(0, targets.length - (updated - cachedResolved)),
    failedRequests,
  };
}
