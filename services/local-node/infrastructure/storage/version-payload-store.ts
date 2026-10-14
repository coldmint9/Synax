export interface VersionPayloadStore {
  readonly jsonl?: boolean;
  put(bytes: Uint8Array): string;
  get(hash: string, maxBytes?: number): Buffer;
  remove(hash: string): void;
  collectSealed?(limit?: number): number;
  withOwner?<T>(owner: string, action: () => T): T;
}
