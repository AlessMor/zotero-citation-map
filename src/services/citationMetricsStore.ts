import type {
  CitationMetricRecord,
  CitationMetricStatus,
  CitationMetricSummary,
  CitationProviderID,
  CitationProviderPreference,
  CitationYearCount,
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
  fwci?: number | null;
  citation_percentile?: number | null;
  top_1_percent?: number | null;
  top_10_percent?: number | null;
  citation_counts_by_year_json?: string | null;
  citations_last_year?: number | null;
  citation_velocity?: number | null;
  citation_acceleration?: number | null;
  influential_citation_count?: number | null;
  is_retracted?: number | null;
  open_access_status?: string | null;
  is_open_access?: number | null;
  publication_type?: string | null;
  status: string;
  fetched_at: string | null;
  last_attempt_at: string;
  error_message: string | null;
  failure_count: number;
  next_retry_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS citation_metrics (
  library_id                  INTEGER NOT NULL,
  item_key                   TEXT NOT NULL,
  provider                   TEXT NOT NULL,
  provider_work_id           TEXT,
  matched_by                 TEXT,
  doi                        TEXT,
  title                      TEXT,
  publication_year           INTEGER,
  authors_json               TEXT NOT NULL DEFAULT '[]',
  citation_count             INTEGER,
  citation_count_provider    TEXT,
  reference_count            INTEGER,
  reference_count_provider   TEXT,
  resolved_reference_count   INTEGER NOT NULL DEFAULT 0,
  references_json            TEXT NOT NULL DEFAULT '[]',
  fwci                       REAL,
  citation_percentile        REAL,
  top_1_percent              INTEGER,
  top_10_percent             INTEGER,
  citation_counts_by_year_json TEXT NOT NULL DEFAULT '[]',
  citations_last_year        INTEGER,
  citation_velocity          REAL,
  citation_acceleration      REAL,
  influential_citation_count INTEGER,
  is_retracted               INTEGER,
  open_access_status         TEXT,
  is_open_access             INTEGER,
  publication_type           TEXT,
  status                     TEXT NOT NULL,
  fetched_at                 TEXT,
  last_attempt_at            TEXT NOT NULL,
  error_message              TEXT,
  failure_count              INTEGER NOT NULL DEFAULT 0,
  next_retry_at              TEXT,
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
  fwci,
  citation_percentile,
  top_1_percent,
  top_10_percent,
  citation_counts_by_year_json,
  citations_last_year,
  citation_velocity,
  citation_acceleration,
  influential_citation_count,
  is_retracted,
  open_access_status,
  is_open_access,
  publication_type,
  status,
  fetched_at,
  last_attempt_at,
  error_message,
  failure_count,
  next_retry_at
) VALUES (${Array.from({ length: 34 }, () => "?").join(", ")})
`;

const MAX_STORED_REFERENCES = 2000;
const CLOSE_WRITE_DRAIN_TIMEOUT_MS = 4000;

let db: _ZoteroTypes.DBConnection | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
let mirror = new Map<string, CitationMetricRecord>();
let mirrorRevision = 0;
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

function safeCitationYearCounts(
  value: string | null | undefined,
): CitationYearCount[] {
  return safeParseArray<CitationYearCount>(value)
    .map((entry) => ({
      year: Number(entry.year),
      count: Number(entry.count),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.year) &&
        entry.year > 0 &&
        Number.isFinite(entry.count) &&
        entry.count >= 0,
    );
}

function providerOrNull(value: unknown): CitationProviderID | null {
  return typeof value === "string" && value.length > 0
    ? (value as CitationProviderID)
    : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return Number(value) !== 0;
}

function matchConfidence(matchedBy: IdentifierKind | null): number | null {
  return matchedBy ? 1 : null;
}

function dataAgeDays(fetchedAt: string | null): number | null {
  if (!fetchedAt) {
    return null;
  }
  const timestamp = Date.parse(fetchedAt);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.max(0, (Date.now() - timestamp) / (24 * 60 * 60 * 1000));
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
    citationCount: numberOrNull(row.citation_count),
    citationCountProvider:
      providerOrNull(row.citation_count_provider) ?? provider,
    referenceCount: numberOrNull(row.reference_count),
    referenceCountProvider:
      providerOrNull(row.reference_count_provider) ?? provider,
    resolvedReferenceCount:
      row.resolved_reference_count === undefined ||
      row.resolved_reference_count === null
        ? references.length
        : Number(row.resolved_reference_count),
    references,
    fwci: numberOrNull(row.fwci),
    citationPercentile: numberOrNull(row.citation_percentile),
    isTop1Percent: booleanOrNull(row.top_1_percent),
    isTop10Percent: booleanOrNull(row.top_10_percent),
    citationCountsByYear: safeCitationYearCounts(
      row.citation_counts_by_year_json,
    ),
    citationsLastYear: numberOrNull(row.citations_last_year),
    citationVelocity: numberOrNull(row.citation_velocity),
    citationAcceleration: numberOrNull(row.citation_acceleration),
    influentialCitationCount: numberOrNull(row.influential_citation_count),
    isRetracted: booleanOrNull(row.is_retracted),
    openAccessStatus: row.open_access_status ?? null,
    isOpenAccess: booleanOrNull(row.is_open_access),
    publicationType: row.publication_type ?? null,
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
    record.fwci,
    record.citationPercentile,
    record.isTop1Percent === null ? null : Number(record.isTop1Percent),
    record.isTop10Percent === null ? null : Number(record.isTop10Percent),
    JSON.stringify(record.citationCountsByYear),
    record.citationsLastYear,
    record.citationVelocity,
    record.citationAcceleration,
    record.influentialCitationCount,
    record.isRetracted === null ? null : Number(record.isRetracted),
    record.openAccessStatus,
    record.isOpenAccess === null ? null : Number(record.isOpenAccess),
    record.publicationType,
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
    ["fwci", "REAL"],
    ["citation_percentile", "REAL"],
    ["top_1_percent", "INTEGER"],
    ["top_10_percent", "INTEGER"],
    ["citation_counts_by_year_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["citations_last_year", "INTEGER"],
    ["citation_velocity", "REAL"],
    ["citation_acceleration", "REAL"],
    ["influential_citation_count", "INTEGER"],
    ["is_retracted", "INTEGER"],
    ["open_access_status", "TEXT"],
    ["is_open_access", "INTEGER"],
    ["publication_type", "TEXT"],
  ];

  for (const [name, definition] of additions) {
    if (!existing.has(name)) {
      await connection.queryAsync(
        `ALTER TABLE citation_metrics ADD COLUMN ${name} ${definition}`,
      );
    }
  }

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
    mirrorRevision += 1;
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

  if (writeTails.size > 0) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let completed = false;

    try {
      await Promise.race([
        Promise.allSettled([...writeTails.values()]).then(() => {
          completed = true;
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, CLOSE_WRITE_DRAIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    }

    if (!completed) {
      Zotero.debug(
        `Citation Map: cache-write shutdown drain exceeded ${CLOSE_WRITE_DRAIN_TIMEOUT_MS} ms`,
      );
    }
  }

  if (db) {
    await db.closeDatabase(true);
  }

  db = null;
  mirror = new Map();
  mirrorRevision += 1;
  writeTails.clear();
  initialized = false;
}

export function getCitationMetricRecord(
  libraryID: number,
  itemKey: string,
): CitationMetricRecord | null {
  return mirror.get(mirrorKey(libraryID, itemKey)) ?? null;
}

export function getCitationMetricRecords(
  libraryID?: number,
): CitationMetricRecord[] {
  const records = [...mirror.values()];
  return libraryID === undefined
    ? records
    : records.filter((record) => record.libraryID === libraryID);
}

export function getCitationMetricsRevision(): number {
  return mirrorRevision;
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
    matchedBy: record?.matchedBy ?? null,
    matchConfidence: matchConfidence(record?.matchedBy ?? null),
    fwci: record?.fwci ?? null,
    citationPercentile: record?.citationPercentile ?? null,
    isTop1Percent: record?.isTop1Percent ?? null,
    isTop10Percent: record?.isTop10Percent ?? null,
    citationsLastYear: record?.citationsLastYear ?? null,
    citationVelocity: record?.citationVelocity ?? null,
    citationAcceleration: record?.citationAcceleration ?? null,
    influentialCitationCount: record?.influentialCitationCount ?? null,
    isRetracted: record?.isRetracted ?? null,
    openAccessStatus: record?.openAccessStatus ?? null,
    isOpenAccess: record?.isOpenAccess ?? null,
    publicationType: record?.publicationType ?? null,
    updatedAt: record?.fetchedAt ?? null,
    dataAgeDays: dataAgeDays(record?.fetchedAt ?? null),
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
      citationCountsByYear: record.citationCountsByYear.map((entry) => ({
        ...entry,
      })),
      references: record.references
        .slice(0, MAX_STORED_REFERENCES)
        .map((reference) => ({
          ...reference,
          authors: [...reference.authors],
        })),
    });
    mirrorRevision += 1;
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
    fwci: existing?.fwci ?? null,
    citationPercentile: existing?.citationPercentile ?? null,
    isTop1Percent: existing?.isTop1Percent ?? null,
    isTop10Percent: existing?.isTop10Percent ?? null,
    citationCountsByYear: existing?.citationCountsByYear ?? [],
    citationsLastYear: existing?.citationsLastYear ?? null,
    citationVelocity: existing?.citationVelocity ?? null,
    citationAcceleration: existing?.citationAcceleration ?? null,
    influentialCitationCount: existing?.influentialCitationCount ?? null,
    isRetracted: existing?.isRetracted ?? null,
    openAccessStatus: existing?.openAccessStatus ?? null,
    isOpenAccess: existing?.isOpenAccess ?? null,
    publicationType: existing?.publicationType ?? null,
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

  // Refresh successful rows created before enriched provider fields were
  // introduced. OpenAlex always reports work type/retraction status and
  // Semantic Scholar reports open-access state when the newer field set is
  // requested, so both are reliable migration sentinels.
  if (
    (record.provider === "openalex" &&
      record.publicationType === null &&
      record.isRetracted === null) ||
    (record.provider === "semantic-scholar" &&
      record.publicationType === null &&
      record.isOpenAccess === null)
  ) {
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
    mirrorRevision += 1;
  });
}
