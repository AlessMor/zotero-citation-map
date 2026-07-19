import type {
  CitationMetricRecord,
  CitationMetricStatus,
  CitationMetricSummary,
  CitationProviderID,
  CitationProviderPreference,
  CitationYearCount,
  IdentifierKind,
  IgnoredProviderRelation,
  ManualCitationRelation,
  ManualRelationDirection,
  RelatedWorkMetadata,
  SourceMetrics,
} from "../domain/citationTypes";

interface CitationMetricRow {
  library_id: number;
  item_key: string;
  provider: string;
  provider_work_id: string | null;
  matched_by: string | null;
  match_confidence: number | null;
  match_confirmed: number | null;
  doi: string | null;
  title: string | null;
  normalized_title: string | null;
  publication_year: number | null;
  authors_json: string;
  source_title: string | null;
  abstract_text: string | null;
  citation_count: number | null;
  citation_count_provider: string | null;
  reference_count: number | null;
  reference_count_provider: string | null;
  resolved_reference_count: number | null;
  references_json: string;
  match_candidates_json: string | null;
  fwci: number | null;
  citation_percentile: number | null;
  top_1_percent: number | null;
  top_10_percent: number | null;
  citation_counts_by_year_json: string | null;
  citations_last_year: number | null;
  citation_velocity: number | null;
  citation_acceleration: number | null;
  influential_citation_count: number | null;
  is_retracted: number | null;
  open_access_status: string | null;
  is_open_access: number | null;
  publication_type: string | null;
  source_metrics_json: string | null;
  status: string;
  fetched_at: string | null;
  last_attempt_at: string;
  error_message: string | null;
  failure_count: number;
  next_retry_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS citation_metrics (
  library_id                    INTEGER NOT NULL,
  item_key                     TEXT NOT NULL,
  provider                     TEXT NOT NULL,
  provider_work_id             TEXT,
  matched_by                   TEXT,
  match_confidence             REAL,
  match_confirmed              INTEGER NOT NULL DEFAULT 1,
  doi                          TEXT,
  title                        TEXT,
  normalized_title             TEXT,
  publication_year             INTEGER,
  authors_json                 TEXT NOT NULL DEFAULT '[]',
  source_title                 TEXT,
  abstract_text                TEXT,
  citation_count               INTEGER,
  citation_count_provider      TEXT,
  reference_count              INTEGER,
  reference_count_provider     TEXT,
  resolved_reference_count     INTEGER NOT NULL DEFAULT 0,
  references_json              TEXT NOT NULL DEFAULT '[]',
  match_candidates_json        TEXT NOT NULL DEFAULT '[]',
  fwci                         REAL,
  citation_percentile          REAL,
  top_1_percent                INTEGER,
  top_10_percent               INTEGER,
  citation_counts_by_year_json TEXT NOT NULL DEFAULT '[]',
  citations_last_year          INTEGER,
  citation_velocity            REAL,
  citation_acceleration        REAL,
  influential_citation_count   INTEGER,
  is_retracted                 INTEGER,
  open_access_status           TEXT,
  is_open_access               INTEGER,
  publication_type             TEXT,
  source_metrics_json          TEXT,
  status                       TEXT NOT NULL,
  fetched_at                   TEXT,
  last_attempt_at              TEXT NOT NULL,
  error_message                TEXT,
  failure_count                INTEGER NOT NULL DEFAULT 0,
  next_retry_at                TEXT,
  PRIMARY KEY (library_id, item_key)
);

CREATE TABLE IF NOT EXISTS manual_relations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id       INTEGER NOT NULL,
  subject_item_key TEXT NOT NULL,
  related_item_key TEXT NOT NULL,
  direction        TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE(library_id, subject_item_key, related_item_key, direction)
);

CREATE TABLE IF NOT EXISTS ignored_provider_relations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id        INTEGER NOT NULL,
  subject_item_key  TEXT NOT NULL,
  direction         TEXT NOT NULL,
  provider          TEXT NOT NULL,
  provider_work_id  TEXT,
  doi               TEXT,
  normalized_title  TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE(library_id, subject_item_key, direction, provider, provider_work_id, doi, normalized_title)
);
`;

const UPSERT_SQL = `
INSERT OR REPLACE INTO citation_metrics (
  library_id, item_key, provider, provider_work_id, matched_by,
  match_confidence, match_confirmed, doi, title, normalized_title,
  publication_year, authors_json, source_title, abstract_text,
  citation_count, citation_count_provider, reference_count,
  reference_count_provider, resolved_reference_count, references_json,
  match_candidates_json, fwci, citation_percentile, top_1_percent, top_10_percent,
  citation_counts_by_year_json, citations_last_year, citation_velocity,
  citation_acceleration, influential_citation_count, is_retracted,
  open_access_status, is_open_access, publication_type, source_metrics_json,
  status, fetched_at, last_attempt_at, error_message, failure_count,
  next_retry_at
) VALUES (${Array.from({ length: 41 }, () => "?").join(", ")})
`;

const MAX_STORED_REFERENCES = 2500;
let db: _ZoteroTypes.DBConnection | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
let mirror = new Map<string, CitationMetricRecord>();
let mirrorRevision = 0;
let manualMirror: ManualCitationRelation[] = [];
let ignoredMirror: IgnoredProviderRelation[] = [];
const writeTails = new Map<string, Promise<void>>();

function mirrorKey(libraryID: number, itemKey: string): string {
  return `${libraryID}:${itemKey}`;
}

function safeParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function safeArray<T>(value: string | null | undefined): T[] {
  const parsed = safeParse<unknown>(value, []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  return Number(value) !== 0;
}

function providerOrNull(value: unknown): CitationProviderID | null {
  return typeof value === "string" && value
    ? (value as CitationProviderID)
    : null;
}

function dataAgeDays(fetchedAt: string | null): number | null {
  if (!fetchedAt) return null;
  const timestamp = Date.parse(fetchedAt);
  return Number.isFinite(timestamp)
    ? Math.max(0, (Date.now() - timestamp) / 86400000)
    : null;
}

function normalizeYearCounts(value: string | null): CitationYearCount[] {
  return safeArray<CitationYearCount>(value)
    .map((entry) => ({ year: Number(entry.year), count: Number(entry.count) }))
    .filter(
      (entry) =>
        Number.isInteger(entry.year) &&
        entry.year > 0 &&
        Number.isFinite(entry.count) &&
        entry.count >= 0,
    );
}

function rowToRecord(row: CitationMetricRow): CitationMetricRecord {
  const provider = row.provider as CitationProviderID;
  const references = safeArray<RelatedWorkMetadata>(row.references_json);
  return {
    libraryID: Number(row.library_id),
    itemKey: String(row.item_key),
    provider,
    providerWorkID: row.provider_work_id,
    matchedBy: row.matched_by as IdentifierKind | null,
    matchConfidence: numberOrNull(row.match_confidence),
    matchConfirmed:
      row.match_confirmed === null ? true : Number(row.match_confirmed) !== 0,
    doi: row.doi,
    title: row.title,
    normalizedTitle: row.normalized_title,
    year: numberOrNull(row.publication_year),
    authors: safeArray<string>(row.authors_json),
    sourceTitle: row.source_title,
    abstract: row.abstract_text,
    citationCount: numberOrNull(row.citation_count),
    citationCountProvider:
      providerOrNull(row.citation_count_provider) ?? provider,
    referenceCount: numberOrNull(row.reference_count),
    referenceCountProvider:
      providerOrNull(row.reference_count_provider) ?? provider,
    resolvedReferenceCount:
      numberOrNull(row.resolved_reference_count) ?? references.length,
    references,
    matchCandidates: safeArray<RelatedWorkMetadata>(row.match_candidates_json),
    fwci: numberOrNull(row.fwci),
    citationPercentile: numberOrNull(row.citation_percentile),
    isTop1Percent: booleanOrNull(row.top_1_percent),
    isTop10Percent: booleanOrNull(row.top_10_percent),
    citationCountsByYear: normalizeYearCounts(row.citation_counts_by_year_json),
    citationsLastYear: numberOrNull(row.citations_last_year),
    citationVelocity: numberOrNull(row.citation_velocity),
    citationAcceleration: numberOrNull(row.citation_acceleration),
    influentialCitationCount: numberOrNull(row.influential_citation_count),
    isRetracted: booleanOrNull(row.is_retracted),
    openAccessStatus: row.open_access_status,
    isOpenAccess: booleanOrNull(row.is_open_access),
    publicationType: row.publication_type,
    sourceMetrics: safeParse<SourceMetrics | null>(
      row.source_metrics_json,
      null,
    ),
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
    record.matchConfidence,
    Number(record.matchConfirmed),
    record.doi,
    record.title,
    record.normalizedTitle,
    record.year,
    JSON.stringify(record.authors),
    record.sourceTitle,
    record.abstract,
    record.citationCount,
    record.citationCountProvider,
    record.referenceCount,
    record.referenceCountProvider,
    record.resolvedReferenceCount,
    JSON.stringify(record.references.slice(0, MAX_STORED_REFERENCES)),
    JSON.stringify(record.matchCandidates),
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
    JSON.stringify(record.sourceMetrics),
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

async function ensureColumns(
  connection: _ZoteroTypes.DBConnection,
): Promise<void> {
  const rows = (await connection.queryAsync(
    "PRAGMA table_info(citation_metrics)",
  )) as Array<{ name?: string }>;
  const existing = new Set(rows.map((row) => String(row.name ?? "")));
  const additions: Array<[string, string]> = [
    ["match_confidence", "REAL"],
    ["match_confirmed", "INTEGER NOT NULL DEFAULT 1"],
    ["normalized_title", "TEXT"],
    ["source_title", "TEXT"],
    ["abstract_text", "TEXT"],
    ["citation_count_provider", "TEXT"],
    ["reference_count_provider", "TEXT"],
    ["resolved_reference_count", "INTEGER NOT NULL DEFAULT 0"],
    ["match_candidates_json", "TEXT NOT NULL DEFAULT '[]'"],
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
    ["source_metrics_json", "TEXT"],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name)) {
      await connection.queryAsync(
        `ALTER TABLE citation_metrics ADD COLUMN ${name} ${definition}`,
      );
    }
  }
}

function relationRow(row: any): ManualCitationRelation {
  return {
    id: Number(row.id),
    libraryID: Number(row.library_id),
    subjectItemKey: String(row.subject_item_key),
    relatedItemKey: String(row.related_item_key),
    direction: row.direction as ManualRelationDirection,
    createdAt: String(row.created_at),
  };
}

function ignoredRow(row: any): IgnoredProviderRelation {
  return {
    id: Number(row.id),
    libraryID: Number(row.library_id),
    subjectItemKey: String(row.subject_item_key),
    direction: row.direction as ManualRelationDirection,
    provider: row.provider as CitationProviderID,
    providerWorkID: row.provider_work_id ?? null,
    doi: row.doi ?? null,
    normalizedTitle: row.normalized_title ?? null,
    createdAt: String(row.created_at),
  };
}

export function initCitationMetricsStore(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const connection = new Zotero.DBConnection("citationmap");
    for (const statement of SCHEMA.split(";")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await connection.queryAsync(statement);
    }
    await ensureColumns(connection);
    const rows = (await connection.queryAsync(
      "SELECT * FROM citation_metrics",
    )) as CitationMetricRow[];
    mirror = new Map();
    for (const row of rows) {
      const record = rowToRecord(row);
      mirror.set(mirrorKey(record.libraryID, record.itemKey), record);
    }
    manualMirror = (
      (await connection.queryAsync("SELECT * FROM manual_relations")) as any[]
    ).map(relationRow);
    ignoredMirror = (
      (await connection.queryAsync(
        "SELECT * FROM ignored_provider_relations",
      )) as any[]
    ).map(ignoredRow);
    db = connection;
    initialized = true;
    mirrorRevision += 1;
    Zotero.debug(
      `Citation Map: cache initialized with ${mirror.size} metric records and ${manualMirror.length} manual relations`,
    );
  })().finally(() => {
    initPromise = null;
  });
  return initPromise;
}

export async function closeCitationMetricsStore(): Promise<void> {
  if (initPromise) await initPromise.catch(() => undefined);
  await Promise.all(
    [...writeTails.values()].map((tail) => tail.catch(() => undefined)),
  );
  const connection = db;
  db = null;
  initialized = false;
  mirror.clear();
  manualMirror = [];
  ignoredMirror = [];
  if (connection) await connection.closeDatabase().catch(() => undefined);
}

function queueWrite(key: string, task: () => Promise<void>): Promise<void> {
  const previous =
    writeTails.get(key)?.catch(() => undefined) ?? Promise.resolve();
  const next = previous.then(task).finally(() => {
    if (writeTails.get(key) === next) writeTails.delete(key);
  });
  writeTails.set(key, next);
  return next;
}

export function getCitationMetricRecord(
  libraryID: number,
  itemKey: string,
): CitationMetricRecord | null {
  return mirror.get(mirrorKey(libraryID, itemKey)) ?? null;
}

export function getCitationMetricRecords(
  libraryID: number,
): CitationMetricRecord[] {
  return [...mirror.values()].filter(
    (record) => record.libraryID === libraryID,
  );
}

export function getCitationMetricsRevision(): number {
  return mirrorRevision;
}

export function getItemCitationMetrics(
  libraryID: number,
  itemKey: string,
): CitationMetricSummary {
  const record = getCitationMetricRecord(libraryID, itemKey);
  if (!record) {
    return {
      citationCount: null,
      citationCountProvider: null,
      referenceCount: null,
      referenceCountProvider: null,
      resolvedReferenceCount: 0,
      provider: null,
      matchedBy: null,
      matchConfidence: null,
      matchConfirmed: true,
      fwci: null,
      citationPercentile: null,
      isTop1Percent: null,
      isTop10Percent: null,
      citationsLastYear: null,
      citationVelocity: null,
      citationAcceleration: null,
      influentialCitationCount: null,
      isRetracted: null,
      openAccessStatus: null,
      isOpenAccess: null,
      publicationType: null,
      sourceMetrics: null,
      updatedAt: null,
      dataAgeDays: null,
      status: null,
    };
  }
  return {
    citationCount: record.citationCount,
    citationCountProvider: record.citationCountProvider,
    referenceCount: record.referenceCount,
    referenceCountProvider: record.referenceCountProvider,
    resolvedReferenceCount: record.resolvedReferenceCount,
    provider: record.provider,
    matchedBy: record.matchedBy,
    matchConfidence: record.matchConfidence,
    matchConfirmed: record.matchConfirmed,
    fwci: record.fwci,
    citationPercentile: record.citationPercentile,
    isTop1Percent: record.isTop1Percent,
    isTop10Percent: record.isTop10Percent,
    citationsLastYear: record.citationsLastYear,
    citationVelocity: record.citationVelocity,
    citationAcceleration: record.citationAcceleration,
    influentialCitationCount: record.influentialCitationCount,
    isRetracted: record.isRetracted,
    openAccessStatus: record.openAccessStatus,
    isOpenAccess: record.isOpenAccess,
    publicationType: record.publicationType,
    sourceMetrics: record.sourceMetrics,
    updatedAt: record.fetchedAt,
    dataAgeDays: dataAgeDays(record.fetchedAt),
    status: record.status,
  };
}

export async function saveCitationMetricRecord(
  record: CitationMetricRecord,
): Promise<void> {
  const key = mirrorKey(record.libraryID, record.itemKey);
  mirror.set(key, record);
  mirrorRevision += 1;
  await queueWrite(key, async () => {
    await requireDB().queryAsync(UPSERT_SQL, recordToParams(record));
  });
}

export async function saveCitationMetricFailure(
  libraryID: number,
  itemKey: string,
  provider: CitationProviderID,
  status: Exclude<CitationMetricStatus, "success">,
  message: string,
  nextRetryAt: string | null,
  matchCandidates: RelatedWorkMetadata[] = [],
): Promise<void> {
  const previous = getCitationMetricRecord(libraryID, itemKey);
  const now = new Date().toISOString();
  await saveCitationMetricRecord({
    libraryID,
    itemKey,
    provider,
    providerWorkID: previous?.providerWorkID ?? null,
    matchedBy: previous?.matchedBy ?? null,
    matchConfidence: previous?.matchConfidence ?? null,
    matchConfirmed:
      status === "ambiguous-match" ? false : (previous?.matchConfirmed ?? true),
    doi: previous?.doi ?? null,
    title: previous?.title ?? null,
    normalizedTitle: previous?.normalizedTitle ?? null,
    year: previous?.year ?? null,
    authors: previous?.authors ?? [],
    sourceTitle: previous?.sourceTitle ?? null,
    abstract: previous?.abstract ?? null,
    citationCount: previous?.citationCount ?? null,
    citationCountProvider: previous?.citationCountProvider ?? null,
    referenceCount: previous?.referenceCount ?? null,
    referenceCountProvider: previous?.referenceCountProvider ?? null,
    resolvedReferenceCount: previous?.resolvedReferenceCount ?? 0,
    references: previous?.references ?? [],
    matchCandidates:
      matchCandidates.length > 0
        ? matchCandidates
        : (previous?.matchCandidates ?? []),
    fwci: previous?.fwci ?? null,
    citationPercentile: previous?.citationPercentile ?? null,
    isTop1Percent: previous?.isTop1Percent ?? null,
    isTop10Percent: previous?.isTop10Percent ?? null,
    citationCountsByYear: previous?.citationCountsByYear ?? [],
    citationsLastYear: previous?.citationsLastYear ?? null,
    citationVelocity: previous?.citationVelocity ?? null,
    citationAcceleration: previous?.citationAcceleration ?? null,
    influentialCitationCount: previous?.influentialCitationCount ?? null,
    isRetracted: previous?.isRetracted ?? null,
    openAccessStatus: previous?.openAccessStatus ?? null,
    isOpenAccess: previous?.isOpenAccess ?? null,
    publicationType: previous?.publicationType ?? null,
    sourceMetrics: previous?.sourceMetrics ?? null,
    status,
    fetchedAt: previous?.fetchedAt ?? null,
    lastAttemptAt: now,
    errorMessage: message,
    failureCount: (previous?.failureCount ?? 0) + 1,
    nextRetryAt,
  });
}

export function shouldRefreshCitationMetrics(
  libraryID: number,
  itemKey: string,
  providerPreference: CitationProviderPreference,
  cacheDays: number,
): boolean {
  const record = getCitationMetricRecord(libraryID, itemKey);
  if (!record) return true;
  if (record.nextRetryAt && Date.parse(record.nextRetryAt) > Date.now())
    return false;
  if (
    record.status === "ambiguous-match" &&
    record.matchCandidates.length > 0
  ) {
    return false;
  }
  if (providerPreference !== "auto" && record.provider !== providerPreference)
    return true;
  if (!record.fetchedAt) return true;
  return dataAgeDays(record.fetchedAt)! >= cacheDays;
}

export async function confirmCitationMatch(
  libraryID: number,
  itemKey: string,
): Promise<void> {
  const record = getCitationMetricRecord(libraryID, itemKey);
  if (!record) return;
  await saveCitationMetricRecord({ ...record, matchConfirmed: true });
}

export function getManualRelations(
  libraryID: number,
  subjectItemKey?: string,
): ManualCitationRelation[] {
  return manualMirror.filter(
    (relation) =>
      relation.libraryID === libraryID &&
      (!subjectItemKey || relation.subjectItemKey === subjectItemKey),
  );
}

export async function addManualRelation(
  libraryID: number,
  subjectItemKey: string,
  relatedItemKey: string,
  direction: ManualRelationDirection,
): Promise<void> {
  if (subjectItemKey === relatedItemKey) {
    throw new Error("A paper cannot cite itself through a manual relation.");
  }
  const createdAt = new Date().toISOString();
  await requireDB().queryAsync(
    `INSERT OR IGNORE INTO manual_relations
     (library_id, subject_item_key, related_item_key, direction, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [libraryID, subjectItemKey, relatedItemKey, direction, createdAt],
  );
  const rows = (await requireDB().queryAsync(
    `SELECT * FROM manual_relations
     WHERE library_id = ? AND subject_item_key = ? AND related_item_key = ? AND direction = ?`,
    [libraryID, subjectItemKey, relatedItemKey, direction],
  )) as any[];
  const relation = rows[0] ? relationRow(rows[0]) : null;
  if (relation && !manualMirror.some((entry) => entry.id === relation.id)) {
    manualMirror.push(relation);
    mirrorRevision += 1;
  }
}

export async function removeManualRelation(id: number): Promise<void> {
  await requireDB().queryAsync("DELETE FROM manual_relations WHERE id = ?", [
    id,
  ]);
  manualMirror = manualMirror.filter((relation) => relation.id !== id);
  mirrorRevision += 1;
}

export function getIgnoredRelations(
  libraryID: number,
  subjectItemKey?: string,
): IgnoredProviderRelation[] {
  return ignoredMirror.filter(
    (relation) =>
      relation.libraryID === libraryID &&
      (!subjectItemKey || relation.subjectItemKey === subjectItemKey),
  );
}

export async function ignoreProviderRelation(
  relation: Omit<IgnoredProviderRelation, "id" | "createdAt">,
): Promise<void> {
  const createdAt = new Date().toISOString();
  await requireDB().queryAsync(
    `INSERT OR IGNORE INTO ignored_provider_relations
     (library_id, subject_item_key, direction, provider, provider_work_id, doi, normalized_title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      relation.libraryID,
      relation.subjectItemKey,
      relation.direction,
      relation.provider,
      relation.providerWorkID,
      relation.doi,
      relation.normalizedTitle,
      createdAt,
    ],
  );
  const rows = (await requireDB().queryAsync(
    `SELECT * FROM ignored_provider_relations
     WHERE library_id = ? AND subject_item_key = ? AND direction = ? AND provider = ?
       AND COALESCE(provider_work_id, '') = COALESCE(?, '')
       AND COALESCE(doi, '') = COALESCE(?, '')
       AND COALESCE(normalized_title, '') = COALESCE(?, '')`,
    [
      relation.libraryID,
      relation.subjectItemKey,
      relation.direction,
      relation.provider,
      relation.providerWorkID,
      relation.doi,
      relation.normalizedTitle,
    ],
  )) as any[];
  const stored = rows[0] ? ignoredRow(rows[0]) : null;
  if (stored && !ignoredMirror.some((entry) => entry.id === stored.id)) {
    ignoredMirror.push(stored);
    mirrorRevision += 1;
  }
}

export async function removeIgnoredRelation(id: number): Promise<void> {
  await requireDB().queryAsync(
    "DELETE FROM ignored_provider_relations WHERE id = ?",
    [id],
  );
  ignoredMirror = ignoredMirror.filter((relation) => relation.id !== id);
  mirrorRevision += 1;
}

export async function clearCitationMetrics(): Promise<void> {
  await requireDB().queryAsync("DELETE FROM citation_metrics");
  mirror.clear();
  mirrorRevision += 1;
}

export function getCitationCacheStatus(): {
  metricRecords: number;
  manualRelations: number;
  ignoredRelations: number;
  lastUpdated: string | null;
} {
  const dates = [...mirror.values()]
    .map((record) => record.fetchedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    metricRecords: mirror.size,
    manualRelations: manualMirror.length,
    ignoredRelations: ignoredMirror.length,
    lastUpdated: dates.at(-1) ?? null,
  };
}

export async function confirmCitationMatchCandidate(
  libraryID: number,
  itemKey: string,
  candidate: RelatedWorkMetadata,
): Promise<void> {
  const previous = getCitationMetricRecord(libraryID, itemKey);
  if (!previous) {
    throw new Error("Citation data must be fetched before confirming a match.");
  }
  await saveCitationMetricRecord({
    ...previous,
    provider:
      candidate.provider === "manual" || candidate.provider === "zotero"
        ? previous.provider
        : candidate.provider,
    providerWorkID: candidate.providerWorkID,
    doi: candidate.doi ?? previous.doi,
    title: candidate.title ?? previous.title,
    normalizedTitle: candidate.title
      ? candidate.title
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLocaleLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim()
          .replace(/\s+/g, " ")
      : previous.normalizedTitle,
    year: candidate.year ?? previous.year,
    authors: candidate.authors.length ? candidate.authors : previous.authors,
    sourceTitle: candidate.sourceTitle ?? previous.sourceTitle,
    abstract: candidate.abstract ?? previous.abstract,
    citationCount: candidate.citationCount ?? previous.citationCount,
    referenceCount: candidate.referenceCount ?? previous.referenceCount,
    isOpenAccess: candidate.isOpenAccess ?? previous.isOpenAccess,
    openAccessStatus: candidate.openAccessStatus ?? previous.openAccessStatus,
    isRetracted: candidate.isRetracted ?? previous.isRetracted,
    matchedBy: previous.matchedBy ?? "title",
    matchConfidence: Math.max(previous.matchConfidence ?? 0, 0.9),
    matchConfirmed: true,
    matchCandidates: [],
    status: "success",
    errorMessage: null,
    nextRetryAt: null,
  });
}
