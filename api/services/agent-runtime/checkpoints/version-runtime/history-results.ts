import type Database from "libsql";
import { hashBytes } from "../version-store/hash-codec.js";
import { VersionStoreError } from "../version-store/limits.js";
import { assertBatchInput } from "./batch-input.js";
import { atomicVersionWrite } from "../version-store/transaction.js";

export class VersionHistoryResults {
  private readonly find;
  private readonly insert;
  constructor(private readonly db: Database.Database) {
    this.find = db.prepare<[string, string]>(
      "SELECT lower(hex(request_hash)) AS hash,CASE WHEN length(CAST(result_json AS BLOB))<=1048576 THEN result_json ELSE NULL END AS result FROM conversation_v3_history_requests WHERE session_id=? AND request_id=?",
    );
    this.insert = db.prepare<[string, string, Uint8Array, string]>(
      "INSERT INTO conversation_v3_history_requests(session_id,request_id,request_hash,result_json) VALUES(?,?,?,?)",
    );
  }
  private validate(sessionId: string, requestId: string): void {
    if (
      typeof sessionId !== "string" ||
      !sessionId.length ||
      Buffer.byteLength(sessionId) > 256 ||
      typeof requestId !== "string" ||
      !requestId.length ||
      Buffer.byteLength(requestId) > 128
    )
      throw new VersionStoreError(
        "VERSION_REQUEST_ID",
        "Invalid history request identity.",
      );
  }
  read<T>(sessionId: string, requestId: string, hash: string): T | undefined {
    this.validate(sessionId, requestId);
    hashBytes(hash);
    const row = this.find.get(sessionId, requestId) as
      | { hash: string; result: string | null }
      | undefined;
    if (!row) return undefined;
    if (row.hash !== hash)
      throw new VersionStoreError(
        "VERSION_REQUEST_CONFLICT",
        "Request identity was used for different history input.",
      );
    if (row.result === null)
      throw new VersionStoreError(
        "VERSION_RESULT_CORRUPT",
        "History result exceeds its integrity limit.",
      );
    return JSON.parse(row.result) as T;
  }
  save<T>(sessionId: string, requestId: string, hash: string, result: T): void {
    this.validate(sessionId, requestId);
    assertBatchInput(result);
    atomicVersionWrite(this.db, () => {
      this.insert.run(
        sessionId,
        requestId,
        hashBytes(hash),
        JSON.stringify(result),
      );
    });
  }
}
