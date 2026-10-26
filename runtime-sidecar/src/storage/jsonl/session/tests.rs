//! Behaviour tests for the session core: durability across reopen,
//! idempotent receipts, fencing and projection publication.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;

use crate::runtime::actor::{Durability, PendingEvent, RuntimeError};
use crate::storage::jsonl::hot::HotOps;
use crate::storage::jsonl::store::JsonlStore;

fn root(tag: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("synax-session-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn seed(id: &str) -> Vec<u8> {
    serde_json::to_vec(
        &json!({"id": id, "projectId": "p", "status": "queued", "updatedAt": "2026-10-20"}),
    )
    .unwrap()
}

#[test]
fn list_summaries_track_pending_permissions_across_reopen() {
    let (dir, ops) = started("pending-permission-summary");
    let count = |ops: &HotOps| {
        ops.store().list().read().page(None, 64).0[0]["pendingPermissionCount"].clone()
    };
    assert_eq!(count(&ops), 0);
    let fence = ops.snapshot("s").unwrap();
    let payload = serde_json::to_vec(&json!({"id":"permission", "runId":"r", "action":"ask", "reason":"批准", "createdAt":"2026-01-01"})).unwrap();
    let receipt = ops
        .control(
            "s",
            "ask",
            fence.epoch,
            fence.revision,
            "permission_request",
            &payload,
        )
        .unwrap();
    assert_eq!(count(&ops), 1);
    ops.flush().unwrap();
    drop(ops);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    ops.snapshot("s").unwrap();
    assert_eq!(count(&ops), 1);
    let retry = ops
        .control(
            "s",
            "ask",
            fence.epoch,
            fence.revision,
            "permission_request",
            &payload,
        )
        .unwrap();
    assert!(retry.reused);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&retry.state_json).unwrap(),
        serde_json::from_slice::<serde_json::Value>(&receipt.state_json).unwrap()
    );
    let fence = ops.snapshot("s").unwrap();
    ops.control(
        "s",
        "expire",
        fence.epoch,
        fence.revision,
        "permission_expire",
        br#"{"id":"permission"}"#,
    )
    .unwrap();
    assert_eq!(count(&ops), 0);
    drop(ops);
    std::fs::remove_dir_all(dir).unwrap();
}

fn run_document(id: &str, session: &str) -> Vec<u8> {
    serde_json::to_vec(
        &json!({"id": id, "sessionId": session, "status": "queued", "startedAt": "2026-10-20"}),
    )
    .unwrap()
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
    ops.admit_run(
        "s",
        "admit-1",
        "body",
        "r",
        1,
        0,
        &[],
        &run_document("r", "s"),
    )
    .unwrap();
    ops.activate_run("s", "activate-1", &run_document("r", "s"), 1, 1)
        .unwrap();
    (dir, ops)
}

#[test]
fn appended_events_survive_reopen_with_identical_projection() {
    let (dir, ops) = started("reopen");
    ops.append_stream(
        "s",
        "r",
        "p",
        1,
        1,
        Durability::GroupCommit,
        vec![step("a")],
    )
    .unwrap();
    for sequence in 2..12u64 {
        ops.append_stream(
            "s",
            "r",
            "p",
            sequence,
            1,
            Durability::GroupCommit,
            vec![delta("a", "token ")],
        )
        .unwrap();
    }
    let before = ops.ui_snapshot("s", None).unwrap();
    let snapshot_before = ops.snapshot("s").unwrap();
    ops.flush().unwrap();
    drop(ops);

    let reopened = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    assert_eq!(reopened.snapshot("s").unwrap(), snapshot_before);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&reopened.ui_snapshot("s", None).unwrap())
            .unwrap(),
        serde_json::from_slice::<serde_json::Value>(&before).unwrap()
    );
    let replayed = reopened.replay("s", 0, 256, 4 * 1024 * 1024).unwrap();
    assert_eq!(replayed.len(), 12);
    assert_eq!(replayed.last().unwrap().sequence, 12);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn checkpoint_restores_execution_and_replays_only_later_commits_across_rolls() {
    for roll in [false, true] {
        let (dir, ops) = started("checkpoint-tail");
        ops.append_stream(
            "s",
            "r",
            "p",
            1,
            1,
            Durability::GroupCommit,
            vec![step("a")],
        )
        .unwrap();
        ops.flush().unwrap();
        let checkpoint_commit = ops.handle("s").unwrap().actor.lock().commit;
        if roll {
            ops.handle("s").unwrap().actor.lock().files.extent.frames[2] =
                super::FRAMES_PER_SEGMENT;
        }
        let input = vec![delta("a", "after checkpoint")];
        let receipt = ops
            .append_stream("s", "r", "p", 2, 1, Durability::GroupCommit, input.clone())
            .unwrap();
        ops.flush_session("s").unwrap();
        let expected: serde_json::Value =
            serde_json::from_slice(&ops.ui_snapshot("s", None).unwrap()).unwrap();
        drop(ops);
        let restored = super::load::load(&dir, "s").unwrap();
        assert_eq!(restored.checkpoint_commit, checkpoint_commit);
        assert_eq!(restored.replayed_commits, 1);
        assert_eq!(restored.projection.to_json(), expected);
        drop(restored);
        let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
        let retry = ops
            .append_stream("s", "r", "p", 2, 1, Durability::GroupCommit, input)
            .unwrap();
        assert!(retry.reused);
        assert_eq!(retry.last_sequence, receipt.last_sequence);
        drop(ops);
        std::fs::write(
            crate::storage::jsonl::layout::session_dir(&dir, "s")
                .unwrap()
                .join(super::checkpoint::FILE),
            b"torn",
        )
        .unwrap();
        let rebuilt = super::load::load(&dir, "s").unwrap();
        assert_eq!(rebuilt.checkpoint_commit, 0);
        assert!(rebuilt.replayed_commits > 1);
        assert_eq!(rebuilt.projection.to_json(), expected);
        drop(rebuilt);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn a_replayed_append_returns_the_receipt_and_does_not_apply_twice() {
    let (dir, ops) = started("receipt");
    let first = ops
        .append_stream(
            "s",
            "r",
            "p",
            1,
            1,
            Durability::GroupCommit,
            vec![step("a")],
        )
        .unwrap();
    let again = ops
        .append_stream(
            "s",
            "r",
            "p",
            1,
            1,
            Durability::GroupCommit,
            vec![step("a")],
        )
        .unwrap();
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
        ops.append_stream(
            "s",
            "r",
            "p",
            1,
            99,
            Durability::GroupCommit,
            vec![step("a")]
        ),
        Err(RuntimeError::StaleEpoch { .. })
    ));
    assert!(matches!(
        ops.append_stream(
            "s",
            "r",
            "p",
            5,
            1,
            Durability::GroupCommit,
            vec![step("a")]
        ),
        Err(RuntimeError::ProducerSequenceGap { .. })
    ));
    assert_eq!(ops.snapshot("s").unwrap().cursor, cursor);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_projection_that_exceeds_the_budget_rejects_the_batch() {
    let (dir, ops) = started("budget");
    ops.append_stream(
        "s",
        "r",
        "p",
        1,
        1,
        Durability::GroupCommit,
        vec![step("a")],
    )
    .unwrap();
    let cursor = ops.snapshot("s").unwrap().cursor;
    let huge = "x".repeat(900 * 1024);
    let result = ops.append_stream(
        "s",
        "r",
        "p",
        2,
        1,
        Durability::GroupCommit,
        vec![delta("a", &huge)],
    );
    assert!(result.is_err());
    assert_eq!(
        ops.snapshot("s").unwrap().cursor,
        cursor,
        "cursor did not advance"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn finishing_bumps_the_epoch_and_a_replayed_finish_is_idempotent() {
    let (dir, ops) = started("finish");
    let first = ops
        .finish_run("s", "finish-1", "r", "completed", 1, 2, &[])
        .unwrap();
    let again = ops
        .finish_run("s", "finish-1", "r", "completed", 1, 2, &[])
        .unwrap();
    assert!(again.reused);
    assert_eq!(first.snapshot, again.snapshot);
    assert_eq!(first.snapshot.epoch, 2);
    assert!(first.snapshot.active_run_id.is_none());
    std::fs::remove_dir_all(dir).unwrap();
}

/// Reproduce the native completion order: the run and then the session are
/// patched to a terminal status, and the `finish` batch is never committed.
fn settle_without_finish(ops: &HotOps) {
    let fence = ops.snapshot("s").unwrap();
    let run_patch = serde_json::to_vec(&json!({
        "runId": "r",
        "patch": {"status": "completed", "completedAt": "2026-10-20T00:00:01Z"}
    }))
    .unwrap();
    ops.control(
        "s",
        "settle-run",
        fence.epoch,
        fence.revision,
        "run_patch",
        &run_patch,
    )
    .unwrap();
    let fence = ops.snapshot("s").unwrap();
    let session_patch = serde_json::to_vec(&json!({
        "patch": {"status": "completed", "activeRunId": null, "updatedAt": "2026-10-20T00:00:02Z"}
    }))
    .unwrap();
    ops.control(
        "s",
        "settle-session",
        fence.epoch,
        fence.revision,
        "session_patch",
        &session_patch,
    )
    .unwrap();
}

/// Simulate a session written by a build that settled the projection without
/// clearing the durable run pointer: inject the leak, then checkpoint it so it
/// survives a reopen exactly like the shipped state does.
fn leak_run_pointer(ops: &HotOps) {
    let handle = ops.handle("s").unwrap();
    {
        let mut actor = handle.actor.lock();
        actor.state.active_run_id = Some("r".to_owned());
        handle.publish(&mut actor);
    }
    ops.flush().unwrap();
}

#[test]
fn a_settled_session_patch_clears_the_durable_run_pointer() {
    let (dir, ops) = started("settle-clears");
    settle_without_finish(&ops);
    let settled = ops.snapshot("s").unwrap();
    assert!(
        settled.active_run_id.is_none(),
        "the settlement owns the pointer"
    );
    // Nothing is left to reclaim, so the next run keeps the settled epoch.
    let admission = ops
        .admit_run(
            "s",
            "admit-2",
            "body-2",
            "r2",
            settled.epoch,
            settled.revision,
            &[],
            &run_document("r2", "s"),
        )
        .unwrap();
    assert_eq!(admission.epoch, settled.epoch);
    assert_eq!(
        ops.snapshot("s").unwrap().active_run_id.as_deref(),
        Some("r2")
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_denied_permission_clears_the_durable_run_pointer() {
    let (dir, ops) = started("denied-pointer");
    let fence = ops.snapshot("s").unwrap();
    let request = serde_json::to_vec(&json!({
        "id": "permission", "runId": "r", "action": "ask", "reason": "批准",
        "createdAt": "2026-10-20T00:00:01Z"
    }))
    .unwrap();
    ops.control(
        "s",
        "ask",
        fence.epoch,
        fence.revision,
        "permission_request",
        &request,
    )
    .unwrap();
    let fence = ops.snapshot("s").unwrap();
    ops.control(
        "s",
        "reject",
        fence.epoch,
        fence.revision,
        "permission_reply",
        &serde_json::to_vec(&json!({"id": "permission", "reply": "reject"})).unwrap(),
    )
    .unwrap();
    let settled = ops.snapshot("s").unwrap();
    assert_eq!(
        settled.active_run_id, None,
        "a denied run cannot stay active"
    );
    let view: serde_json::Value =
        serde_json::from_slice(&ops.ui_snapshot("s", None).unwrap()).unwrap();
    assert_eq!(view["session"]["status"], "completed");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn admission_reclaims_a_run_left_by_an_older_build() {
    let (dir, ops) = started("reclaim-settled");
    settle_without_finish(&ops);
    leak_run_pointer(&ops);
    let stale = ops.snapshot("s").unwrap();
    assert_eq!(
        stale.active_run_id.as_deref(),
        Some("r"),
        "the legacy leak survived the settled projection"
    );

    let admission = ops
        .admit_run(
            "s",
            "admit-2",
            "body-2",
            "r2",
            stale.epoch,
            stale.revision,
            &[],
            &run_document("r2", "s"),
        )
        .unwrap();
    assert_eq!(
        admission.epoch,
        stale.epoch + 1,
        "reclaiming fences the stale epoch"
    );
    let healed = ops.snapshot("s").unwrap();
    assert_eq!(healed.active_run_id.as_deref(), Some("r2"));
    assert_eq!(healed.epoch, admission.epoch);
    let view: serde_json::Value =
        serde_json::from_slice(&ops.ui_snapshot("s", None).unwrap()).unwrap();
    assert_eq!(view["session"]["activeRunId"], "r2");
    // The reclaimed run stays finalized: a late activate cannot resurrect it.
    assert!(matches!(
        ops.activate_run(
            "s",
            "activate-r",
            &run_document("r", "s"),
            healed.epoch,
            healed.revision
        ),
        Err(RuntimeError::InvalidCommand(_))
    ));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_reopened_session_reclaims_the_same_settled_run() {
    let (dir, ops) = started("reclaim-reopen");
    settle_without_finish(&ops);
    leak_run_pointer(&ops);
    drop(ops);

    let reopened = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    let stale = reopened.snapshot("s").unwrap();
    assert_eq!(
        stale.active_run_id.as_deref(),
        Some("r"),
        "the leak is durable"
    );
    reopened
        .admit_run(
            "s",
            "admit-2",
            "body-2",
            "r2",
            stale.epoch,
            stale.revision,
            &[],
            &run_document("r2", "s"),
        )
        .unwrap();
    assert_eq!(
        reopened.snapshot("s").unwrap().active_run_id.as_deref(),
        Some("r2")
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn admission_closes_an_orphaned_open_lease_after_an_older_build_cleared_pointer() {
    let (dir, ops) = started("orphan-open-lease");
    let fence = ops.snapshot("s").unwrap();
    let lease = json!({
        "sessionId": "s", "runId": "r", "epoch": "old-generation",
        "hostId": "old-host", "closed": false,
    });
    ops.control(
        "s",
        "open-old",
        fence.epoch,
        fence.revision,
        "execution_open",
        &serde_json::to_vec(&lease).unwrap(),
    )
    .unwrap();
    // Reproduce the shipped legacy ordering: the projection was settled and
    // the durable active pointer was cleared, while the control lease stayed
    // open because the finish batch never committed.
    {
        let handle = ops.handle("s").unwrap();
        let mut actor = handle.actor.lock();
        actor.state.active_run_id = None;
        handle.publish(&mut actor);
    }
    ops.flush().unwrap();
    let stale = ops.snapshot("s").unwrap();
    assert!(stale.active_run_id.is_none());
    let admission = ops
        .admit_run(
            "s",
            "admit-new",
            "body-new",
            "r2",
            stale.epoch,
            stale.revision,
            &[],
            &run_document("r2", "s"),
        )
        .unwrap();
    assert_eq!(admission.epoch, stale.epoch + 1);
    let healed_fence = ops.snapshot("s").unwrap();
    let healed = ops
        .control(
            "s",
            "orphan-read",
            healed_fence.epoch,
            healed_fence.revision,
            "read",
            b"null",
        )
        .unwrap();
    let healed: serde_json::Value = serde_json::from_slice(&healed.state_json).unwrap();
    assert_eq!(healed["executionLease"]["closed"], true);
    assert_eq!(
        ops.snapshot("s").unwrap().active_run_id.as_deref(),
        Some("r2")
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_failed_launch_settles_an_unowned_running_run_atomically() {
    let (dir, ops) = started("failed-launch");
    let fence = ops.snapshot("s").unwrap();
    let lease = json!({
        "sessionId": "s", "runId": "r", "epoch": "failed-generation",
        "hostId": "failed-host", "closed": false,
    });
    let result = ops
        .control(
            "s",
            "fail-launch",
            fence.epoch,
            fence.revision,
            "execution_fail_start",
            &serde_json::to_vec(&json!({
                "executionLease": lease,
                "reason": "execution_open was rejected before the worker started"
            }))
            .unwrap(),
        )
        .unwrap();
    let snapshot = ops.snapshot("s").unwrap();
    assert!(snapshot.active_run_id.is_none());
    let view: serde_json::Value =
        serde_json::from_slice(&ops.ui_snapshot("s", None).unwrap()).unwrap();
    assert_eq!(view["run"]["status"], "failed");
    assert_eq!(view["session"]["status"], "failed");
    assert_eq!(
        view["run"]["stopReason"],
        "execution_open was rejected before the worker started"
    );
    assert!(result.event.is_some());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn finishing_after_a_settled_patch_is_accepted_once() {
    let (dir, ops) = started("finish-after-settle");
    settle_without_finish(&ops);
    let settled = ops.snapshot("s").unwrap();
    assert!(settled.active_run_id.is_none());
    let receipt = ops
        .finish_run(
            "s",
            "finish-2",
            "r",
            "completed",
            settled.epoch,
            settled.revision,
            &[],
        )
        .unwrap();
    assert_eq!(
        receipt.snapshot.epoch,
        settled.epoch + 1,
        "the late finish still fences"
    );
    assert!(
        receipt.event.is_none(),
        "the completion was already published"
    );
    let mut replay = ops
        .finish_run(
            "s",
            "finish-2",
            "r",
            "completed",
            settled.epoch,
            settled.revision,
            &[],
        )
        .unwrap();
    assert!(replay.reused);
    replay.reused = false;
    assert_eq!(replay.snapshot, receipt.snapshot);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn finishing_another_run_after_a_settled_patch_is_rejected() {
    let (dir, ops) = started("finish-other");
    settle_without_finish(&ops);
    let settled = ops.snapshot("s").unwrap();
    assert!(matches!(
        ops.finish_run(
            "s",
            "finish-9",
            "r9",
            "completed",
            settled.epoch,
            settled.revision,
            &[]
        ),
        Err(RuntimeError::InvalidCommand(_))
    ));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn resuming_republishes_a_cleared_run_pointer() {
    let (dir, ops) = started("resume-pointer");
    let fence = ops.snapshot("s").unwrap();
    // A stop patch may clear the pointer while the run stays projected, so a
    // resume has to republish it or the resumed run could never append again.
    let paused =
        serde_json::to_vec(&json!({"patch": {"status": "paused", "activeRunId": null}})).unwrap();
    ops.control(
        "s",
        "pause",
        fence.epoch,
        fence.revision,
        "session_patch",
        &paused,
    )
    .unwrap();
    let paused = ops.snapshot("s").unwrap();
    assert!(paused.active_run_id.is_none());
    ops.control(
        "s",
        "resume",
        paused.epoch,
        paused.revision,
        "resume",
        &serde_json::to_vec(&json!({"runId": "r"})).unwrap(),
    )
    .unwrap();
    assert_eq!(
        ops.snapshot("s").unwrap().active_run_id.as_deref(),
        Some("r")
    );
    ops.append_stream(
        "s",
        "r",
        "p",
        1,
        1,
        Durability::GroupCommit,
        vec![step("a")],
    )
    .unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn admission_still_rejects_a_live_run() {
    let (dir, ops) = started("reclaim-live");
    let fence = ops.snapshot("s").unwrap();
    assert!(matches!(
        ops.admit_run(
            "s",
            "admit-2",
            "body-2",
            "r2",
            fence.epoch,
            fence.revision,
            &[],
            &run_document("r2", "s")
        ),
        Err(RuntimeError::SessionBusy)
    ));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn admission_does_not_reclaim_a_parked_run() {
    let (dir, ops) = started("reclaim-parked");
    let fence = ops.snapshot("s").unwrap();
    let stop = serde_json::to_vec(&json!({"runId": "r", "reason": "Stopped"})).unwrap();
    ops.control(
        "s",
        "stop-begin",
        fence.epoch,
        fence.revision,
        "stop_begin",
        &stop,
    )
    .unwrap();
    let fence = ops.snapshot("s").unwrap();
    ops.control(
        "s",
        "stop-ack",
        fence.epoch,
        fence.revision,
        "stop_ack",
        &stop,
    )
    .unwrap();
    let parked = ops.snapshot("s").unwrap();
    assert_eq!(
        parked.active_run_id.as_deref(),
        Some("r"),
        "a stopped run stays resumable"
    );
    assert!(matches!(
        ops.admit_run(
            "s",
            "admit-2",
            "body-2",
            "r2",
            parked.epoch,
            parked.revision,
            &[],
            &run_document("r2", "s")
        ),
        Err(RuntimeError::SessionBusy)
    ));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_ephemeral_append_has_no_sequence_and_no_durable_event() {
    let (dir, ops) = started("ephemeral");
    let cursor = ops.snapshot("s").unwrap().cursor;
    assert!(matches!(
        ops.append_stream(
            "s",
            "r",
            "p",
            1,
            1,
            Durability::Ephemeral,
            vec![delta("a", "live")]
        ),
        Err(RuntimeError::InvalidCommand(_))
    ));
    assert_eq!(ops.snapshot("s").unwrap().cursor, cursor);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn session_patches_follow_the_new_active_run_identity() {
    let (dir, ops) = {
        let dir = root("session-patch-identity");
        let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
        ops.ui_snapshot("s", Some(&seed("s"))).unwrap();
        (dir, ops)
    };
    let patch = serde_json::to_vec(&json!({
        "patch": {
            "activeRunId": "r",
            "status": "running",
            "updatedAt": "2026-10-20T00:00:01Z"
        }
    }))
    .unwrap();
    ops.control("s", "session-patch-1", 1, 0, "session_patch", &patch)
        .unwrap();
    let title = serde_json::to_vec(&json!({
        "patch": {
            "title": "Persisted title",
            "updatedAt": "2026-10-20T00:00:02Z"
        }
    }))
    .unwrap();
    ops.control("s", "session-patch-2", 1, 1, "session_patch", &title)
        .unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_slice(&ops.ui_snapshot("s", None).unwrap()).unwrap();
    assert_eq!(snapshot["session"]["activeRunId"], "r");
    assert_eq!(snapshot["session"]["title"], "Persisted title");
    ops.flush().unwrap();
    drop(ops);
    let reopened = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    let restored: serde_json::Value =
        serde_json::from_slice(&reopened.ui_snapshot("s", None).unwrap()).unwrap();
    assert_eq!(restored["session"]["title"], "Persisted title");
    std::fs::remove_dir_all(dir).unwrap();
}

fn disk_bytes(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| {
            if entry.path().is_dir() {
                disk_bytes(&entry.path())
            } else {
                entry.metadata().unwrap().len()
            }
        })
        .sum()
}

#[test]
fn delta_storage_grows_with_output_not_context_and_has_no_snapshots_or_index() {
    let (dir, ops) = started("size");
    let prompt = "fixed system instructions ".repeat(8192);
    let patch =
        serde_json::to_vec(&json!({"patch":{"sessionMetadata":{"latestSystemPrompt":prompt}}}))
            .unwrap();
    ops.control("s", "prompt", 1, 2, "session_patch", &patch)
        .unwrap();
    ops.append_stream("s", "r", "p", 1, 1, Durability::Sync, vec![step("a")])
        .unwrap();
    let base = disk_bytes(&dir);
    for n in 2..=1001 {
        ops.append_stream(
            "s",
            "r",
            "p",
            n,
            1,
            Durability::Sync,
            vec![delta("a", "answer ")],
        )
        .unwrap();
    }
    let first = disk_bytes(&dir) - base;
    for n in 1002..=2001 {
        ops.append_stream(
            "s",
            "r",
            "p",
            n,
            1,
            Durability::Sync,
            vec![delta("a", "answer ")],
        )
        .unwrap();
    }
    let second = disk_bytes(&dir) - base - first;
    assert!(
        second < first * 12 / 10,
        "incremental growth: {first} then {second}"
    );
    assert!(
        (first + second) < prompt.len() as u64 * 2000 / 10,
        "must remove over 90% of repeated context writes"
    );
    assert!(!dir.join("index/list.000000").exists());
    assert!(!dir.join("loops").exists());
    let session = crate::storage::jsonl::layout::session_dir(&dir, "s").unwrap();
    assert!(!session.join("000000").exists());
    for prefix in ["ctls", "clse"] {
        let path = session
            .join("events-v2/000000")
            .join(format!("{prefix}.000000"));
        crate::storage::jsonl::seglog::visit_complete(&path, |_, bytes| {
            let value: serde_json::Value = serde_json::from_slice(bytes)?;
            assert!(!matches!(
                value["t"].as_str(),
                Some("snapshot" | "seal" | "cond" | "control")
            ));
            assert!(!String::from_utf8_lossy(bytes).contains(&prompt));
            Ok(())
        })
        .unwrap();
    }
    let before = ops.ui_snapshot("s", None).unwrap();
    drop(ops);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&before).unwrap(),
        serde_json::from_slice::<serde_json::Value>(&ops.ui_snapshot("s", None).unwrap()).unwrap()
    );
    assert!(ops.store().list().read().len() == 1);
    println!(
        "v2 storage: first 1000 events {first} bytes, second 1000 {second} bytes; repeated context baseline {} bytes",
        prompt.len() * 2000
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn uncommitted_v2_tail_never_becomes_visible_on_reopen_or_retry() {
    let (dir, ops) = started("uncommitted-v2");
    ops.append_stream("s", "r", "p", 1, 1, Durability::Sync, vec![step("a")])
        .unwrap();
    let before = ops.ui_snapshot("s", None).unwrap();
    drop(ops);
    let path = crate::storage::jsonl::layout::session_dir(&dir, "s")
        .unwrap()
        .join("events-v2/000000/evts.000000");
    let original = std::fs::metadata(&path).unwrap().len();
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    use std::io::Write;
    let bytes = serde_json::to_vec(&json!({"t":"event","s":999,"r":"r","k":"bad","p":{}})).unwrap();
    file.write_all(&(bytes.len() as u32).to_le_bytes()).unwrap();
    file.write_all(&bytes).unwrap();
    file.write_all(&[12, 0]).unwrap();
    drop(file);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    // Opening the root is lazy; repair only the session when it is accessed.
    assert!(std::fs::metadata(&path).unwrap().len() > original);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&before).unwrap(),
        serde_json::from_slice::<serde_json::Value>(&ops.ui_snapshot("s", None).unwrap()).unwrap()
    );
    assert_eq!(std::fs::metadata(&path).unwrap().len(), original);
    ops.append_stream(
        "s",
        "r",
        "p",
        2,
        1,
        Durability::Sync,
        vec![delta("a", "new")],
    )
    .unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn legacy_files_are_read_only_and_new_writes_use_v2() {
    use crate::storage::jsonl::{
        record::{LineWriter, Record, SnapshotBody, SnapshotCond},
        write::SessionWriter,
    };
    let dir = root("legacy-read-only");
    let session = crate::storage::jsonl::layout::session_dir(&dir, "s").unwrap();
    let ui = crate::runtime::projection::UiSnapshot::seed("s", &seed("s")).unwrap();
    let mut codec = LineWriter::new();
    let bytes = codec
        .line(&Record::Snapshot(SnapshotBody {
            id: "s".into(),
            header: ui.session.clone(),
            state: SnapshotCond::default(),
            projection: ui,
        }))
        .to_vec();
    let mut writer = SessionWriter::open(&session, 0).unwrap();
    writer
        .commit(
            1,
            &[&bytes],
            &[],
            SnapshotCond {
                epoch: 1,
                retained_from: 1,
                ..Default::default()
            },
        )
        .unwrap();
    writer.sync().unwrap();
    drop(writer);
    let old: Vec<_> = ["ctls", "evts", "clse"]
        .iter()
        .map(|prefix| {
            let path = session.join("000000").join(format!("{prefix}.000000"));
            let bytes = std::fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect();
    std::fs::create_dir_all(dir.join("index")).unwrap();
    std::fs::write(dir.join("index/list.000000"), b"unused legacy index").unwrap();
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    ops.control(
        "s",
        "new-title",
        1,
        0,
        "session_patch",
        &serde_json::to_vec(&json!({"patch":{"title":"new title"}})).unwrap(),
    )
    .unwrap();
    drop(ops);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    let ui: serde_json::Value =
        serde_json::from_slice(&ops.ui_snapshot("s", None).unwrap()).unwrap();
    assert_eq!(ui["session"]["title"], "new title");
    for (path, bytes) in old {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    assert_eq!(
        std::fs::read(dir.join("index/list.000000")).unwrap(),
        b"unused legacy index"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn thinking_only_partial_is_preserved_and_finish_receipt_survives_restart() {
    let (dir, ops) = started("thought-partial");
    ops.append_stream("s", "r", "p", 1, 1, Durability::Sync, vec![step("a")])
        .unwrap();
    let mut thought = delta("a", "reasoning text");
    thought.kind = "thought_delta".into();
    let mut value: serde_json::Value = serde_json::from_slice(&thought.payload).unwrap();
    value["chunk"]["type"] = json!("thought_delta");
    thought.payload = serde_json::to_vec(&value).unwrap();
    ops.append_stream("s", "r", "p", 2, 1, Durability::Sync, vec![thought])
        .unwrap();
    drop(ops);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    let receipt = ops
        .finish_run("s", "interrupted", "r", "interrupted", 1, 2, &[])
        .unwrap();
    let event: serde_json::Value =
        serde_json::from_slice(&receipt.event.as_ref().unwrap().payload).unwrap();
    assert_eq!(event["chunk"]["message"]["id"], "msg_partial_r_a");
    assert_eq!(
        event["chunk"]["message"]["metadata"]["thought"],
        "reasoning text"
    );
    drop(ops);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    let retry = ops
        .finish_run("s", "interrupted", "r", "interrupted", 1, 2, &[])
        .unwrap();
    assert!(retry.reused);
    assert_eq!(
        serde_json::to_value(receipt.event).unwrap(),
        serde_json::to_value(retry.event).unwrap()
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn rolling_segments_replay_changes_and_preserve_producer_receipts() {
    let (dir, ops) = started("roll-v2");
    ops.append_stream("s", "r", "p", 1, 1, Durability::Sync, vec![step("a")])
        .unwrap();
    // Trigger the real rolling branch without writing sixteen thousand frames.
    ops.handle("s").unwrap().actor.lock().files.extent.frames[2] = super::FRAMES_PER_SEGMENT;
    let receipt = ops
        .append_stream(
            "s",
            "r",
            "p",
            2,
            1,
            Durability::Sync,
            vec![delta("a", "after roll")],
        )
        .unwrap();
    ops.flush().unwrap();
    let before = ops.ui_snapshot("s", None).unwrap();
    drop(ops);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&before).unwrap(),
        serde_json::from_slice::<serde_json::Value>(&ops.ui_snapshot("s", None).unwrap()).unwrap()
    );
    assert!(
        ops.append_stream(
            "s",
            "r",
            "p",
            2,
            1,
            Durability::Sync,
            vec![delta("a", "after roll")]
        )
        .unwrap()
        .reused
    );
    assert_eq!(ops.snapshot("s").unwrap().cursor, receipt.last_sequence);
    ops.append_stream(
        "s",
        "r",
        "p",
        3,
        1,
        Durability::Sync,
        vec![delta("a", " again")],
    )
    .unwrap();
    assert!(
        crate::storage::jsonl::layout::session_dir(&dir, "s")
            .unwrap()
            .join("events-v2/000001")
            .exists()
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn loop_start_identity_is_small_and_durable_without_an_execution_snapshot() {
    let dir = root("loop-identity");
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    assert!(
        ops.claim_agent_loop("aloop_test", "fingerprint", Some("request"), Some("run"))
            .unwrap()
    );
    drop(ops);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    assert!(
        !ops.claim_agent_loop("aloop_test", "fingerprint", Some("request"), Some("run"))
            .unwrap()
    );
    assert!(
        ops.claim_agent_loop("aloop_test", "different", Some("request"), Some("run"))
            .is_err()
    );
    assert!(
        std::fs::metadata(dir.join("loop-receipts/aloop_test.json"))
            .unwrap()
            .len()
            < 512
    );
    assert!(!dir.join("loops").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn workspace_binding_is_idle_only_and_fences_prepared_runs() {
    let dir = root("workspace-binding");
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    ops.ui_snapshot("s", Some(&seed("s"))).unwrap();
    let change = serde_json::to_vec(&json!({
        "expectedBindingRevision": 0,
        "patch": {"sessionMetadata": {"backend": {"workspaceBindingRevision": 1, "workDir": "/worktree"}}}
    })).unwrap();
    ops.control("s", "bind", 1, 0, "workspace_bind", &change).unwrap();
    let fence = ops.snapshot("s").unwrap();
    assert!(matches!(ops.control("s", "stale-bind", fence.epoch, fence.revision, "workspace_bind", &change), Err(RuntimeError::InvalidCommand(_))));
    let stale = serde_json::to_vec(&json!({"id":"r", "sessionId":"s", "status":"queued", "startedAt":"2026-10-23", "metadata":{"runtime":{"workspaceBindingRevision":0}}})).unwrap();
    assert!(matches!(ops.admit_run("s", "stale-run", "body", "r", fence.epoch, fence.revision, &[], &stale), Err(RuntimeError::InvalidCommand(_))));
    let current = serde_json::to_vec(&json!({"id":"r", "sessionId":"s", "status":"queued", "startedAt":"2026-10-23", "metadata":{"runtime":{"workspaceBindingRevision":1}}})).unwrap();
    ops.admit_run("s", "current-run", "body", "r", fence.epoch, fence.revision, &[], &current).unwrap();
    let fence = ops.snapshot("s").unwrap();
    let second = serde_json::to_vec(&json!({"expectedBindingRevision":1,"patch":{"sessionMetadata":{"backend":{"workspaceBindingRevision":2}}}})).unwrap();
    assert!(matches!(ops.control("s", "busy-bind", fence.epoch, fence.revision, "workspace_bind", &second), Err(RuntimeError::SessionBusy)));
    drop(ops);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn metadata_compare_and_set_rejects_a_stale_mailbox_after_reopen() {
    let (dir, ops) = started("metadata-cas");
    let first = json!({"schema":1,"eventSeq":1,"status":"running"});
    let fence = ops.snapshot("s").unwrap();
    ops.control("s", "mailbox-first", fence.epoch, fence.revision, "session_patch", &serde_json::to_vec(&json!({
        "expectedMetadata":{"key":"subagentControl","value":null},
        "patch":{"sessionMetadata":{"subagentControl":first}}
    })).unwrap()).unwrap();
    ops.flush().unwrap(); drop(ops);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&dir).unwrap()));
    let fence = ops.snapshot("s").unwrap();
    let stale = ops.control("s", "mailbox-stale", fence.epoch, fence.revision, "session_patch", &serde_json::to_vec(&json!({
        "expectedMetadata":{"key":"subagentControl","value":null},
        "patch":{"sessionMetadata":{"subagentControl":{"schema":1,"eventSeq":2}}}
    })).unwrap());
    assert!(matches!(stale, Err(RuntimeError::InvalidCommand(message)) if message.contains("METADATA_CONFLICT")));
    let fence = ops.snapshot("s").unwrap();
    ops.control("s", "mailbox-next", fence.epoch, fence.revision, "session_patch", &serde_json::to_vec(&json!({
        "expectedMetadata":{"key":"subagentControl","value":first},
        "patch":{"sessionMetadata":{"subagentControl":{"schema":1,"eventSeq":2}}}
    })).unwrap()).unwrap();
    drop(ops); std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn workspace_binding_accepts_only_the_live_agent_lease() {
    let (dir, ops) = started("agent-workspace-binding");
    let lease = json!({"sessionId":"s", "runId":"r", "epoch":"generation", "hostId":"host"});
    let fence = ops.snapshot("s").unwrap();
    ops.control("s", "open", fence.epoch, fence.revision, "execution_open", &serde_json::to_vec(&lease).unwrap()).unwrap();
    let change = json!({"execution":lease, "expectedBindingRevision":0,
        "patch":{"sessionMetadata":{"backend":{"workspaceBindingRevision":1,"workDir":"/tree"}}}});
    let fence = ops.snapshot("s").unwrap();
    let mut stale = change.clone(); stale["execution"]["epoch"] = json!("old-generation");
    assert!(matches!(ops.control("s", "stale-agent", fence.epoch, fence.revision, "workspace_bind", &serde_json::to_vec(&stale).unwrap()), Err(RuntimeError::ExecutionSuperseded(_))));
    ops.control("s", "agent-bind", fence.epoch, fence.revision, "workspace_bind", &serde_json::to_vec(&change).unwrap()).unwrap();
    assert_eq!(ops.snapshot("s").unwrap().active_run_id.as_deref(), Some("r"));
    let fence = ops.snapshot("s").unwrap();
    ops.control("s", "close", fence.epoch, fence.revision, "execution_close", &serde_json::to_vec(&lease).unwrap()).unwrap();
    let fence = ops.snapshot("s").unwrap();
    let mut closed = change; closed["expectedBindingRevision"] = json!(1); closed["patch"]["sessionMetadata"]["backend"]["workspaceBindingRevision"] = json!(2);
    assert!(matches!(ops.control("s", "closed-agent", fence.epoch, fence.revision, "workspace_bind", &serde_json::to_vec(&closed).unwrap()), Err(RuntimeError::ExecutionSuperseded(_))));
    drop(ops); std::fs::remove_dir_all(dir).unwrap();
}
