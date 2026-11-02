/**
 * Public API of the super coding backend core.
 *
 * Dependency direction: `super-tools -> super-service -> super-graph`; the
 * runtime adapter is the only file that touches the local-node infrastructure
 * and is injected into the service.
 */
export { createSuperService, SuperGraphConflictError } from "./super-service.js";
export type {
  NewSuperNodeInput,
  SuperService,
  SuperServiceDeps,
} from "./super-service.js";
export { createSuperRuntimeDeps } from "./super-runtime-adapter.js";
export type { SuperRuntimeAdapterOptions } from "./super-runtime-adapter.js";
export { createSuperTools } from "./super-tools.js";
export {
  buildSuperGraphSection,
  buildSuperModeSection,
} from "./super-mode-prompt.js";
