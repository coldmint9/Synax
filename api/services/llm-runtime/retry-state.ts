export interface LlmRetryState {
  reason: "network" | "rate_limit" | "upstream";
  phase: "waiting" | "retrying" | "group_wait" | "recovered" | "exhausted";
  group: number;
  attempt: number;
  maxRetries: number;
  nextRetryAt: number | null;
  error: string;
}
