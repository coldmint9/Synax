import type { CapabilityTool } from "./disclosure.js";

export function capabilityGroup(tool: CapabilityTool): string {
  return tool.discoveryGroup ?? (tool.category === "mcp"
    ? tool.id.slice(0, tool.id.lastIndexOf(".")) : tool.category);
}

function words(value: string): string[] {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Deterministic field-weighted retrieval; queries are terms, not literal phrases. */
export function searchCapabilities(tools: CapabilityTool[], query = "", group = "", ids?: string[]): CapabilityTool[] {
  // An explicit identifier is a load request. Search hints must never hide it.
  if (ids?.length) return [...new Set(ids)].flatMap((id) => tools.filter((tool) => tool.id === id));
  const terms = [...new Set(words(query))];
  return tools.flatMap((tool) => {
    if (group && tool.category !== group && capabilityGroup(tool) !== group) return [];
    if (!terms.length) return [{ tool, score: 0 }];
    const fields = [
      { text: tool.id, weight: 12 },
      { text: `${tool.label} ${capabilityGroup(tool)}`, weight: 6 },
      { text: tool.description, weight: 2 },
      { text: tool.progressiveDetails ?? "", weight: 1 },
    ].map(({ text, weight }) => ({ text: words(text).join(" "), weight }));
    let matched = 0;
    let score = 0;
    for (const term of terms) {
      const weight = fields.reduce((sum, field) => sum + (field.text.includes(term) ? field.weight : 0), 0);
      if (weight) matched++;
      score += weight;
    }
    if (!matched) return [];
    // Coverage dominates field weights so a partial name cannot bury a full match.
    return [{ tool, score: (matched / terms.length) * 1000 + score }];
  }).sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id)).map(({ tool }) => tool);
}

export function capabilityDirectory(tools: CapabilityTool[]) {
  const groups = new Map<string, { group: string; count: number; examples: Array<{ id: string; label: string }> }>();
  for (const tool of [...tools].sort((a, b) => a.id.localeCompare(b.id))) {
    const group = capabilityGroup(tool);
    const entry = groups.get(group) ?? { group, count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push({ id: tool.id, label: tool.label.slice(0, 100) });
    groups.set(group, entry);
  }
  return [...groups.values()].sort((a, b) => a.group.localeCompare(b.group));
}
