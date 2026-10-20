//! Behaviour tests for the session core: durability across reopen,
//! idempotent receipts, fencing and projection publication.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;

use crate::actor::{Durability, PendingEvent, RuntimeError};
use crate::jsonl::hot::HotOps;
use crate::jsonl::store::JsonlStore;

fn root(tag: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("synax-session-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn seed(id: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"id": id, "projectId": "p", "status": "queued", "updatedAt": "2026-10-20"})).unwrap()
}

fn run_document(id: &str, session: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"id": id, "sessionId": session, "status": "queued", "startedAt": "2026-10-20"})).unwrap()
}

fn delta(step: &str, text: &str) -> PendingEvent {
    PendingEvent {
        kind: "message_delta".into(),
        payload: serde_json::to_vec(&json!({
            "schema": 1,
            "chunk": {"type": "message_delta", "stepId": step, "runId": "r", "sessionId": "s", "delta": text},
            "state": {"status": "running", "activeRunId": "r", "pendingResumeToken": null, "blockedReason": null, "updatedAt": "2026-10-20"}
        }))
        .unwrap(),
    }
}

fn step(id: &str) -> PendingEvent {
    PendingEvent {
        kind: "step_started".into(),
        payload: serde_json::to_vec(&json!({
            "schema": 1,
            "chunk": {"type": "step_started", "runId": "r", "sessionId": "s", "step": {"id": id, "runId": "r", "sessionId": "s"}},
            "state": {"status": "running", "activeRunId": "r", "pendingResumeToken": null, "blockedReason": null, "updatedAt": "2026-10-20"}
        }))
        .unwrap(),
    }
}

fn started(tag: &str) -> (PathBuf, HotOps) {
    let dir = root(tag);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    ops.ui_snapshot("s", Some(&seed("s"))).unwrap();
    ops.admit_run("s", "admit-1", "body", "r", 1, 0, &[], &run_document("r", "s")).unwrap();
    ops.activate_run("s", "activate-1", &run_document("r", "s"), 1, 1).unwrap();
    (dir, ops)
}

#[test]
fn appended_events_survive_reopen_with_identical_projection() {
    let (dir, ops) = started("reopen");
    ops.append_stream("s", "r", "p", 1, 1, Durability::GroupCommit, vec![step("a")]).unwrap();
    for sequence in 2..12u64 {
        ops.append_stream("s", "r", "p", sequence, 1, Durability::GroupCommit, vec![delta("a", "token ")]).unwrap();
    }
    let before = ops.ui_snapshot("s", None).unwrap();
    let snapshot_before = ops.snapshot("s").unwrap();
    ops.flush().unwrap();
    drop(ops);

    let reopened = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    assert_eq!(reopened.snapshot("s").unwrap(), snapshot_before);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&reopened.ui_snapshot("s", None).unwrap()).unwrap(),
        serde_json::from_slice::<serde_json::Value>(&before).unwrap()
    );
    let replayed = reopened.replay("s", 0, 256, 4 * 1024 * 1024).unwrap();
    assert_eq!(replayed.len(), 12);
    assert_eq!(replayed.last().unwrap().sequence, 12);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_replayed_append_returns_the_receipt_and_does_not_apply_twice() {
    let (dir, ops) = started("receipt");
    let first = ops.append_stream("s", "r", "p", 1, 1, Durability::GroupCommit, vec![step("a")]).unwrap();
    let again = ops.append_stream("s", "r", "p", 1, 1, Durability::GroupCommit, vec![step("a")]).unwrap();
    assert!(!first.reused);
    assert!(again.reused);
    assert_eq!(first.last_sequence, again.last_sequence);
    assert_eq!(first.first_sequence, again.first_sequence);
    assert_eq!(ops.replay("s", 0, 256, 1 << 20).unwrap().len(), 2);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_stale_epoch_or_producer_gap_is_rejected_without_writing() {
    let (dir, ops) = started("fence");
    let cursor = ops.snapshot("s").unwrap().cursor;
    assert!(matches!(
        ops.append_stream("s", "r", "p", 1, 99, Durability::GroupCommit, vec![step("a")]),
        Err(RuntimeError::StaleEpoch { .. })
    ));
    assert!(matches!(
        ops.append_stream("s", "r", "p", 5, 1, Durability::GroupCommit, vec![step("a")]),
        Err(RuntimeError::ProducerSequenceGap { .. })
    ));
    assert_eq!(ops.snapshot("s").unwrap().cursor, cursor);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_projection_that_exceeds_the_budget_rejects_the_batch() {
    let (dir, ops) = started("budget");
    ops.append_stream("s", "r", "p", 1, 1, Durability::GroupCommit, vec![step("a")]).unwrap();
    let cursor = ops.snapshot("s").unwrap().cursor;
    let huge = "x".repeat(900 * 1024);
    let result = ops.append_stream("s", "r", "p", 2, 1, Durability::GroupCommit, vec![delta("a", &huge)]);
    assert!(result.is_err());
    assert_eq!(ops.snapshot("s").unwrap().cursor, cursor, "cursor did not advance");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn finishing_bumps_the_epoch_and_a_replayed_finish_is_idempotent() {
    let (dir, ops) = started("finish");
    let first = ops.finish_run("s", "finish-1", "r", "completed", 1, 2, &[]).unwrap();
    let again = ops.finish_run("s", "finish-1", "r", "completed", 1, 2, &[]).unwrap();
    assert!(again.reused);
    assert_eq!(first.snapshot, again.snapshot);
    assert_eq!(first.snapshot.epoch, 2);
    assert!(first.snapshot.active_run_id.is_none());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_ephemeral_append_has_no_sequence_and_no_durable_event() {
    let (dir, ops) = started("ephemeral");
    let cursor = ops.snapshot("s").unwrap().cursor;
    assert!(matches!(
        ops.append_stream("s", "r", "p", 1, 1, Durability::Ephemeral, vec![delta("a", "live")]),
        Err(RuntimeError::InvalidCommand(_))
    ));
    assert_eq!(ops.snapshot("s").unwrap().cursor, cursor);
    std::fs::remove_dir_all(dir).unwrap();
}
