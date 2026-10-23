import {
  analyzeMerge,
  type MergeAnalysisInput,
} from "./mergeWorkbenchAnalysis";

self.onmessage = (event: MessageEvent<MergeAnalysisInput>) => {
  try {
    self.postMessage({ result: analyzeMerge(event.data) });
  } catch {
    self.postMessage({
      failed: true,
      generation: event.data.generation,
      version: event.data.version,
    });
  }
};
