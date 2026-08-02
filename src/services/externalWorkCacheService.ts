import type { RelatedWorkMetadata } from "../domain/citationTypes";
import {
  relationshipCandidateIdentity,
  stableExternalWorkIdentity,
  stableWorkAliases,
} from "../domain/workIdentity";
import {
  CACHE_RELATED_WORK_MERGE,
  cloneRelatedWorkMetadata,
  mergeRelatedWorkRecords,
} from "../domain/relatedWorkMetadata";
import { SerializedTaskQueue } from "./serializedTaskQueue";
import {
  decodeRelatedWorkArrayJSON,
  decodeRelatedWorkMetadataJSON,
} from "./cacheDecoders";
import { createCooperativeCheckpoint } from "./backgroundTaskService";
import { RelationshipMetadataDependencyIndex } from "./relationshipMetadataDependencyIndex";

export type ExternalWorkCacheStatus =
  "success" | "not-found" | "rate-limited" | "network-error" | "provider-error";

export interface ExternalWorkCacheEntry {
  identityKey: string;
  status: ExternalWorkCacheStatus;
  metadata: RelatedWorkMetadata | null;
  fetchedAt: string;
  nextRetryAt: string | null;
  failureCount: number;
  errorMessage: string | null;
}

export interface ExternalRelationshipCacheEntry {
  relationshipKey: string;
  works: RelatedWorkMetadata[];
  fetchedAt: string;
}

export interface ExternalRelationshipCacheSummary {
  relationshipKey: string;
  count: number;
  fetchedAt: string;
}

interface ExternalWorkCacheRow {
  identity_key: string;
  status: string;
  metadata_json: string | null;
  fetched_at: string;
  next_retry_at: string | null;
  failure_count: number;
  error_message: string | null;
}

interface ExternalRelationshipCacheRow {
  relationship_key: string;
  works_json: string;
  fetched_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS external_works_v2 (
  identity_key  TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  metadata_json TEXT,
  fetched_at    TEXT NOT NULL,
  next_retry_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS external_relationships_v2 (
  relationship_key TEXT PRIMARY KEY,
  works_json       TEXT NOT NULL,
  fetched_at       TEXT NOT NULL
);
`;

const SUCCESS_MAX_AGE_MS = 180 * 86400000;
const EXTERNAL_WORK_UPSERT_COLUMN_COUNT = 7;
const SQLITE_SAFE_BIND_PARAMETER_COUNT = 900;
const EXTERNAL_WORK_UPSERT_BATCH_SIZE = Math.max(
  1,
  Math.floor(
    SQLITE_SAFE_BIND_PARAMETER_COUNT / EXTERNAL_WORK_UPSERT_COLUMN_COUNT,
  ),
);
let db: _ZoteroTypes.DBConnection | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
let closing = false;
let mirror = new Map<string, ExternalWorkCacheEntry>();
let relationshipMirror = new Map<string, ExternalRelationshipCacheEntry>();
const hydratedRelationshipMirror = new Map<string, RelatedWorkMetadata[]>();
const relationshipDependencyIndex = new RelationshipMetadataDependencyIndex();
const writeQueue = new SerializedTaskQueue();

interface ExternalWorkUpsertRow {
  identityKey: string;
  metadataJSON: string;
  fetchedAt: string;
}

interface ExternalWorkFailureUpsertRow {
  identityKey: string;
  status: Exclude<ExternalWorkCacheStatus, "success">;
  fetchedAt: string;
  nextRetryAt: string;
  failureCount: number;
  errorMessage: string;
}

function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }
  return chunks;
}

function registerRelationshipDependencies(
  relationshipKey: string,
  works: readonly RelatedWorkMetadata[],
): void {
  relationshipDependencyIndex.register(
    relationshipKey,
    works.flatMap((work) => stableWorkAliases(work)),
  );
}

/**
 * Invalidate only relationship lists that have actually been hydrated in this
 * session and that contain one of the updated papers. The previous global
 * revision invalidated every large relationship list after every summary
 * batch, which made normal item navigation repeatedly rebuild thousands of
 * merged records.
 */
export function invalidateExternalRelationshipMetadata(
  identityKeys: Iterable<string>,
): void {
  for (const relationshipKey of relationshipDependencyIndex.affectedRelationships(
    identityKeys,
  )) {
    hydratedRelationshipMirror.delete(relationshipKey);
  }
}

async function upsertExternalWorkRows(
  connection: _ZoteroTypes.DBConnection,
  rows: readonly ExternalWorkUpsertRow[],
): Promise<void> {
  for (const batch of chunkValues(rows, EXTERNAL_WORK_UPSERT_BATCH_SIZE)) {
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const parameters = batch.flatMap((row) => [
      row.identityKey,
      "success",
      row.metadataJSON,
      row.fetchedAt,
      null,
      0,
      null,
    ]);
    await connection.queryAsync(
      `INSERT OR REPLACE INTO external_works_v2
       (identity_key, status, metadata_json, fetched_at, next_retry_at, failure_count, error_message)
       VALUES ${placeholders}`,
      parameters,
    );
  }
}

async function upsertExternalWorkFailureRows(
  connection: _ZoteroTypes.DBConnection,
  rows: readonly ExternalWorkFailureUpsertRow[],
): Promise<void> {
  for (const batch of chunkValues(rows, EXTERNAL_WORK_UPSERT_BATCH_SIZE)) {
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const parameters = batch.flatMap((row) => [
      row.identityKey,
      row.status,
      null,
      row.fetchedAt,
      row.nextRetryAt,
      row.failureCount,
      row.errorMessage,
    ]);
    await connection.queryAsync(
      `INSERT OR REPLACE INTO external_works_v2
       (identity_key, status, metadata_json, fetched_at, next_retry_at, failure_count, error_message)
       VALUES ${placeholders}`,
      parameters,
    );
  }
}

function cacheStatus(value: string, context: string): ExternalWorkCacheStatus {
  if (
    value === "success" ||
    value === "not-found" ||
    value === "rate-limited" ||
    value === "network-error" ||
    value === "provider-error"
  ) {
    return value;
  }
  throw new Error(`${context} has unknown status ${value}.`);
}

function rowToEntry(row: ExternalWorkCacheRow): ExternalWorkCacheEntry {
  const identityKey = String(row.identity_key);
  const context = `external_works_v2[${identityKey}]`;
  const status = cacheStatus(row.status, context);
  const metadata = row.metadata_json
    ? decodeRelatedWorkMetadataJSON(row.metadata_json, `${context}.metadata`)
    : null;
  if (status === "success" && !metadata) {
    throw new Error(`${context} is successful but has no metadata.`);
  }
  return {
    identityKey,
    status,
    metadata,
    fetchedAt: String(row.fetched_at),
    nextRetryAt: row.next_retry_at,
    failureCount: Number(row.failure_count ?? 0),
    errorMessage: row.error_message,
  };
}

function mergeCachedMetadata(
  existing: RelatedWorkMetadata | null | undefined,
  incoming: RelatedWorkMetadata,
): RelatedWorkMetadata {
  return mergeRelatedWorkRecords(existing, incoming, CACHE_RELATED_WORK_MERGE);
}

/**
 * Relationship rows store only the edge identity and a small fallback label.
 * Complete metadata lives once in external_works and is joined in memory.
 */
function compactRelationshipWork(
  work: RelatedWorkMetadata,
): RelatedWorkMetadata {
  return {
    provider: work.provider,
    providerWorkID: work.providerWorkID,
    doi: work.doi,
    pmid: work.pmid ?? null,
    arxiv: work.arxiv ?? null,
    isbn: work.isbn ?? null,
    title: work.title,
    year: work.year,
    publicationDate: work.publicationDate ?? null,
    authors: work.authors.slice(0, 2),
    zoteroItemKey: work.zoteroItemKey ?? null,
    inLibraryItemKey: work.inLibraryItemKey ?? null,
    dataSources: [...(work.dataSources ?? [])],
    updatedAt: work.updatedAt ?? null,
  };
}

function hydrateRelationshipWork(
  compact: RelatedWorkMetadata,
): RelatedWorkMetadata {
  const identity = stableExternalWorkIdentity(compact);
  const cached = identity ? mirror.get(identity) : null;
  const metadata = cached?.status === "success" ? cached.metadata : null;
  if (!metadata) return cloneRelatedWorkMetadata(compact);
  const merged = mergeCachedMetadata(compact, metadata);
  return {
    ...merged,
    provider: compact.provider,
    providerWorkID: compact.providerWorkID ?? merged.providerWorkID,
    dataSources: [
      ...new Set([
        ...(compact.dataSources ?? []),
        ...(merged.dataSources ?? []),
      ]),
    ],
  };
}

function deduplicateRelationshipWorks(
  works: RelatedWorkMetadata[],
): RelatedWorkMetadata[] {
  const unique = new Map<string, RelatedWorkMetadata>();
  for (const work of works) {
    const key = relationshipCandidateIdentity(work);
    unique.set(key, mergeCachedMetadata(unique.get(key), work));
  }
  return [...unique.values()];
}

function rowToRelationshipEntry(
  row: ExternalRelationshipCacheRow,
): ExternalRelationshipCacheEntry {
  const relationshipKey = String(row.relationship_key);
  const works = decodeRelatedWorkArrayJSON(
    row.works_json,
    `external_relationships_v2[${relationshipKey}].works`,
  );
  return {
    relationshipKey,
    works,
    fetchedAt: String(row.fetched_at),
  };
}

function requireDB(): _ZoteroTypes.DBConnection {
  if (!db || !initialized) {
    throw new Error("Citation Map external-work cache is not initialized.");
  }
  return db;
}

async function ensureExternalWorkCache(): Promise<boolean> {
  if (closing) return false;
  await initExternalWorkCache();
  return initialized && !closing;
}

function queueWrite<T>(task: () => Promise<T>): Promise<T> {
  return writeQueue.enqueue(async () => {
    if (!(await ensureExternalWorkCache())) {
      throw new Error("Citation Map external-work cache is closing.");
    }
    return task();
  });
}

export function initExternalWorkCache(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (initPromise) return initPromise;
  closing = false;
  writeQueue.reopen();
  initPromise = (async () => {
    const connection = new Zotero.DBConnection("citationmap-external");
    try {
      for (const statement of SCHEMA.split(";")
        .map((part) => part.trim())
        .filter(Boolean)) {
        await connection.queryAsync(statement);
      }
      const rows = (await connection.queryAsync(
        "SELECT * FROM external_works_v2",
      )) as ExternalWorkCacheRow[];
      const relationshipRows = (await connection.queryAsync(
        "SELECT * FROM external_relationships_v2",
      )) as ExternalRelationshipCacheRow[];
      const nextMirror = new Map<string, ExternalWorkCacheEntry>();
      for (const row of rows) {
        try {
          const entry = rowToEntry(row);
          nextMirror.set(entry.identityKey, entry);
        } catch (error) {
          Zotero.logError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      const nextRelationshipMirror = new Map<
        string,
        ExternalRelationshipCacheEntry
      >();
      for (const row of relationshipRows) {
        try {
          const entry = rowToRelationshipEntry(row);
          nextRelationshipMirror.set(entry.relationshipKey, entry);
        } catch (error) {
          Zotero.logError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      db = connection;
      mirror = nextMirror;
      relationshipMirror = nextRelationshipMirror;
      hydratedRelationshipMirror.clear();
      relationshipDependencyIndex.clear();
      initialized = true;
      Zotero.debug(
        `Citation Map: external cache initialized with ${mirror.size} works and ${relationshipMirror.size} relationship lists`,
      );
    } catch (error) {
      await connection.closeDatabase(true).catch(() => undefined);
      throw error;
    }
  })().finally(() => {
    initPromise = null;
  });
  return initPromise;
}

export async function closeExternalWorkCache(): Promise<void> {
  closing = true;
  if (initPromise) await initPromise.catch(() => undefined);
  writeQueue.close();
  await writeQueue.drain();
  const connection = db;
  db = null;
  initialized = false;
  mirror.clear();
  relationshipMirror.clear();
  hydratedRelationshipMirror.clear();
  relationshipDependencyIndex.clear();
  if (connection) await connection.closeDatabase(true).catch(() => undefined);
}

export async function clearExternalWorkCache(): Promise<void> {
  if (!(await ensureExternalWorkCache())) return;
  await queueWrite(async () => {
    const connection = requireDB();
    await connection.executeTransaction(async () => {
      await connection.queryAsync("DELETE FROM external_works_v2");
      await connection.queryAsync("DELETE FROM external_relationships_v2");
    });
    mirror.clear();
    relationshipMirror.clear();
    hydratedRelationshipMirror.clear();
    relationshipDependencyIndex.clear();
  });
}

export function getExternalRelationshipCacheSummary(
  relationshipKey: string,
): ExternalRelationshipCacheSummary | null {
  const entry = relationshipMirror.get(relationshipKey);
  return entry
    ? {
        relationshipKey,
        count: entry.works.length,
        fetchedAt: entry.fetchedAt,
      }
    : null;
}

export function getExternalRelationshipCacheSize(
  relationshipKey: string,
): number {
  return getExternalRelationshipCacheSummary(relationshipKey)?.count ?? 0;
}

export function getExternalRelationshipCacheWorks(
  relationshipKey: string,
  maximum = Number.POSITIVE_INFINITY,
): RelatedWorkMetadata[] {
  const entry = relationshipMirror.get(relationshipKey);
  if (!entry) return [];
  const requestedMaximum = Number.isFinite(maximum)
    ? Math.max(0, Math.floor(maximum))
    : entry.works.length;
  if (requestedMaximum === 0) return [];

  // Small view projections should not hydrate and retain an entire 1,000+
  // paper relationship list. Full callers still share one hydrated snapshot.
  if (requestedMaximum < entry.works.length) {
    return entry.works
      .slice(0, requestedMaximum)
      .map((work) => cloneRelatedWorkMetadata(hydrateRelationshipWork(work)));
  }

  let works = hydratedRelationshipMirror.get(relationshipKey);
  if (!works) {
    works = entry.works.map((work) => hydrateRelationshipWork(work));
    hydratedRelationshipMirror.set(relationshipKey, works);
    registerRelationshipDependencies(relationshipKey, entry.works);
  }
  return works.map((work) => cloneRelatedWorkMetadata(work));
}

export function getExternalRelationshipCacheEntry(
  relationshipKey: string,
): ExternalRelationshipCacheEntry | null {
  const entry = relationshipMirror.get(relationshipKey);
  if (!entry) return null;
  return {
    ...entry,
    works: getExternalRelationshipCacheWorks(relationshipKey),
  };
}

/**
 * Replace one complete relationship snapshot atomically. Full neighbour
 * metadata is upserted once by identity; the relationship JSON stores only
 * compact membership records.
 */
export async function saveExternalRelationshipCache(
  relationshipKey: string,
  works: RelatedWorkMetadata[],
  options: { writeMetadata?: boolean; alreadyCanonical?: boolean } = {},
): Promise<void> {
  const startedAt = Date.now();
  if (!(await ensureExternalWorkCache())) return;
  const fetchedAt = new Date().toISOString();
  const completeWorks = options.alreadyCanonical
    ? works
    : deduplicateRelationshipWorks(works);
  const checkpoint = createCooperativeCheckpoint();
  const metadataByIdentity = new Map<string, RelatedWorkMetadata>();
  if (options.writeMetadata !== false) {
    for (const [index, work] of completeWorks.entries()) {
      const identityKey = stableExternalWorkIdentity(work);
      if (identityKey) {
        const previous = mirror.get(identityKey)?.metadata;
        metadataByIdentity.set(
          identityKey,
          mergeCachedMetadata(previous, work),
        );
      }
      await checkpoint((index + 1) % 50 === 0);
    }
  }
  const storedWorks: RelatedWorkMetadata[] = [];
  for (const [index, work] of completeWorks.entries()) {
    storedWorks.push(compactRelationshipWork(work));
    await checkpoint((index + 1) % 100 === 0);
  }
  const metadataRows: ExternalWorkUpsertRow[] = [];
  let serializedMetadataCount = 0;
  for (const [identityKey, metadata] of metadataByIdentity) {
    metadataRows.push({
      identityKey,
      metadataJSON: JSON.stringify(metadata),
      fetchedAt,
    });
    serializedMetadataCount += 1;
    await checkpoint(serializedMetadataCount % 50 === 0);
  }

  await queueWrite(async () => {
    const connection = requireDB();
    await connection.executeTransaction(async () => {
      await upsertExternalWorkRows(connection, metadataRows);
      await connection.queryAsync(
        `INSERT OR REPLACE INTO external_relationships_v2
         (relationship_key, works_json, fetched_at)
         VALUES (?, ?, ?)`,
        [relationshipKey, JSON.stringify(storedWorks), fetchedAt],
      );
    });

    for (const [identityKey, metadata] of metadataByIdentity) {
      mirror.set(identityKey, {
        identityKey,
        status: "success",
        metadata,
        fetchedAt,
        nextRetryAt: null,
        failureCount: 0,
        errorMessage: null,
      });
    }
    invalidateExternalRelationshipMetadata(metadataByIdentity.keys());
    relationshipMirror.set(relationshipKey, {
      relationshipKey,
      works: storedWorks,
      fetchedAt,
    });
    registerRelationshipDependencies(relationshipKey, storedWorks);
    // Do not retain a second fully cloned bibliography after every update.
    // Full or limited hydrated views are constructed lazily when requested.
    hydratedRelationshipMirror.delete(relationshipKey);
  });
  const durationMs = Date.now() - startedAt;
  if (durationMs >= 500) {
    Zotero.debug(
      `Citation Map: saved ${storedWorks.length} relationship members in ${durationMs} ms`,
    );
  }
}

export function getExternalWorkCacheEntry(
  identityKey: string,
): ExternalWorkCacheEntry | null {
  return mirror.get(identityKey) ?? null;
}

export function cachedExternalWorkMetadata(
  identityKey: string,
): RelatedWorkMetadata | null {
  const entry = getExternalWorkCacheEntry(identityKey);
  return entry?.status === "success" ? entry.metadata : null;
}

export function shouldResolveExternalWork(identityKey: string): boolean {
  const entry = getExternalWorkCacheEntry(identityKey);
  if (!entry) return true;
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (entry.status === "success") {
    return (
      !Number.isFinite(fetchedAt) ||
      Date.now() - fetchedAt >= SUCCESS_MAX_AGE_MS
    );
  }
  if (!entry.nextRetryAt) return true;
  const nextRetryAt = Date.parse(entry.nextRetryAt);
  return !Number.isFinite(nextRetryAt) || nextRetryAt <= Date.now();
}

export async function saveExternalWorkCacheSuccesses(
  entries: Array<{ identityKey: string; metadata: RelatedWorkMetadata }>,
  options: { invalidateRelationships?: boolean } = {},
): Promise<string[]> {
  if (entries.length === 0 || !(await ensureExternalWorkCache())) return [];
  const fetchedAt = new Date().toISOString();
  const unique = new Map<string, RelatedWorkMetadata>();
  for (const entry of entries) {
    const previous = mirror.get(entry.identityKey)?.metadata;
    unique.set(
      entry.identityKey,
      mergeCachedMetadata(previous, entry.metadata),
    );
  }
  const checkpoint = createCooperativeCheckpoint();
  const rows: ExternalWorkUpsertRow[] = [];
  let serializedCount = 0;
  for (const [identityKey, metadata] of unique) {
    rows.push({
      identityKey,
      metadataJSON: JSON.stringify(metadata),
      fetchedAt,
    });
    serializedCount += 1;
    await checkpoint(serializedCount % 50 === 0);
  }
  await queueWrite(async () => {
    const connection = requireDB();
    await connection.executeTransaction(async () => {
      await upsertExternalWorkRows(connection, rows);
    });
    for (const [key, value] of unique) {
      mirror.set(key, {
        identityKey: key,
        status: "success",
        metadata: value,
        fetchedAt,
        nextRetryAt: null,
        failureCount: 0,
        errorMessage: null,
      });
    }
    if (options.invalidateRelationships !== false) {
      const aliases = new Set<string>();
      for (const [identityKey, metadata] of unique) {
        aliases.add(identityKey);
        for (const alias of stableWorkAliases(metadata)) aliases.add(alias);
      }
      invalidateExternalRelationshipMetadata(aliases);
    }
  });
  return [...unique.keys()];
}

export async function saveExternalWorkCacheNotFound(
  identityKey: string,
): Promise<void> {
  await saveExternalWorkCacheFailure(
    identityKey,
    "not-found",
    "No provider returned this work.",
  );
}

function failureRetryAt(
  status: Exclude<ExternalWorkCacheStatus, "success">,
  failureCount: number,
): string {
  if (status === "not-found") {
    return new Date(Date.now() + 30 * 86400000).toISOString();
  }
  const delays = [5 * 60000, 30 * 60000, 6 * 3600000, 86400000];
  const delay = delays[Math.min(failureCount - 1, delays.length - 1)];
  return new Date(Date.now() + delay).toISOString();
}

export async function saveExternalWorkCacheFailure(
  identityKey: string,
  status: Exclude<ExternalWorkCacheStatus, "success">,
  message: string,
): Promise<void> {
  await saveExternalWorkCacheFailures([{ identityKey, status, message }]);
}

export async function saveExternalWorkCacheFailures(
  failures: Array<{
    identityKey: string;
    status: Exclude<ExternalWorkCacheStatus, "success">;
    message: string;
  }>,
  options: { invalidateRelationships?: boolean } = {},
): Promise<void> {
  if (failures.length === 0 || !(await ensureExternalWorkCache())) return;
  const fetchedAt = new Date().toISOString();
  const unique = new Map<
    string,
    { status: Exclude<ExternalWorkCacheStatus, "success">; message: string }
  >();
  for (const failure of failures) {
    unique.set(failure.identityKey, {
      status: failure.status,
      message: failure.message,
    });
  }
  const rows: ExternalWorkFailureUpsertRow[] = [];
  for (const [identityKey, failure] of unique) {
    const failureCount = (mirror.get(identityKey)?.failureCount ?? 0) + 1;
    rows.push({
      identityKey,
      status: failure.status,
      fetchedAt,
      nextRetryAt: failureRetryAt(failure.status, failureCount),
      failureCount,
      errorMessage: failure.message,
    });
  }
  await queueWrite(async () => {
    const connection = requireDB();
    await connection.executeTransaction(async () => {
      await upsertExternalWorkFailureRows(connection, rows);
    });
    for (const row of rows) {
      mirror.set(row.identityKey, {
        identityKey: row.identityKey,
        status: row.status,
        metadata: null,
        fetchedAt: row.fetchedAt,
        nextRetryAt: row.nextRetryAt,
        failureCount: row.failureCount,
        errorMessage: row.errorMessage,
      });
    }
    if (options.invalidateRelationships !== false) {
      invalidateExternalRelationshipMetadata(unique.keys());
    }
  });
}
