import { randomUUID } from 'node:crypto';
import { runtimeClient, decode } from '../../modules/agent-runtime/sidecar/runtime-repository.js';
import { RuntimeSidecarError } from '../../modules/agent-runtime/sidecar/sidecar-client.js';

export const BUSINESS_COLLECTIONS = [
  'memories', 'skill-sources', 'skill-installs', 'skill-catalog', 'skill-preferences',
  'extension-state', 'extension-definitions', 'extension-directories', 'extension-packages',
  'extension-sources', 'tool-grants', 'media-jobs',
] as const;
export type BusinessCollection = typeof BUSINESS_COLLECTIONS[number];
interface RecordValue { key: string; revision: number; value: unknown }
interface Page { items: RecordValue[]; revision: number; after?: string | null }
interface Collection { generation: number; records: Map<string, RecordValue>; ready: boolean; tail: Promise<void>; failure?: unknown; loading?: Promise<void> }

/** Small business metadata is cached for synchronous policy evaluation. Rust is
 * the sole writer; per-record revisions reject stale cross-process updates.
 * Hosts refresh at request/tool boundaries and await flush before acknowledging.
 * Large transcripts and media bytes use their dedicated Rust repositories. */
export class BusinessStore {
  private readonly collections = new Map<BusinessCollection, Collection>();
  private collection(name: BusinessCollection): Collection {
    let state = this.collections.get(name);
    if (!state) { state = { generation: 0, records: new Map(), ready: false, tail: Promise.resolve() }; this.collections.set(name, state); }
    return state;
  }
  private async command<T>(name: BusinessCollection, operation: string, payload: unknown): Promise<T> {
    return decode<T>(await runtimeClient().historyCommandGlobal({ sessionId: `metadata:${name}`, requestId: randomUUID(), operation, payload }));
  }
  async refresh(names: readonly BusinessCollection[] = BUSINESS_COLLECTIONS): Promise<void> {
    await Promise.all(names.map(name => this.refreshCollection(name)));
  }
  private async refreshCollection(name: BusinessCollection): Promise<void> {
    const state = this.collection(name);
    if (state.loading) return state.loading;
    state.loading = (async () => {
      await this.flush([name]);
      for (let attempt = 0; ; attempt++) {
        const generation = state.generation;
        const records = new Map<string, RecordValue>();
        let after: string | undefined; let revision: number | undefined;
        try {
          do {
            const page = await this.command<Page>(name, 'metadata_page', { after, revision });
            for (const record of page.items) records.set(record.key, record);
            revision = page.revision; after = page.after ?? undefined;
          } while (after);
          // Do not replace records changed locally while the page request was in flight.
          await state.tail;
          if (state.failure) throw state.failure;
          if(generation!==state.generation){if(attempt>=7)throw new Error('Metadata changed repeatedly while loading.');continue;}
          state.records = records; state.ready = true;
          return;
        } catch (error) {
          if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 3) throw error;
        }
      }
    })().finally(() => { state.loading = undefined; });
    return state.loading;
  }
  private ready(name: BusinessCollection): Collection {
    const state = this.collection(name);
    if (!state.ready) throw new Error(`Rust metadata collection ${name} has not been hydrated.`);
    if (state.failure) throw state.failure;
    return state;
  }
  get<T>(name: BusinessCollection, key: string): T | undefined {
    const record = this.ready(name).records.get(key);
    return record?.value == null ? undefined : structuredClone(record.value) as T;
  }
  list<T>(name: BusinessCollection): T[] {
    return [...this.ready(name).records.values()].filter(r => r.value != null).map(r => structuredClone(r.value) as T);
  }
  put<T>(name: BusinessCollection, key: string, value: T): void { this.commit(name, [{ key, value }]); }
  delete(name: BusinessCollection, key: string): boolean {
    if (!this.get(name, key)) return false;
    this.commit(name, [{ key, value: null }]); return true;
  }
  commit(name: BusinessCollection, updates: Array<{ key: string; value: unknown }>): void {
    if (!updates.length) return;
    const state = this.ready(name);
    if (updates.length > 128 || new Set(updates.map(w => w.key)).size !== updates.length) throw new Error('Invalid metadata batch.');
    const writes = updates.map(({key,value}) => ({ key, value: structuredClone(value), revision: state.records.get(key)?.revision ?? 0 }));
    if (Buffer.byteLength(JSON.stringify({writes})) > 700 * 1024) throw new Error('Metadata batch exceeds transport budget.');
    state.generation++;
    for (const write of writes) state.records.set(write.key, {...write, revision: write.revision + 1});
    state.tail = state.tail.then(async () => {
      if (state.failure) return;
      await this.command(name, 'metadata_commit', { writes });
    }).catch(error => { state.failure = error; });
  }
  async flush(names: readonly BusinessCollection[] = BUSINESS_COLLECTIONS): Promise<void> {
    for (const name of names) {
      const state = this.collection(name);
      let tail: Promise<void>;
      do { tail = state.tail; await tail; } while (tail !== state.tail);
      if (state.failure) {
        const error = state.failure;
        state.failure = undefined; state.ready = false; state.records.clear();
        throw error;
      }
    }
  }
}
export const businessStore = new BusinessStore();
export const businessKey = (...parts: string[]) => JSON.stringify(parts);
