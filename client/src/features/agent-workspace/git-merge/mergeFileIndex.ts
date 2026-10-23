import type { MergeFileSummary } from "../../../adapters/transport/gitMr";

/** Stable IDs for the virtual viewport; one file change is O(1), not a full
 * manifest clone/filter. A complete manifest replaces the index only at a
 * checkpoint or snapshot boundary. */
export class MergeFileIndex {
  readonly byId = new Map<string, MergeFileSummary>();
  ids: string[] = [];
  conflicts = 0;
  revision = -1;

  replace(files: MergeFileSummary[], revision: number) {
    if (revision < this.revision) return;
    this.byId.clear();
    this.ids = [];
    this.conflicts = 0;
    for (const file of files) this.upsert(file);
    this.revision = revision;
  }

  update(files: MergeFileSummary[], revision: number) {
    if (revision < this.revision) return;
    for (const file of files) this.upsert(file);
    this.revision = revision;
  }

  private upsert(file: MergeFileSummary) {
    const previous = this.byId.get(file.id);
    if (!previous) this.ids.push(file.id);
    this.conflicts +=
      Number(file.conflicted) - Number(previous?.conflicted ?? false);
    this.byId.set(file.id, file);
  }
}
