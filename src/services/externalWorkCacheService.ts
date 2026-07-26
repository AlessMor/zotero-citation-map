import type { RelatedWorkMetadata } from "../domain/citationTypes";
import { externalWorkCacheIdentity, normalizeDOI } from "./citationIdentifiers";

export interface ExternalWorkCacheEntry {
  identityKey: string;
  status: "success" | "not-found";
  metadata: RelatedWorkMetadata | null;
  fetchedAt: string;
  nextRetryAt: string | null;
}

export interface ExternalRelationshipCacheEntry {
  relationshipKey: string;
  works: RelatedWorkMetadata[];
  fetchedAt: string;
}

interface ExternalWorkCacheRow {
  identity_key: string;
  status: string;
  metadata_json: string | null;
  fetched_at: string;
  next_retry_at: string | null;
}

interface ExternalRelationshipCacheRow {
  relationship_key: string;
  works_json: string;
  fetched_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS external_works (
  identity_key  TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  metadata_json TEXT,
  fetched_at    TEXT NOT NULL,
  next_retry_at TEXT
);

CREATE TABLE IF NOT EXISTS external_relationships (
  relationship_key TEXT PRIMARY KEY,
  works_json       TEXT NOT NULL,
  fetched_at       TEXT NOT NULL
);
`;

const SUCCESS_MAX_AGE_MS = 180 * 86400000;
const NOT_FOUND_RETRY_MS = 30 * 86400000;
let db: _ZoteroTypes.DBConnection | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
let closing = false;
let mirror = new Map<string, ExternalWorkCacheEntry>();
let relationshipMirror = new Map<string, ExternalRelationshipCacheEntry>();
let writeTail: Promise<void> = Promise.resolve();

function parseMetadata(value: string | null): RelatedWorkMetadata | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as RelatedWorkMetadata;
  } catch {
    return null;
  }
}

function rowToEntry(row: ExternalWorkCacheRow): ExternalWorkCacheEntry {
  return {
    identityKey: String(row.identity_key),
    status: row.status === "success" ? "success" : "not-found",
    metadata: parseMetadata(row.metadata_json),
    fetchedAt: String(row.fetched_at),
    nextRetryAt: row.next_retry_at,
  };
}

function parseRelationshipWorks(
  relationshipKey: string,
  value: string,
): RelatedWorkMetadata[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Citation Map relationship cache contains invalid JSON for ${relationshipKey}: ${String(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(
      `Citation Map relationship cache entry ${relationshipKey} is not an array.`,
    );
  }
  return parsed as RelatedWorkMetadata[];
}

function relationshipIdentity(work: RelatedWorkMetadata): string {
  const sharedIdentity = externalWorkCacheIdentity(work);
  if (sharedIdentity) return sharedIdentity;
  const localKey = (work.inLibraryItemKey ?? work.zoteroItemKey)?.trim();
  if (localKey) return `zotero:${localKey.toLocaleUpperCase()}`;
  const pmid = String(work.pmid ?? "")
    .trim()
    .toLocaleLowerCase();
  if (pmid) return `pmid:${pmid}`;
  const arxiv = String(work.arxiv ?? "")
    .trim()
    .toLocaleLowerCase();
  if (arxiv) return `arxiv:${arxiv}`;
  const isbn = String(work.isbn ?? "")
    .replace(/[-\s]/g, "")
    .toLocaleLowerCase();
  if (isbn) return `isbn:${isbn}`;
  return `${work.provider}:unknown:${JSON.stringify([work.authors.slice(0, 2), work.year])}`;
}

function cloneWork(work: RelatedWorkMetadata): RelatedWorkMetadata {
  return {
    ...work,
    authors: [...work.authors],
    authorIDs: [...(work.authorIDs ?? [])],
    citationCountsByYear: [...(work.citationCountsByYear ?? [])],
    references: work.references?.map((reference) => cloneWork(reference)),
    dataSources: [...(work.dataSources ?? [])],
  };
}

function nonEmptyArray<T>(
  incoming: T[] | null | undefined,
  existing: T[] | null | undefined,
): T[] | undefined {
  if (incoming?.length) return [...incoming];
  if (existing?.length) return [...existing];
  return incoming ?? existing ?? undefined;
}

function mergeCachedMetadata(
  existing: RelatedWorkMetadata | null | undefined,
  incoming: RelatedWorkMetadata,
): RelatedWorkMetadata {
  if (!existing) return cloneWork(incoming);
  const incomingTitle = String(incoming.title ?? "").trim();
  const incomingSource = String(incoming.sourceTitle ?? "").trim();
  const incomingAbstract = String(incoming.abstract ?? "").trim();
  const incomingReferences = incoming.references ?? [];
  const existingReferences = existing.references ?? [];
  const references =
    incomingReferences.length >= existingReferences.length
      ? incomingReferences
      : existingReferences;
  return {
    ...existing,
    ...incoming,
    providerWorkID: incoming.providerWorkID ?? existing.providerWorkID,
    doi: incoming.doi ?? existing.doi,
    pmid: incoming.pmid ?? existing.pmid,
    arxiv: incoming.arxiv ?? existing.arxiv,
    isbn: incoming.isbn ?? existing.isbn,
    title: incomingTitle ? incoming.title : existing.title,
    year: incoming.year ?? existing.year,
    authors: incoming.authors.length
      ? [...incoming.authors]
      : [...existing.authors],
    authorIDs: [
      ...new Set([
        ...(existing.authorIDs ?? []),
        ...(incoming.authorIDs ?? []),
      ]),
    ],
    sourceTitle: incomingSource ? incoming.sourceTitle : existing.sourceTitle,
    abstract: incomingAbstract ? incoming.abstract : existing.abstract,
    citationCount: incoming.citationCount ?? existing.citationCount,
    referenceCount: incoming.referenceCount ?? existing.referenceCount,
    citationCountsByYear: nonEmptyArray(
      incoming.citationCountsByYear,
      existing.citationCountsByYear,
    ),
    references: references.map((reference) => cloneWork(reference)),
    resolvedReferenceCount:
      incoming.resolvedReferenceCount ?? existing.resolvedReferenceCount,
    fwci: incoming.fwci ?? existing.fwci,
    citationPercentile:
      incoming.citationPercentile ?? existing.citationPercentile,
    isTop1Percent: incoming.isTop1Percent ?? existing.isTop1Percent,
    isTop10Percent: incoming.isTop10Percent ?? existing.isTop10Percent,
    citationsLastYear: incoming.citationsLastYear ?? existing.citationsLastYear,
    citationVelocity: incoming.citationVelocity ?? existing.citationVelocity,
    citationAcceleration:
      incoming.citationAcceleration ?? existing.citationAcceleration,
    influentialCitationCount:
      incoming.influentialCitationCount ?? existing.influentialCitationCount,
    publicationType: incoming.publicationType ?? existing.publicationType,
    sourceMetrics: incoming.sourceMetrics ?? existing.sourceMetrics,
    referenceAgeMean: incoming.referenceAgeMean ?? existing.referenceAgeMean,
    referenceAgeSpread:
      incoming.referenceAgeSpread ?? existing.referenceAgeSpread,
    selfCitationEstimate:
      incoming.selfCitationEstimate ?? existing.selfCitationEstimate,
    futureReferenceCount:
      incoming.futureReferenceCount ?? existing.futureReferenceCount,
    metadataCompleteness:
      incoming.metadataCompleteness ?? existing.metadataCompleteness,
    isOpenAccess: incoming.isOpenAccess ?? existing.isOpenAccess,
    openAccessStatus: incoming.openAccessStatus ?? existing.openAccessStatus,
    isRetracted: incoming.isRetracted ?? existing.isRetracted,
    zoteroItemKey: incoming.zoteroItemKey ?? existing.zoteroItemKey,
    inLibraryItemKey:
      incoming.inLibraryItemKey ?? existing.inLibraryItemKey ?? null,
    dataSources: [
      ...new Set([
        ...(existing.dataSources ?? []),
        ...(incoming.dataSources ?? []),
      ]),
    ],
    updatedAt: incoming.updatedAt ?? existing.updatedAt,
  };
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
    doi: normalizeDOI(work.doi),
    pmid: work.pmid ?? null,
    arxiv: work.arxiv ?? null,
    isbn: work.isbn ?? null,
    title: work.title,
    year: work.year,
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
  const cached = mirror.get(relationshipIdentity(compact));
  const metadata = cached?.status === "success" ? cached.metadata : null;
  if (!metadata) return cloneWork(compact);
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
    const key = relationshipIdentity(work);
    unique.set(key, mergeCachedMetadata(unique.get(key), work));
  }
  return [...unique.values()];
}

function rowToRelationshipEntry(
  row: ExternalRelationshipCacheRow,
): ExternalRelationshipCacheEntry {
  const relationshipKey = String(row.relationship_key);
  return {
    relationshipKey,
    works: parseRelationshipWorks(relationshipKey, row.works_json),
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

function queueWrite(task: () => Promise<void>): Promise<void> {
  const previous = writeTail.catch(() => undefined);
  const next = previous.then(async () => {
    if (!(await ensureExternalWorkCache())) return;
    await task();
  });
  writeTail = next.catch(() => undefined);
  return next;
}

export function initExternalWorkCache(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (initPromise) return initPromise;
  closing = false;
  initPromise = (async () => {
    const connection = new Zotero.DBConnection("citationmap-external");
    for (const statement of SCHEMA.split(";")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await connection.queryAsync(statement);
    }
    const rows = (await connection.queryAsync(
      "SELECT * FROM external_works",
    )) as ExternalWorkCacheRow[];
    const relationshipRows = (await connection.queryAsync(
      "SELECT * FROM external_relationships",
    )) as ExternalRelationshipCacheRow[];
    mirror = new Map(
      rows.map((row) => {
        const entry = rowToEntry(row);
        return [entry.identityKey, entry];
      }),
    );
    relationshipMirror = new Map(
      relationshipRows.map((row) => {
        const entry = rowToRelationshipEntry(row);
        return [entry.relationshipKey, entry];
      }),
    );
    db = connection;
    initialized = true;
    Zotero.debug(
      `Citation Map: external cache initialized with ${mirror.size} works and ${relationshipMirror.size} relationship lists`,
    );
  })().finally(() => {
    initPromise = null;
  });
  return initPromise;
}

export async function closeExternalWorkCache(): Promise<void> {
  closing = true;
  if (initPromise) await initPromise.catch(() => undefined);
  await writeTail.catch(() => undefined);
  const connection = db;
  db = null;
  initialized = false;
  mirror.clear();
  relationshipMirror.clear();
  if (connection) await connection.closeDatabase().catch(() => undefined);
}

export async function clearExternalWorkCache(): Promise<void> {
  if (!(await ensureExternalWorkCache())) return;
  mirror.clear();
  relationshipMirror.clear();
  await queueWrite(async () => {
    await requireDB().queryAsync("DELETE FROM external_works");
    await requireDB().queryAsync("DELETE FROM external_relationships");
  });
}

export function getExternalRelationshipCacheEntry(
  relationshipKey: string,
): ExternalRelationshipCacheEntry | null {
  const entry = relationshipMirror.get(relationshipKey);
  return entry
    ? {
        ...entry,
        works: entry.works.map((work) => hydrateRelationshipWork(work)),
      }
    : null;
}

/**
 * Replace one complete relationship snapshot atomically. Full neighbour
 * metadata is upserted once by identity; the relationship JSON stores only
 * compact membership records.
 */
export async function saveExternalRelationshipCache(
  relationshipKey: string,
  works: RelatedWorkMetadata[],
): Promise<void> {
  if (!(await ensureExternalWorkCache())) return;
  const fetchedAt = new Date().toISOString();
  const completeWorks = deduplicateRelationshipWorks(works);
  const metadataByIdentity = new Map<string, RelatedWorkMetadata>();
  for (const work of completeWorks) {
    const identityKey = relationshipIdentity(work);
    const previous = mirror.get(identityKey)?.metadata;
    const metadata = mergeCachedMetadata(previous, work);
    metadataByIdentity.set(identityKey, metadata);
    mirror.set(identityKey, {
      identityKey,
      status: "success",
      metadata,
      fetchedAt,
      nextRetryAt: null,
    });
  }
  const storedWorks = completeWorks.map(compactRelationshipWork);
  relationshipMirror.set(relationshipKey, {
    relationshipKey,
    works: storedWorks,
    fetchedAt,
  });
  await queueWrite(async () => {
    const connection = requireDB();
    await connection.executeTransaction(async () => {
      for (const [identityKey, metadata] of metadataByIdentity) {
        await connection.queryAsync(
          `INSERT OR REPLACE INTO external_works
           (identity_key, status, metadata_json, fetched_at, next_retry_at)
           VALUES (?, ?, ?, ?, ?)`,
          [identityKey, "success", JSON.stringify(metadata), fetchedAt, null],
        );
      }
      await connection.queryAsync(
        `INSERT OR REPLACE INTO external_relationships
         (relationship_key, works_json, fetched_at)
         VALUES (?, ?, ?)`,
        [relationshipKey, JSON.stringify(storedWorks), fetchedAt],
      );
    });
  });
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

export async function saveExternalWorkCacheSuccess(
  identityKey: string,
  metadata: RelatedWorkMetadata,
): Promise<void> {
  await saveExternalWorkCacheSuccesses([{ identityKey, metadata }]);
}

export async function saveExternalWorkCacheSuccesses(
  entries: Array<{ identityKey: string; metadata: RelatedWorkMetadata }>,
): Promise<void> {
  if (entries.length === 0 || !(await ensureExternalWorkCache())) return;
  const fetchedAt = new Date().toISOString();
  const unique = new Map<string, RelatedWorkMetadata>();
  for (const entry of entries) {
    const previous = mirror.get(entry.identityKey)?.metadata;
    unique.set(
      entry.identityKey,
      mergeCachedMetadata(previous, entry.metadata),
    );
  }
  for (const [key, value] of unique) {
    mirror.set(key, {
      identityKey: key,
      status: "success",
      metadata: value,
      fetchedAt,
      nextRetryAt: null,
    });
  }
  await queueWrite(async () => {
    const connection = requireDB();
    await connection.executeTransaction(async () => {
      for (const [key, value] of unique) {
        await connection.queryAsync(
          `INSERT OR REPLACE INTO external_works
           (identity_key, status, metadata_json, fetched_at, next_retry_at)
           VALUES (?, ?, ?, ?, ?)`,
          [key, "success", JSON.stringify(value), fetchedAt, null],
        );
      }
    });
  });
}

export async function saveExternalWorkCacheNotFound(
  identityKey: string,
): Promise<void> {
  if (!(await ensureExternalWorkCache())) return;
  const fetchedAt = new Date().toISOString();
  const nextRetryAt = new Date(Date.now() + NOT_FOUND_RETRY_MS).toISOString();
  const entry: ExternalWorkCacheEntry = {
    identityKey,
    status: "not-found",
    metadata: null,
    fetchedAt,
    nextRetryAt,
  };
  mirror.set(identityKey, entry);
  await queueWrite(async () => {
    await requireDB().queryAsync(
      `INSERT OR REPLACE INTO external_works
       (identity_key, status, metadata_json, fetched_at, next_retry_at)
       VALUES (?, ?, ?, ?, ?)`,
      [identityKey, "not-found", null, fetchedAt, nextRetryAt],
    );
  });
}
