import { apiRequest } from "./origin";

export interface InputOptimizationRequest {
  projectId: string;
  text: string;
  model?: string;
  backendId?: string;
}

export function optimizeInput(
  input: InputOptimizationRequest,
  signal: AbortSignal,
) {
  return apiRequest<{ text: string }>("/api/agent-runtime/input/optimize", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
    silent: true,
  });
}
