export type WorkerPhase = "absent" | "starting" | "idle" | "running" | "releasing" | "recovering";
export interface WorkerLease {
  sessionId: string;
  generation: number;
  phase: Exclude<WorkerPhase, "absent">;
  idleAt?: number;
  evictable?: boolean;
}
