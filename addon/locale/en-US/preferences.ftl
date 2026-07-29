pref-general-heading = General Settings
pref-show-metric-tooltips =
    .label = Show metric explanations and data provenance on hover
pref-show-metric-tooltips-help = Displays definitions, interpretation, sources, and update information for Citation Map metrics and values.
pref-debug =
    .label = Enable debug logging
pref-general-actions-help = Remove all provider metrics, relationship snapshots, and externally retrieved metadata from every library. Zotero items and manually created relationships are not deleted.

pref-field-update-heading = Field Update
pref-update-behaviour-heading = Update Behaviour
pref-automatic-updates =
    .label = Automatically update citation data
pref-update-new-items =
    .label = Update newly added entries
pref-update-modified-items =
    .label = Update modified entries
pref-check-stale-startup =
    .label = Check for stale entries when Zotero starts
pref-update-libraries-heading = Libraries to update
pref-update-libraries-select-all = Select all
pref-update-libraries-clear-all = Clear all
pref-update-libraries-help = The selected libraries receive automatic updates, startup stale-data checks, and settings-page bulk updates. Tools → Update Library still updates the library currently open in Zotero.

pref-refresh-interval-heading = Refresh Interval
pref-cache-days = Refresh citation data after this many days
pref-cache-days-help = Entries older than this interval are considered stale and can be refreshed automatically.


pref-update-all-heading = Update selected libraries now
pref-update-all-help = Refreshes every regular item in the selected libraries. Libraries are processed separately, and the update remains visible and cancellable.
pref-refresh-all = Update selected libraries now

pref-clear-cache-heading = Clear cached citation data
pref-clear-cache-help = Removes stored provider metrics, relationship snapshots, and externally retrieved metadata. Zotero items and manually created relationships are not deleted.
pref-clear-cache = Clear all cached data

pref-providers-heading = Citation Data Providers
pref-selected-providers-heading = Selected Providers
pref-provider-all = Automatic (combine all providers)
pref-provider-crossref = Crossref
pref-provider-semantic-scholar = Semantic Scholar
pref-provider-opencitations = OpenCitations
pref-provider-inspire = INSPIRE-HEP
pref-provider-openalex = OpenAlex
pref-provider-selection-help = Provider choices apply to new requests. Existing cached values remain available until they are refreshed or the cache is cleared.

pref-openalex-api-key = API key — required
pref-openalex-api-key-help = Required to use OpenAlex. The key is stored only in Zotero preferences and is sent to api.openalex.org.
pref-openalex-create-key = Create a free key in your OpenAlex account.
pref-semantic-scholar-api-key = API key — optional
pref-semantic-scholar-api-key-help = Optional but recommended for more reliable access. Without a key, Semantic Scholar requests use shared public rate limits.

pref-matching-heading = Matching
pref-title-fallback =
    .label = Allow exact-title matching when no stable identifier is available
pref-title-fallback-help = Used only when no DOI, PMID, arXiv ID, ISBN, or other stable identifier is available. Matches with contradictory metadata are rejected.

pref-reference-count-note = The References column shows the provider's declared bibliography total. The plugin separately stores the structured references it can resolve for network construction, which can be fewer than the references printed in the paper.

# Plain-text variants used by HTML labels in the preference pane.
pref-automatic-updates-text = Automatically update citation data
pref-update-new-items-text = Update newly added entries
pref-update-modified-items-text = Update modified entries
pref-check-stale-startup-text = Check for stale entries when Zotero starts
