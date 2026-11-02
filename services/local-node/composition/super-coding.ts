import {
  synaxModePromptRegistry,
  SynaxModePromptStrategy,
  type SynaxModePromptContext,
} from "../modules/agent-runtime/synax/synax-mode-prompt.js";
import { toolRegistry } from "../modules/agent-runtime/tool-registry.js";
import {
  buildSuperGraphSection,
  buildSuperModeSection,
  createSuperRuntimeDeps,
  createSuperService,
  createSuperTools,
  type SuperService,
} from "../modules/super-coding/index.js";

/**
 * Composition root for the super coding mode.
 *
 * `agent-runtime` never imports the orchestration module: this file owns the
 * wiring and is imported once by the HTTP transport, which loads before any
 * session runs.
 */
class SuperModePromptStrategy extends SynaxModePromptStrategy {
  readonly mode = "super" as const;

  buildSection(): string {
    return buildSuperModeSection();
  }

  buildRuntimeState(context: SynaxModePromptContext): string | null {
    const metadata = context.metadata as unknown as {
      superGraph?: Parameters<typeof buildSuperGraphSection>[0];
    };
    return buildSuperGraphSection(metadata.superGraph);
  }
}

let service: SuperService | null = null;
let registered = false;

export function getSuperCodingService(): SuperService {
  if (!service) {
    const deps = createSuperRuntimeDeps({
      onChildSettled: async (input) => {
        await service?.onChildSettled(input);
      },
    });
    service = createSuperService(deps);
  }
  return service;
}

/** Idempotent: safe to call from every startup path and from tests. */
export function registerSuperCoding(): void {
  if (registered) return;
  registered = true;
  for (const tool of createSuperTools(getSuperCodingService()))
    toolRegistry.register(tool);
  synaxModePromptRegistry.register(new SuperModePromptStrategy());
}

registerSuperCoding();
