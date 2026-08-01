import {
  CITATION_PROVIDER_IDS,
  type CitationProviderID,
  CitationYearCount,
  RelatedWorkMetadata,
  RelatedWorkPropertyConflict,
  RelatedWorkPropertyName,
  RelatedWorkPropertySource,
  SourceMetrics,
} from "../domain/citationTypes";
import { publicationYearOrNull } from "../domain/valueNormalization";

const PROVIDERS = new Set<RelatedWorkMetadata["provider"]>([
  "crossref",
  "semantic-scholar",
  "opencitations",
  "inspire",
  "openalex",
  "manual",
  "zotero",
]);

const DATA_SOURCES = new Set<CitationProviderID>(CITATION_PROVIDER_IDS);

const PROPERTY_SOURCES = new Set<RelatedWorkPropertySource>([
  "crossref",
  "semantic-scholar",
  "opencitations",
  "inspire",
  "openalex",
  "citation-map",
  "manual",
  "zotero",
]);

const PROPERTY_NAMES = new Set<RelatedWorkPropertyName>([
  "doi",
  "pmid",
  "arxiv",
  "isbn",
  "title",
  "year",
  "publicationDate",
  "authors",
  "authorIDs",
  "sourceTitle",
  "abstract",
  "citationCount",
  "referenceCount",
  "citationCountsByYear",
  "references",
  "resolvedReferenceCount",
  "fwci",
  "citationPercentile",
  "isTop1Percent",
  "isTop10Percent",
  "citationsLastYear",
  "citationVelocity",
  "citationAcceleration",
  "influentialCitationCount",
  "publicationType",
  "sourceMetrics",
  "referenceAgeMean",
  "referenceAgeSpread",
  "selfCitationEstimate",
  "futureReferenceCount",
  "metadataCompleteness",
  "isOpenAccess",
  "openAccessStatus",
  "isRetracted",
]);

export class CacheDecodeError extends Error {
  public readonly context: string;

  public constructor(context: string, message: string) {
    super(`Invalid Citation Map cache data at ${context}: ${message}`);
    this.name = "CacheDecodeError";
    this.context = context;
  }
}

function parseJSON(value: string, context: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new CacheDecodeError(context, `invalid JSON (${String(error)})`);
  }
}

function recordValue(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CacheDecodeError(context, "expected an object");
  }
  return value as Record<string, unknown>;
}

function nullableString(value: unknown, context: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new CacheDecodeError(context, "expected a string or null");
  }
  return value;
}

function nullableNumber(value: unknown, context: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CacheDecodeError(context, "expected a finite number or null");
  }
  return value;
}

function stringArray(value: unknown, context: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new CacheDecodeError(context, "expected an array of strings");
  }
  return [...value];
}

export function decodeRelatedWorkMetadata(
  value: unknown,
  context: string,
): RelatedWorkMetadata {
  const record = recordValue(value, context);
  if (!PROVIDERS.has(record.provider as RelatedWorkMetadata["provider"])) {
    throw new CacheDecodeError(context, "unknown provider");
  }
  const provider = record.provider as RelatedWorkMetadata["provider"];
  const providerWorkID = nullableString(
    record.providerWorkID,
    `${context}.providerWorkID`,
  );
  const doi = nullableString(record.doi, `${context}.doi`);
  const title = nullableString(record.title, `${context}.title`);
  const year = publicationYearOrNull(
    nullableNumber(record.year, `${context}.year`),
  );
  const authors = stringArray(record.authors, `${context}.authors`);
  if (
    record.dataSources !== undefined &&
    (!Array.isArray(record.dataSources) ||
      record.dataSources.some(
        (entry) =>
          typeof entry !== "string" ||
          !DATA_SOURCES.has(entry as CitationProviderID),
      ))
  ) {
    throw new CacheDecodeError(
      context,
      "dataSources contains an unknown provider",
    );
  }
  const propertySources =
    record.propertySources === undefined
      ? undefined
      : decodePropertySourcesJSON(
          JSON.stringify(record.propertySources),
          `${context}.propertySources`,
        );
  const propertyConflicts =
    record.propertyConflicts === undefined
      ? undefined
      : decodePropertyConflictsJSON(
          JSON.stringify(record.propertyConflicts),
          `${context}.propertyConflicts`,
        );
  return {
    ...record,
    provider,
    providerWorkID,
    doi,
    title,
    year,
    authors,
    dataSources: record.dataSources as CitationProviderID[] | undefined,
    propertySources,
    propertyConflicts,
  } as RelatedWorkMetadata;
}

export function decodeRelatedWorkMetadataJSON(
  value: string,
  context: string,
): RelatedWorkMetadata {
  return decodeRelatedWorkMetadata(parseJSON(value, context), context);
}

export function decodeRelatedWorkArrayJSON(
  value: string,
  context: string,
): RelatedWorkMetadata[] {
  const parsed = parseJSON(value, context);
  if (!Array.isArray(parsed)) {
    throw new CacheDecodeError(context, "expected an array");
  }
  return parsed.map((entry, index) =>
    decodeRelatedWorkMetadata(entry, `${context}[${index}]`),
  );
}

export function decodeStringArrayJSON(
  value: string,
  context: string,
): string[] {
  return stringArray(parseJSON(value, context), context);
}

export function decodeCitationYearCountsJSON(
  value: string,
  context: string,
): CitationYearCount[] {
  const parsed = parseJSON(value, context);
  if (!Array.isArray(parsed)) {
    throw new CacheDecodeError(context, "expected an array");
  }
  return parsed.map((entry, index) => {
    const record = recordValue(entry, `${context}[${index}]`);
    const year = Number(record.year);
    const count = Number(record.count);
    if (
      !Number.isInteger(year) ||
      year <= 0 ||
      !Number.isFinite(count) ||
      count < 0
    ) {
      throw new CacheDecodeError(
        `${context}[${index}]`,
        "expected a positive integer year and non-negative count",
      );
    }
    return { year, count };
  });
}

export function decodeSourceMetricsJSON(
  value: string,
  context: string,
): SourceMetrics {
  const record = recordValue(parseJSON(value, context), context);
  return record as unknown as SourceMetrics;
}

function propertySourceArray(
  value: unknown,
  context: string,
): RelatedWorkPropertySource[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        !PROPERTY_SOURCES.has(entry as RelatedWorkPropertySource),
    )
  ) {
    throw new CacheDecodeError(context, "expected known property sources");
  }
  return [...value] as RelatedWorkPropertySource[];
}

export function decodePropertySourcesJSON(
  value: string,
  context: string,
): Partial<Record<RelatedWorkPropertyName, RelatedWorkPropertySource[]>> {
  const record = recordValue(parseJSON(value, context), context);
  const decoded: Partial<
    Record<RelatedWorkPropertyName, RelatedWorkPropertySource[]>
  > = {};
  for (const [name, sources] of Object.entries(record)) {
    if (!PROPERTY_NAMES.has(name as RelatedWorkPropertyName)) {
      throw new CacheDecodeError(context, `unknown property ${name}`);
    }
    decoded[name as RelatedWorkPropertyName] = propertySourceArray(
      sources,
      `${context}.${name}`,
    );
  }
  return decoded;
}

export function decodePropertyConflictsJSON(
  value: string,
  context: string,
): RelatedWorkPropertyConflict[] {
  const parsed = parseJSON(value, context);
  if (!Array.isArray(parsed)) {
    throw new CacheDecodeError(context, "expected an array");
  }
  return parsed.map((value, index) => {
    const entryContext = `${context}[${index}]`;
    const record = recordValue(value, entryContext);
    if (!PROPERTY_NAMES.has(record.property as RelatedWorkPropertyName)) {
      throw new CacheDecodeError(entryContext, "unknown property");
    }
    if (
      typeof record.existingValue !== "string" ||
      typeof record.incomingValue !== "string"
    ) {
      throw new CacheDecodeError(entryContext, "expected serialized values");
    }
    return {
      property: record.property as RelatedWorkPropertyName,
      existingValue: record.existingValue,
      incomingValue: record.incomingValue,
      existingSources: propertySourceArray(
        record.existingSources,
        `${entryContext}.existingSources`,
      ),
      incomingSources: propertySourceArray(
        record.incomingSources,
        `${entryContext}.incomingSources`,
      ),
    };
  });
}
