---
name: tree-setter
description: Use this skill when an agent needs a fast, structured code map of a repository before generating a project wiki, architecture summary, CoordForest seed, module map, entrypoint list, or source-grounded implementation plan. It wraps Synapse tree-sitter parsing and graph/community analysis, avoids LLM calls during scanning, and returns JSON or markdown wiki drafts with source evidence.
metadata:
  short-description: Fast source-grounded code maps
---

# Tree Setter

Tree Setter is the fast path for understanding a repo before writing wiki or CoordForest content.
It uses Synapse's local tree-sitter parser, import graph builder, community detection, and hub detection.

## Workflow

1. Run the scanner before drafting wiki, architecture notes, or CoordForest seeds.
2. Prefer structured JSON when another tool or agent will consume the result.
3. Prefer markdown when the user asks directly for a readable wiki draft.
4. Treat scanner output as evidence. Do not infer large architecture claims from raw file names alone when the code map has more precise data.
5. Do not save wiki pages or apply CoordForest seed patches unless the user explicitly asks for persistence.

## Scanner

Use the bundled wrapper:

```powershell
python plugins/tree-setter/skills/tree-setter/scripts/tree_setter_scan.py --work-dir . --project-id local --format json
```

Useful options:

```powershell
python plugins/tree-setter/skills/tree-setter/scripts/tree_setter_scan.py --work-dir . --project-id local --format markdown --include wiki
python plugins/tree-setter/skills/tree-setter/scripts/tree_setter_scan.py --work-dir . --project-id local --format json --include module-map,communities,coord-seed,wiki --out code-map.json
python plugins/tree-setter/skills/tree-setter/scripts/tree_setter_scan.py --work-dir . --project-id local --direct
```

The script first calls the local analyzer API at `ANALYZER_URL` or `http://127.0.0.1:8765`.
If the service is offline, it falls back to importing `analyzer.engine.code_map` from this repo.

## Output

JSON output includes:

- `codeIndex`: files, symbols, chunks, imports, and counts.
- `moduleMap`: top directories, language distribution, entrypoints, core symbols, and dependencies.
- `communities`: detected code communities with files, symbols, and hub symbols.
- `coordSeed`: a deterministic CoordForest `ForestPatch` with evidence-backed feature/action nodes.
- `wikiDraft`: markdown pages for overview, architecture, modules, entrypoints, flow, risks, and next questions.

## Persistence

For Synapse API callers, `POST /api/coordinates/code-map/scan` is read-only by default.
Set `persistWiki: true` only when the user asks to save generated wiki pages as project artifacts.
