# Privacy

## Summary

Zotero Citation Map runs locally inside Zotero. It does not contain telemetry, analytics, advertising, crash reporting, or a developer-operated backend.

## Data sent to scholarly-data providers

When citation data is refreshed, the plugin sends the minimum identifier needed for a lookup directly to one or more selected providers:

- DOI;
- PMID;
- arXiv identifier;
- ISBN.

The provider also receives ordinary network metadata such as the user's IP address and standard HTTP request headers. Automatic mode may contact multiple providers until a compatible record is found.

The currently supported third-party services are:

- OpenAlex;
- Semantic Scholar;
- Crossref;
- OpenCitations;
- INSPIRE-HEP.

Their privacy policies, retention practices, availability, and access limits are controlled by those services, not by this plugin.

## Local storage

Citation counts, reference counts, provider identities, status information, and structured reference metadata are stored in a plugin-owned SQLite database managed by Zotero, normally named `citationmap.sqlite` in the Zotero profile area.

The plugin does not write citation counts into Zotero's `Extra` field.

The cache is local to the computer and is not synchronized by Zotero Sync. Uninstalling the plugin may leave the SQLite cache in the profile. After closing Zotero, it can be removed manually if the data is no longer wanted.

## API keys

The current basic workflow does not require users to place API keys in the repository. Never commit provider keys, GitHub tokens, `.env`, `.npmrc`, private keys, or a real Zotero profile/data directory.

If API-key support is added later, keys should be stored in local Zotero preferences or an operating-system credential store. Zotero preferences are local configuration, not encrypted secret storage, and this limitation should be disclosed.

## Logs

The plugin writes operational messages to Zotero's debug log. Logs should not include API keys, authorization headers, full API URLs containing secrets, or full library exports. Review a debug log before attaching it to a public issue.
