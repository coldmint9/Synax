import type Database from "libsql";
import { PAGE_ROWS, VersionStoreError, assertObjectId } from "./limits.js";
import { hashBytes } from "./hash-codec.js";
import { atomicVersionWrite } from "./transaction.js";

const KINDS = ["checkpoint", "reader", "writer", "recovery", "fork"] as const;
export interface VersionPin { id: string; objectId: string; kind: (typeof KINDS)[number]; owner: string }
interface PinRow { id: string; object_id: string; kind: VersionPin["kind"]; owner: string }
function identity(value: string): void {
  if (typeof value !== "string" || !value.length || !value.isWellFormed() || value.includes("\0") || Buffer.byteLength(value) > 256)
    throw new VersionStoreError("VERSION_PIN_IDENTITY", "Invalid pin identity or owner.");
}
const map = (row: PinRow): VersionPin => ({ id: row.id, objectId: row.object_id, kind: row.kind, owner: row.owner });

/** Durable pins protect graphs between short read transactions. Owners must be
 * unique operation/lease nonces, not reusable PIDs; no unsafe TTL reap is done here. */
export class VersionPins {
  private readonly find;
  private readonly objectExists;
  private readonly insert;
  private readonly remove;
  private readonly move;
  private readonly list;
  private readonly more;

  constructor(private readonly db: Database.Database) {
    this.objectExists = db.prepare<{ hash: Uint8Array }>("SELECT 1 AS present FROM conversation_v3_objects WHERE hash=:hash");
    const columns = "id,lower(hex(object_id)) AS object_id,kind,owner";
    this.find = db.prepare<[string]>(`SELECT ${columns} FROM conversation_v3_pins WHERE id=?`);
    this.insert = db.prepare<[string, Uint8Array, VersionPin["kind"], string]>("INSERT INTO conversation_v3_pins(id,object_id,kind,owner) VALUES(?,?,?,?)");
    this.remove = db.prepare<[string, string]>("DELETE FROM conversation_v3_pins WHERE id=? AND owner=?");
    this.move = db.prepare<[Uint8Array, string, string, Uint8Array]>("UPDATE conversation_v3_pins SET object_id=? WHERE id=? AND owner=? AND object_id=? AND kind='writer'");
    this.list = db.prepare<[string, string, number]>(`SELECT ${columns} FROM conversation_v3_pins WHERE owner=? AND id>? ORDER BY id LIMIT ?`);
    this.more = db.prepare<[string, string]>("SELECT 1 AS present FROM conversation_v3_pins WHERE owner=? AND id>? LIMIT 1");
  }

  hold(pin: VersionPin): VersionPin {
    identity(pin.id); identity(pin.owner); assertObjectId(pin.objectId);
    if (!KINDS.includes(pin.kind)) throw new VersionStoreError("VERSION_PIN_KIND", "Invalid version pin kind.");
    return atomicVersionWrite(this.db, () => {
      const existing = this.find.get(pin.id) as PinRow | undefined;
      if (existing) {
        if (existing.owner !== pin.owner || existing.kind !== pin.kind || existing.object_id !== pin.objectId)
          throw new VersionStoreError("VERSION_PIN_CONFLICT", "Pin identity is already used for another root or owner.");
        return map(existing);
      }
      this.requireObject(pin.objectId);
      this.insert.run(pin.id, hashBytes(pin.objectId), pin.kind, pin.owner);
      return { ...pin };
    });
  }

  release(id: string, owner: string): boolean {
    identity(id); identity(owner);
    return atomicVersionWrite(this.db, () => {
      const existing = this.find.get(id) as PinRow | undefined;
      if (!existing) return false;
      if (existing.owner !== owner) throw new VersionStoreError("VERSION_PIN_OWNER", "Pin owner does not match.");
      return Boolean(this.remove.run(id, owner).changes);
    });
  }

  /** Enclose new object construction and this transfer in the SAME outer write
   * transaction; do not publish unpinned staging roots across an await. */
  moveWriter(request: { id: string; owner: string; expectedObjectId: string; objectId: string }): VersionPin {
    identity(request.id); identity(request.owner);
    assertObjectId(request.expectedObjectId); assertObjectId(request.objectId);
    return atomicVersionWrite(this.db, () => {
      const row = this.find.get(request.id) as PinRow | undefined;
      if (!row || row.owner !== request.owner) throw new VersionStoreError("VERSION_PIN_OWNER", "Writer pin owner does not match.");
      if (row.kind !== "writer") throw new VersionStoreError("VERSION_PIN_KIND", "Only a writer pin can move to a new root.");
      this.requireObject(request.objectId);
      if (row.object_id !== request.expectedObjectId || !this.move.run(hashBytes(request.objectId), request.id, request.owner, hashBytes(request.expectedObjectId)).changes)
        throw new VersionStoreError("VERSION_PIN_STALE", "Writer pin root changed.");
      return { ...map(row), objectId: request.objectId };
    });
  }

  private requireObject(id: string): void {
    if (!this.objectExists.get({ hash: hashBytes(id) }))
      throw new VersionStoreError("VERSION_OBJECT_MISSING", "Pinned object is missing.");
  }

  page(owner: string, options: { after?: string; limit?: number } = {}): { items: VersionPin[]; next?: string } {
    identity(owner);
    const { after = "", limit = PAGE_ROWS } = options;
    if (after !== "") identity(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_ROWS)
      throw new VersionStoreError("VERSION_PAGE_LIMIT", "Invalid pin page limit.");
    // Column byte limits cap this page below 1MiB, without limit+1 over-fetch.
    const items = (this.list.all(owner, after, limit) as PinRow[]).map(map);
    const last = items.at(-1)?.id;
    return last && items.length === limit && this.more.get(owner, last) ? { items, next: last } : { items };
  }
}
