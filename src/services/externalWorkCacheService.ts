import type { RelatedWorkMetadata } from "../domain/citationTypes";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";

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

function relationshipWorkIdentity(work: RelatedWorkMetadata): string {
  const localKey = work.zoteroItemKey?.trim();
  if (localKey) return `zotero:${localKey.toLocaleUpperCase()}`;
  const doi = normalizeDOI(work.doi);
  if (doi) return `doi:${doi}`;
  if (work.providerWorkID?.trim()) {
    return `${work.provider}:${work.providerWorkID.trim().toLocaleLowerCase()}`;
  }
  const title = normalizeExactTitle(work.title);
  if (title) return `title:${title}:year:${work.year ?? "unknown"}`;
  return `${work.provider}:unknown:${JSON.stringify([work.authors.slice(0, 2), work.year])}`;
}

function mergeRelationshipWorks(
  existing: RelatedWorkMetadata[],
  incoming: RelatedWorkMetadata[],
): RelatedWorkMetadata[] {
  const merged = new Map<string, RelatedWorkMetadata>();
  for (const work of [...existing, ...incoming]) {
    const key = relationshipWorkIdentity(work);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, { ...work });
      continue;
    }
    merged.set(key, {
      ...previous,
      ...work,
      providerWorkID: work.providerWorkID ?? previous.providerWorkID,
      doi: work.doi ?? previous.doi,
      pmid: work.pmid ?? previous.pmid,
      arxiv: work.arxiv ?? previous.arxiv,
      isbn: work.isbn ?? previous.isbn,
      title: work.title?.trim() ? work.title : previous.title,
      year: work.year ?? previous.year,
      authors: work.authors.length ? work.authors : previous.authors,
      sourceTitle: work.sourceTitle?.trim()
        ? work.sourceTitle
        : previous.sourceTitle,
      abstract: work.abstract?.trim() ? work.abstract : previous.abstract,
      citationCount: work.citationCount ?? previous.citationCount,
      referenceCount: work.referenceCount ?? previous.referenceCount,
      isOpenAccess: work.isOpenAccess ?? previous.isOpenAccess,
      openAccessStatus: work.openAccessStatus ?? previous.openAccessStatus,
      isRetracted: work.isRetracted ?? previous.isRetracted,
      zoteroItemKey: work.zoteroItemKey ?? previous.zoteroItemKey,
    });
  }
  return [...merged.values()];
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
        works: entry.works.map((work) => ({ ...work })),
      }
    : null;
}

export async function saveExternalRelationshipCache(
  relationshipKey: string,
  works: RelatedWorkMetadata[],
): Promise<void> {
  if (!(await ensureExternalWorkCache())) return;
  const fetchedAt = new Date().toISOString();
  const existing = relationshipMirror.get(relationshipKey)?.works ?? [];
  const storedWorks = mergeRelationshipWorks(existing, works);
  relationshipMirror.set(relationshipKey, {
    relationshipKey,
    works: storedWorks,
    fetchedAt,
  });
  await queueWrite(async () => {
    await requireDB().queryAsync(
      `INSERT OR REPLACE INTO external_relationships
       (relationship_key, works_json, fetched_at)
       VALUES (?, ?, ?)`,
      [relationshipKey, JSON.stringify(storedWorks), fetchedAt],
    );
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
  entries: Array<{
    identityKey: string;
    metadata: RelatedWorkMetadata;
  }>,
): Promise<void> {
  if (entries.length === 0 || !(await ensureExternalWorkCache())) return;
  const fetchedAt = new Date().toISOString();
  const unique = new Map<string, RelatedWorkMetadata>();
  for (const entry of entries) unique.set(entry.identityKey, entry.metadata);
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
