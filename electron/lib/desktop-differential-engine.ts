// Keep the version pinned: this adapter is bundled without Electron or updater side effects.
export {
  computeOperations,
  OperationKind,
  type Operation,
} from "electron-updater/out/differentialDownloader/downloadPlanBuilder.js";
export type { BlockMap } from "builder-util-runtime/out/blockMapApi.js";
