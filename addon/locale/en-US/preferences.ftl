pref-data-heading = Citation data
pref-data-description = Configure how Citation Map retrieves and refreshes citation and reference information.

pref-provider = Citation data provider
pref-provider-auto =
    .label = Automatic (recommended)
pref-provider-openalex =
    .label = OpenAlex
pref-provider-semantic-scholar =
    .label = Semantic Scholar
pref-provider-crossref =
    .label = Crossref
pref-provider-opencitations =
    .label = OpenCitations
pref-provider-inspire =
    .label = INSPIRE-HEP

pref-provider-help = A specific provider is used exclusively for field updates, relationships, Similar, and title resolution. Automatic mode combines providers by capability: Crossref is preferred for the canonical record, Semantic Scholar for relationship metadata, and other providers for missing fields. OpenAlex is used only when an API key is configured. Complete cited-by and reference lists are refreshed separately in their relationship views.
pref-openalex-api-key = OpenAlex API key
pref-openalex-api-key-help = Required for OpenAlex requests. The key is stored only in Zotero preferences and is sent to api.openalex.org as the api_key query parameter.

pref-automatic-updates =
    .label = Update citation data automatically
pref-update-new-items =
    .label = Update newly added items automatically
pref-cache-days = Refresh data after this many days
pref-refresh-all = Update fields for whole library

pref-advanced-heading = Advanced
pref-title-fallback =
    .label = Match items by exact title when no identifier is available
pref-local-relations =
    .label = Include Zotero related-item links
pref-note-extraction =
    .label = Extract citation relations from notes
pref-pdf-extraction =
    .label = Extract citation relations from PDFs
pref-debug =
    .label = Enable diagnostic logging
pref-advanced-help = Note and PDF extraction are experimental and may produce incomplete relations.
pref-clear-cache = Clear all cached data

pref-reference-count-note = The References column shows the provider's declared bibliography total. The plugin separately stores the structured references it can resolve for network construction, which can be fewer than the references printed in the paper.
