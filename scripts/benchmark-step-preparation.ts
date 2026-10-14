/**
 * Isolated schema hot-path benchmark; no provider requests or workspace writes.
 * Run: npx tsx scripts/benchmark-step-preparation.ts
 * The uncached variant restores raw Zod inputs to reproduce the former adapter
 * behavior. Both variants perform the same three accounting passes and request
 * fingerprint used during step preparation. This is not end-to-end latency.
 */
import { performance } from 'node:perf_hooks';
import { z } from 'zod/v4';
import { buildLoopToolSet } from '../services/local-node/modules/agent-runtime/loop-ai-tools.js';
import { measureContextComposition } from '../services/local-node/modules/agent-runtime/context-composition.js';
import { fingerprintGatewayRequest } from '../services/local-node/infrastructure/llm-runtime/cache-diagnostics.js';

const definitions = Array.from({ length: 150 }, (_, index) => ({
  id: `mcp.fixture.tool${index}`,
  label: 'Fixture',
  description: 'A representative MCP tool',
  category: 'mcp' as const,
  mutability: 'read' as const,
  resumeBehavior: 'auto' as const,
  inputSchema: z.object(Object.fromEntries(Array.from({ length: 20 }, (_, field) => [
    `field${field}`, z.string().optional().describe('Tool input parameter'),
  ]))),
}));
const schemas = new Map(definitions.map((definition) => [definition.id, definition.inputSchema]));

async function prepare(reuse: boolean) {
  const tools = buildLoopToolSet(definitions);
  if (!reuse) {
    for (const [name, tool] of Object.entries(tools.tools)) {
      tool.inputSchema = schemas.get(tools.resolveToolId(name)!)!;
    }
  }
  await measureContextComposition({ messages: [], tools });
  await fingerprintGatewayRequest({ messages: [], tools: tools.tools, activeTools: tools.activeTools });
  await measureContextComposition({ messages: [], tools });
  await measureContextComposition({ messages: [], tools });
}

await prepare(false);
await prepare(true);
const uncached: number[] = [];
const reused: number[] = [];
for (let index = 0; index < 10; index++) {
  // Alternate order to reduce warm-up/order bias.
  for (const reuse of index % 2 ? [true, false] : [false, true]) {
    const started = performance.now();
    await prepare(reuse);
    (reuse ? reused : uncached).push(performance.now() - started);
  }
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
console.log(JSON.stringify({
  scope: 'schema-preparation-only', tools: definitions.length, fieldsPerTool: 20, samples: 10,
  uncachedMeanMs: mean(uncached), reusedMeanMs: mean(reused),
  reductionPercent: (1 - mean(reused) / mean(uncached)) * 100,
}, null, 2));
