import type {
  CitationMetricRecord,
  CitationMetricStatus,
  CitationMetricSummary,
  CitationProviderID,
  CitationProviderPreference,
  IdentifierKind,
  RelatedWorkMetadata,
} from "../domain/citationTypes";

interface CitationMetricRow {
  library_id: number;
  item_key: string;
  provider: string;
  provider_work_id: string | null;
  matched_by: string | null;
  doi: string | null;
  title: string | null;
  publication_year: number | null;
  authors_json: string;
  citation_count: number | null;
  citation_count_provider?: string | null;
  reference_count: number | null;
  reference_count_provider?: string | null;
  resolved_reference_count?: number | null;
  references_json: string;
  status: string;
  fetched_at: string | null;
  last_attempt_at: string;
  error_message: string | null;
  failure_count: number;
  next_retry_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS citation_metrics (
  library_id               INTEGER NOT NULL,
  item_key                TEXT NOT NULL,
  provider                TEXT NOT NULL,
  provider_work_id        TEXT,
  matched_by              TEXT,
  doi                     TEXT,
  title                   TEXT,
  publication_year        INTEGER,
  authors_json            TEXT NOT NULL DEFAULT '[]',
  citation_count          INTEGER,
  citation_count_provider TEXT,
  reference_count         INTEGER,
  reference_count_provider TEXT,
  resolved_reference_count INTEGER NOT NULL DEFAULT 0,
  references_json         TEXT NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL,
  fetched_at              TEXT,
  last_attempt_at         TEXT NOT NULL,
  error_message           TEXT,
  failure_count           INTEGER NOT NULL DEFAULT 0,
  next_retry_at           TEXT,
  PRIMARY KEY (library_id, item_key)
)
`;

const UPSERT_SQL = `
INSERT OR REPLACE INTO citation_metrics (
  library_id,
  item_key,
  provider,
  provider_work_id,
  matched_by,
  doi,
  title,
  publication_year,
  authors_json,
  citation_count,
  citation_count_provider,
  reference_count,
  reference_count_provider,
  resolved_reference_count,
  references_json,
  status,
  fetched_at,
  last_attempt_at,
  error_message,
  failure_count,
  next_retry_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const MAX_STORED_REFERENCES = 2000;

let db: _ZoteroTypes.DBConnection | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
let mirror = new Map<string, CitationMetricRecord>();
const writeTails = new Map<string, Promise<void>>();

function mirrorKey(libraryID: number, itemKey: string): string {
  return `${libraryID}:${itemKey}`;
}

function safeParseArray<T>(value: string | null | undefined): T[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function providerOrNull(value: unknown): CitationProviderID | null {
  return typeof value === "string" && value.length > 0
    ? (value as CitationProviderID)
    : null;
}

function rowToRecord(row: CitationMetricRow): CitationMetricRecord {
  const references = safeParseArray<RelatedWorkMetadata>(row.references_json);
  const provider = row.provider as CitationProviderID;

  return {
    libraryID: Number(row.library_id),
    itemKey: String(row.item_key),
    provider,
    providerWorkID: row.provider_work_id,
    matchedBy: row.matched_by as IdentifierKind | null,
    doi: row.doi,
    title: row.title,
    year: row.publication_year === null ? null : Number(row.publication_year),
    authors: safeParseArray<string>(row.authors_json),
    citationCount:
      row.citation_count === null ? null : Number(row.citation_count),
    citationCountProvider:
      providerOrNull(row.citation_count_provider) ?? provider,
    referenceCount:
      row.reference_count === null ? null : Number(row.reference_count),
    referenceCountProvider:
      providerOrNull(row.reference_count_provider) ?? provider,
    resolvedReferenceCount:
      row.resolved_reference_count === undefined ||
      row.resolved_reference_count === null
        ? references.length
        : Number(row.resolved_reference_count),
    references,
    status: row.status as CitationMetricStatus,
    fetchedAt: row.fetched_at,
    lastAttemptAt: row.last_attempt_at,
    errorMessage: row.error_message,
    failureCount: Number(row.failure_count ?? 0),
    nextRetryAt: row.next_retry_at,
  };
}

function recordToParams(record: CitationMetricRecord): unknown[] {
  return [
    record.libraryID,
    record.itemKey,
    record.provider,
    record.providerWorkID,
    record.matchedBy,
    record.doi,
    record.title,
    record.year,
    JSON.stringify(record.authors),
    record.citationCount,
    record.citationCountProvider,
    record.referenceCount,
    record.referenceCountProvider,
    record.resolvedReferenceCount,
    JSON.stringify(record.references.slice(0, MAX_STORED_REFERENCES)),
    record.status,
    record.fetchedAt,
    record.lastAttemptAt,
    record.errorMessage,
    record.failureCount,
    record.nextRetryAt,
  ];
}

function requireDB(): _ZoteroTypes.DBConnection {
  if (!db || !initialized) {
    throw new Error("Citation Map metrics store is not initialized.");
  }

  return db;
}

async function ensureSchemaColumns(
  connection: _ZoteroTypes.DBConnection,
): Promise<void> {
  const rows = (await connection.queryAsync(
    "PRAGMA table_info(citation_metrics)",
  )) as Array<{ name?: string }>;
  const existing = new Set(rows.map((row) => String(row.name ?? "")));

  const additions: Array<[string, string]> = [
    ["citation_count_provider", "TEXT"],
    ["reference_count_provider", "TEXT"],
    ["resolved_reference_count", "INTEGER NOT NULL DEFAULT 0"],
  ];

  for (const [name, definition] of additions) {
    if (!existing.has(name)) {
      await connection.queryAsync(
        `ALTER TABLE citation_metrics ADD COLUMN ${name} ${definition}`,
      );
    }
  }

  // Existing records predate the explicit resolved-reference field. Preserve
  // their already cached relationship arrays as the initial resolved count.
  await connection
    .queryAsync(
      `
    UPDATE citation_metrics
    SET resolved_reference_count =
      CASE
        WHEN resolved_reference_count IS NULL OR resolved_reference_count = 0
        THEN json_array_length(references_json)
        ELSE resolved_reference_count
      END
  `,
    )
    .catch(() => undefined);
}

export function initCitationMetricsStore(): Promise<void> {
  if (initialized) {
    return Promise.resolve();
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const connection = new Zotero.DBConnection("citationmap");
    await connection.queryAsync(SCHEMA);
    await ensureSchemaColumns(connection);

    const rows = (await connection.queryAsync(
      "SELECT * FROM citation_metrics",
    )) as CitationMetricRow[];

    const nextMirror = new Map<string, CitationMetricRecord>();

    for (const row of rows) {
      const record = rowToRecord(row);
      nextMirror.set(mirrorKey(record.libraryID, record.itemKey), record);
    }

    db = connection;
    mirror = nextMirror;
    initialized = true;

    Zotero.debug(
      `Citation Map: metrics cache initialized with ${mirror.size} rows`,
    );
  })().finally(() => {
    initPromise = null;
  });

  return initPromise;
}

export async function closeCitationMetricsStore(): Promise<void> {
  if (initPromise) {
    await initPromise.catch(() => undefined);
  }

  await Promise.allSettled([...writeTails.values()]);

  if (db) {
    await db.closeDatabase(true);
  }

  db = null;
  mirror = new Map();
  writeTails.clear();
  initialized = false;
}

export function getCitationMetricRecord(
  libraryID: number,
  itemKey: string,
): CitationMetricRecord | null {
  return mirror.get(mirrorKey(libraryID, itemKey)) ?? null;
}

export function getItemCitationMetrics(
  libraryID: number,
  itemKey: string,
): CitationMetricSummary {
  const record = getCitationMetricRecord(libraryID, itemKey);

  return {
    citationCount: record?.citationCount ?? null,
    citationCountProvider: record?.citationCountProvider ?? null,
    referenceCount: record?.referenceCount ?? null,
    referenceCountProvider: record?.referenceCountProvider ?? null,
    resolvedReferenceCount: record?.resolvedReferenceCount ?? 0,
    provider: record?.provider ?? null,
    updatedAt: record?.fetchedAt ?? null,
    status: record?.status ?? null,
  };
}

async function withKeyLock<T>(
  libraryID: number,
  itemKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = mirrorKey(libraryID, itemKey);
  const previous = writeTails.get(key) ?? Promise.resolve();

  let release = (): void => undefined;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });

  const nextTail = previous.then(() => ticket);
  writeTails.set(key, nextTail);

  await previous;

  try {
    return await task();
  } finally {
    release();

    if (writeTails.get(key) === nextTail) {
      writeTails.delete(key);
    }
  }
}

export async function saveCitationMetricRecord(
  record: CitationMetricRecord,
): Promise<void> {
  await withKeyLock(record.libraryID, record.itemKey, async () => {
    await requireDB().queryAsync(UPSERT_SQL, recordToParams(record));
    mirror.set(mirrorKey(record.libraryID, record.itemKey), {
      ...record,
      authors: [...record.authors],
      references: record.references
        .slice(0, MAX_STORED_REFERENCES)
        .map((reference) => ({
          ...reference,
          authors: [...reference.authors],
        })),
    });
  });
}

export async function saveCitationMetricFailure(
  libraryID: number,
  itemKey: string,
  provider: CitationProviderID,
  status: Exclude<CitationMetricStatus, "success">,
  message: string,
  nextRetryAt: string | null,
): Promise<CitationMetricRecord> {
  const existing = getCitationMetricRecord(libraryID, itemKey);
  const now = new Date().toISOString();

  const next: CitationMetricRecord = {
    libraryID,
    itemKey,
    provider: existing?.provider ?? provider,
    providerWorkID: existing?.providerWorkID ?? null,
    matchedBy: existing?.matchedBy ?? null,
    doi: existing?.doi ?? null,
    title: existing?.title ?? null,
    year: existing?.year ?? null,
    authors: existing?.authors ?? [],
    citationCount: existing?.citationCount ?? null,
    citationCountProvider:
      existing?.citationCountProvider ?? existing?.provider ?? null,
    referenceCount: existing?.referenceCount ?? null,
    referenceCountProvider:
      existing?.referenceCountProvider ?? existing?.provider ?? null,
    resolvedReferenceCount: existing?.resolvedReferenceCount ?? 0,
    references: existing?.references ?? [],
    status,
    fetchedAt: existing?.fetchedAt ?? null,
    lastAttemptAt: now,
    errorMessage: message,
    failureCount: (existing?.failureCount ?? 0) + 1,
    nextRetryAt,
  };

  await saveCitationMetricRecord(next);
  return next;
}

export function shouldRefreshCitationMetrics(
  libraryID: number,
  itemKey: string,
  preference: CitationProviderPreference,
  cacheDays: number,
): boolean {
  const record = getCitationMetricRecord(libraryID, itemKey);

  if (!record) {
    return true;
  }

  if (preference !== "auto" && record.provider !== preference) {
    return true;
  }

  if (record.status !== "success") {
    if (!record.nextRetryAt) {
      return true;
    }

    return Date.parse(record.nextRetryAt) <= Date.now();
  }

  if (!record.fetchedAt) {
    return true;
  }

  const maxAge = cacheDays * 24 * 60 * 60 * 1000;
  return Date.now() - Date.parse(record.fetchedAt) >= maxAge;
}

export async function deleteCitationMetricRecord(
  libraryID: number,
  itemKey: string,
): Promise<void> {
  await withKeyLock(libraryID, itemKey, async () => {
    await requireDB().queryAsync(
      "DELETE FROM citation_metrics WHERE library_id = ? AND item_key = ?",
      [libraryID, itemKey],
    );
    mirror.delete(mirrorKey(libraryID, itemKey));
  });
}
