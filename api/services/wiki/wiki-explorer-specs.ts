import type { CodeMapScanResult } from '../contracts/code-map.js';
import type { SubagentSpec } from '../agent-runtime/subagent-orchestrator.js';
import { derivePackages, filterBaselineForPrompt } from './tools/package-baseline.js';
import { FILE_SPLIT, SYM_SPLIT, MIN_PACKAGE_FILES } from './tools/contracts.js';

/** Hard cap on explorers per planner run — mirrors subagent concurrency limit. */
const MAX_EXPLORERS = 5;

/**
 * Derive a deterministic set of explorer subagent specs from a code-map scan.
 *
 * Replaces the model-driven "planner LLM emits N subagent.delegate calls" path.
 * Packages are ranked: [SPLIT] packages (high surface area) first, then the
 * largest remaining core packages, capped at MAX_EXPLORERS. Each explorer gets a
 * focused prompt scoped to one package directory.
 */
export function deriveExplorerSpecs(scan: CodeMapScanResult): SubagentSpec[] {
  const baseline = filterBaselineForPrompt(derivePackages(scan));
  const coverable = baseline.filter(p => p.fileCount >= MIN_PACKAGE_FILES);

  const ranked = [...coverable].sort((a, b) => {
    const aSplit = a.fileCount >= FILE_SPLIT && a.symbolCount >= SYM_SPLIT ? 1 : 0;
    const bSplit = b.fileCount >= FILE_SPLIT && b.symbolCount >= SYM_SPLIT ? 1 : 0;
    if (aSplit !== bSplit) return bSplit - aSplit;
    return b.fileCount - a.fileCount;
  });

  return ranked.slice(0, MAX_EXPLORERS).map(pkg => {
    const hubs = pkg.hubSymbols.slice(0, 4).map(h => h.name).join(', ');
    const hubLine = hubs ? ` Key symbols to investigate: ${hubs}.` : '';
    return {
      profileId: 'explorer',
      label: `explore:${pkg.label}`,
      prompt:
        `Explore the package at \`${pkg.dirPath}\` (${pkg.fileCount} files, ${pkg.symbolCount} symbols).${hubLine}\n\n` +
        `Read the key source files. Answer concisely:\n` +
        `1. What is this package's responsibility and public surface?\n` +
        `2. What are its main types/classes/functions and how do they relate?\n` +
        `3. What does it depend on, and what depends on it?\n` +
        `4. What are the notable data flows or state transitions?\n\n` +
        `Return a focused evidence-based summary citing concrete file paths.`,
    };
  });
}

/** Format completed explorer summaries (and note failures) for planner context. */
export function formatExplorerContext(
  results: Array<{ label?: string; status: string; summary: string | null }>,
): string {
  const lines: string[] = [];
  for (const r of results) {
    const heading = r.label ?? 'exploration';
    if (r.status === 'completed' && r.summary) {
      lines.push(`### ${heading}\n${r.summary}`);
    } else {
      lines.push(`### ${heading}\n_(exploration ${r.status} — read these files yourself if needed)_`);
    }
  }
  return lines.join('\n\n');
}
