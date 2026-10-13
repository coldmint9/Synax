import { afterEach, beforeEach, expect, it } from "vitest";
import { getRawSqlite } from "../../../infrastructure/database/index.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { transcriptRepository as repo } from "../transcript-repository.js";
import { resetAgentRuntimeFixtures, plannerSessionInput } from "./agent-runtime-fixtures.js";
import type { AgentRuntimeMessage } from "../contracts.js";
let id: string;
const message = (key: string): AgentRuntimeMessage => ({id:key, sessionId:id, runId:null, stepId:null, role:"assistant",content:key,metadata:{},createdAt:"2026-10-13T00:00:00.000Z"});
const head = () => {
  const row = getRawSqlite().prepare("SELECT revision,record_count,visible_sequence,committed_bytes,segment FROM transcript_heads WHERE session_id=?").get(id) as {revision:number;record_count:number;visible_sequence:number;committed_bytes:number;segment:string};
  return {revision:row.revision,record_count:row.record_count,visible_sequence:row.visible_sequence,committed_bytes:row.committed_bytes,segment:row.segment};
};
beforeEach(() => {
  resetAgentRuntimeFixtures();
  getRawSqlite().exec("PRAGMA synchronous=FULL");
  id=agentSessionRuntime.create(plannerSessionInput).id;
});
afterEach(() => {getRawSqlite().exec("PRAGMA synchronous=NORMAL");});
it("retries idempotently and preserves transcript across session status updates", () => {
  repo.appendJsonl(message("one")); const before=head();
  repo.appendJsonl(message("one")); expect(head()).toEqual(before);
  agentRuntimeStore.updateSession(id,{status:"completed"});
  expect(repo.jsonlMessages(id)).toEqual([message("one")]);
  expect(() => repo.appendJsonl({...message("one"),content:"different"})).toThrow(/identity/);
});
it("rolls back, appends with a fresh sequence and never resurrects discarded records", () => {
  repo.appendJsonl(message("one")); repo.appendJsonl(message("two")); repo.appendJsonl(message("three"));
  repo.setJsonlVisibleThrough(id,1,head().revision);
  repo.appendJsonl(message("four"));
  expect(head()).toMatchObject({record_count:4,visible_sequence:4});
  expect(repo.jsonlMessages(id).map(m=>m.id)).toEqual(["one","four"]);
  expect(() => repo.setJsonlVisibleThrough(id,2,head().revision)).toThrow(/not visible/);
  expect(() => repo.appendJsonl(message("two"))).toThrow(/identity/);
});
it("rejects stale rollback and leaves head and visibility untouched", () => {
  repo.appendJsonl(message("one")); const revision=head().revision;
  repo.appendJsonl(message("two")); const before=head();
  expect(() => repo.setJsonlVisibleThrough(id,0,revision)).toThrow(/Stale/);
  expect(head()).toEqual(before);
  expect(repo.jsonlMessages(id)).toHaveLength(2);
});
it("rejects weak durability and acknowledgements inside an outer transaction", () => {
  const db=getRawSqlite(); db.exec("PRAGMA synchronous=NORMAL");
  expect(() => repo.appendJsonl(message("one"))).toThrow(/FULL/);
  db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
  try {expect(() => repo.appendJsonl(message("one"))).toThrow(/own transaction/);} finally {db.exec("ROLLBACK");}
});
it("recovers an uncommitted file tail after an index insertion failure", () => {
  const db=getRawSqlite(); repo.appendJsonl(message("one")); const before=head();
  db.exec("CREATE TEMP TRIGGER reject_transcript BEFORE INSERT ON transcript_records BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  try {expect(() => repo.appendJsonl(message("two"))).toThrow(/injected/);} finally {db.exec("DROP TRIGGER reject_transcript");}
  expect(head()).toEqual(before);
  repo.appendJsonl(message("three"));
  expect(repo.jsonlMessages(id).map(m=>m.id)).toEqual(["one","three"]);
});
it("verifies a legacy copy and keeps the live transcript unchanged", () => {
  agentRuntimeStore.updateSession(id,{status:"completed"});
  agentRuntimeStore.appendMessage(message("one"));
  agentRuntimeStore.appendMessage(message("two"));
  const original=agentRuntimeStore.listMessages(id);
  expect(repo.stageLegacyJsonl(id)).toBe(2);
  expect(repo.jsonlMessages(id)).toEqual(original);
  expect(agentRuntimeStore.listMessages(id)).toEqual(original);
  expect(() => repo.stageLegacyJsonl(id)).toThrow(/already exists/);
});
it("rejects oversized migration without publishing a partial head or modifying source", () => {
  agentRuntimeStore.updateSession(id,{status:"completed"});
  agentRuntimeStore.appendMessage({...message("large"),content:"x".repeat(70*1024)});
  expect(() => repo.stageLegacyJsonl(id)).toThrow(/paged migration/);
  expect(getRawSqlite().prepare("SELECT 1 FROM transcript_heads WHERE session_id=?").get(id)).toBeUndefined();
  expect(agentRuntimeStore.getMessage(id,"large")?.content.length).toBe(70*1024);
});
