/**
 * Graph filtering controls which ordinary nodes are rendered. Selection and
 * pinned scope nodes (for example Focus-mode seeds) are orthogonal state: they
 * remain rendered so users do not lose context when a search or filter excludes
 * them.
 */
export function renderedGraphKeys(
  filteredKeys: ReadonlySet<string>,
  selectedKey: string | null,
  pinnedKeys: ReadonlySet<string> = new Set(),
): Set<string> {
  const rendered = new Set(filteredKeys);
  for (const key of pinnedKeys) rendered.add(key);
  if (selectedKey) rendered.add(selectedKey);
  return rendered;
}

/** A preserved node outside the active filter is rendered as a local ghost. */
export function isFilteredPreservedNode(
  key: string,
  filteredKeys: ReadonlySet<string>,
  selectedKey: string | null,
  pinnedKeys: ReadonlySet<string> = new Set(),
): boolean {
  return !filteredKeys.has(key) && (key === selectedKey || pinnedKeys.has(key));
}
