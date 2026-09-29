import { apiRequest } from "./origin";

export interface InputOptimizationRequest {
  projectId: string;
  text: string;
  model?: string;
  backendId?: string;
}

export interface InputOptimizationResult {
  text: string;
  // Optional for compatibility with servers that only return text.
  status?: "optimized" | "unchanged" | "preserved";
}

export function optimizeInput(
  input: InputOptimizationRequest,
  signal: AbortSignal,
) {
  return apiRequest<InputOptimizationResult>("/api/agent-runtime/input/optimize", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
    silent: true,
  });
}
