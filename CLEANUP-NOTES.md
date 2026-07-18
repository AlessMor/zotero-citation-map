# Final cleanup notes

## Critical before release

1. Push the current local plugin source to `AlessMor/zotero-citation-map`. The GitHub default branch still contains the untouched template and must not be used for a release.
2. Confirm `addon/manifest.json` targets the intended Zotero versions and contains the final name, ID, homepage, and update URL.
3. Confirm `LICENSE` contains AGPL-3.0-or-later.
4. Run a clean install and build from a new clone using `npm ci` and `npm run build`.
5. Install the resulting XPI into a fresh Zotero test profile.

## Stale template files to remove when present

- `src/modules/`
- `src/utils/ztoolkit.ts`
- `src/graph-entry.ts` (the graph is rendered directly from the main bundle)
- `README.txt`
- `doc/README-frFR.md`
- `doc/README-zhCN.md`
- `.github/renovate.json` when Dependabot is retained

Do not delete `addon/content/zoteroPane.css`; the current plugin uses it for main-window and tab icon styling.

## Git history check

Before the first public release, review the entire history, not only the working tree:

```powershell
git status --ignored
git grep -n -I -E "(api[_-]?key|token|password|secret|Authorization)"
git log -p --all -- .env .npmrc
```

If a real secret was ever committed, rotate it and rewrite the history before publishing.

## Recommended repository settings

After pushing the cleaned source, configure a `main` branch ruleset, enable private vulnerability reporting and CodeQL default setup, and confirm GitHub secret scanning/push protection are active. The workflow files in this overlay use explicit minimal permissions and full commit SHAs for their external actions.
