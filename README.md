# Citation Map persisted relationships: file-by-file substitution

This package does not modify the repository. It reads the current prerequisite-only source state and creates five complete replacement files under:

`citation-map-replacement-files\src\services\`

## Generate the complete files

Extract this package into the repository root, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\generate-citation-map-replacement-files.ps1
```

## Files to replace

Copy these generated files over the matching repository files:

1. `src/services/externalDiscoveryService.ts`
2. `src/services/citationUpdateService.ts`
3. `src/services/graphViewService.ts`
4. `src/services/itemPaneService.ts`
5. `src/services/externalWorkCacheService.ts`

No files must be deleted.

A PowerShell copy command is included below:

```powershell
$generated = ".\citation-map-replacement-files"
Copy-Item "$generated\src\services\externalDiscoveryService.ts" ".\src\services\externalDiscoveryService.ts" -Force
Copy-Item "$generated\src\services\citationUpdateService.ts" ".\src\services\citationUpdateService.ts" -Force
Copy-Item "$generated\src\services\graphViewService.ts" ".\src\services\graphViewService.ts" -Force
Copy-Item "$generated\src\services\itemPaneService.ts" ".\src\services\itemPaneService.ts" -Force
Copy-Item "$generated\src\services\externalWorkCacheService.ts" ".\src\services\externalWorkCacheService.ts" -Force
```

Then validate:

```powershell
npm run check
```

On Windows, `npm run check` should be run directly from PowerShell. The previous installer failed because Node attempted to launch `npm` rather than `npm.cmd`; it did not reveal a TypeScript or lint failure.
