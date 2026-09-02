import {
  positiveInteger,
  uniquePositiveIntegers,
} from "../domain/valueNormalization";

/**
 * Read a MenuManager context field that may throw in Zotero 10.
 *
 * `collectionTreeRow` on `main/library/collection` and `main/library/item`
 * contexts throws so plugins cannot silently use one row of a multi-row
 * selection. Prefer `collectionTreeRows` and catch here as a last resort.
 */
export function readContextValue(context: unknown, key: string): unknown {
  try {
    return (context as Record<string, unknown> | null | undefined)?.[key];
  } catch {
    return null;
  }
}

function asList(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function callPaneMethod(pane: unknown, name: string): unknown {
  const method = (pane as Record<string, unknown> | null | undefined)?.[name];
  if (typeof method !== "function") return undefined;
  try {
    return method.call(pane);
  } catch {
    return undefined;
  }
}

/**
 * Call the Zotero 10 plural getter when it exists. Never call the Zotero 9
 * singular getter on Zotero 10: those methods throw even for a single row.
 */
export function paneValues(
  pane: unknown,
  pluralName: string,
  singularName: string,
): unknown[] {
  if (
    typeof (pane as Record<string, unknown> | null | undefined)?.[
      pluralName
    ] === "function"
  ) {
    return asList(callPaneMethod(pane, pluralName));
  }
  return asList(callPaneMethod(pane, singularName));
}

function libraryIDFromCandidate(candidate: unknown): number | null {
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Record<string, any>;
  const ref = row.ref ?? row;
  return positiveInteger(row.libraryID ?? ref?.libraryID);
}

function itemLibraryIDs(pane: unknown): number[] {
  return uniquePositiveIntegers(
    asList(callPaneMethod(pane, "getSelectedItems")).map(
      (item) => (item as { libraryID?: unknown } | null)?.libraryID,
    ),
  );
}

/** Library IDs for the current collection-tree selection on Zotero 9 or 10. */
export function selectedLibraryIDsFromPane(pane: unknown): number[] {
  const fromPane = uniquePositiveIntegers(
    paneValues(pane, "getSelectedLibraryIDs", "getSelectedLibraryID"),
  );
  if (fromPane.length) return fromPane;

  const fromRows = uniquePositiveIntegers(
    paneValues(pane, "getCollectionTreeRows", "getCollectionTreeRow").map(
      (row) => libraryIDFromCandidate(row),
    ),
  );
  if (fromRows.length) return fromRows;

  return itemLibraryIDs(pane);
}

export function firstSelectedLibraryID(
  pane: unknown,
  fallback: number,
): number {
  return selectedLibraryIDsFromPane(pane)[0] ?? fallback;
}

/**
 * Return a collection ID when the candidate is a collection or a collection
 * tree row. Library roots, saved searches, and other special rows are skipped.
 */
export function collectionIDFromCandidate(candidate: unknown): number | null {
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Record<string, any>;
  if (typeof row.isCollection === "function" && !row.isCollection()) {
    return null;
  }
  const ref = row.ref ?? row.collection ?? row;
  return positiveInteger(
    ref?.collectionID ?? ref?.id ?? row.collectionID ?? row.id,
  );
}

function collectionCandidatesFromContext(context: unknown): unknown[] {
  const plural = [
    ...asList(readContextValue(context, "collections")),
    ...asList(readContextValue(context, "collectionTreeRows")),
  ];
  if (plural.length) return plural;
  return [
    readContextValue(context, "collection"),
    readContextValue(context, "collectionTreeRow"),
    readContextValue(context, "row"),
  ].filter((value) => value != null);
}

function collectionCandidatesFromPane(pane: unknown): unknown[] {
  const collections = paneValues(
    pane,
    "getSelectedCollections",
    "getSelectedCollection",
  );
  if (collections.length) return collections;
  return paneValues(pane, "getCollectionTreeRows", "getCollectionTreeRow");
}

/** Collection IDs for a menu context or pane selection on Zotero 9 or 10. */
export function selectedCollectionIDs(
  pane: unknown,
  context?: unknown,
): number[] {
  const candidates = collectionCandidatesFromContext(context);
  const source = candidates.length
    ? candidates
    : collectionCandidatesFromPane(pane);
  return uniquePositiveIntegers(source.map(collectionIDFromCandidate));
}
