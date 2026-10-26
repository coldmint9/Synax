use crate::runtime::actor::{ControlCommandReceipt, RuntimeError};
use crate::storage::jsonl::{hot::HotOps, store::JsonlStore};
use serde_json::{Value, json};
use std::sync::Arc;

fn setup() -> (std::path::PathBuf, HotOps) {
    let root = std::env::temp_dir().join(format!("synax-process-leases-{}", uuid::Uuid::new_v4()));
    let ops = HotOps::new(Arc::new(JsonlStore::open(&root).unwrap()));
    ops.ui_snapshot(
        "s",
        Some(
            &serde_json::to_vec(&json!({
                "id":"s", "projectId":"p", "status":"queued", "updatedAt":"2026-10-26",
                "sessionMetadata":{"mcpToolDefinitions":"x".repeat(160_000)}
            }))
            .unwrap(),
        ),
    )
    .unwrap();
    (root, ops)
}

fn update(
    ops: &HotOps,
    request: &str,
    operation: &str,
    lease: Value,
) -> Result<ControlCommandReceipt, RuntimeError> {
    ops.control(
        "s",
        request,
        0,
        0,
        "lease_update",
        &serde_json::to_vec(&json!({"operation":operation,"lease":lease})).unwrap(),
    )
}

fn read(ops: &HotOps) -> Value {
    serde_json::from_slice(
        &ops.control("s", "read", 0, 0, "read_current", b"null")
            .unwrap()
            .state_json,
    )
    .unwrap()
}

#[test]
fn atomic_process_leases_are_durable_without_invalidating_ui_or_session_revision() {
    let (root, ops) = setup();
    let before = ops.snapshot("s").unwrap();
    let lake = ops.handle("s").unwrap().read();
    let row = ops.store().session_summary("s").unwrap();
    let lease = json!({"leaseId":"process","hostId":"host","pid":123,"state":"active"});
    let receipt = update(&ops, "open", "lease_open", lease.clone()).unwrap();
    assert!(receipt.event.is_none());
    assert!(receipt.state_json.len() < 100);
    assert_eq!(receipt.snapshot, before);
    let after = ops.handle("s").unwrap().read();
    assert_eq!(lake.ui_gen, after.ui_gen);
    assert!(Arc::ptr_eq(&lake.header, &after.header));
    assert!(Arc::ptr_eq(&lake.projection, &after.projection));
    assert!(Arc::ptr_eq(&lake.events, &after.events));
    assert_eq!(row, ops.store().session_summary("s").unwrap());
    assert_eq!(read(&ops)["processLeases"][0], lease);
    ops.store().flush_process_leases("s").unwrap();
    drop(after);
    drop(lake);
    drop(ops);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&root).unwrap()));
    assert_eq!(read(&ops)["processLeases"][0], lease);
    update(&ops, "close", "lease_close", json!({"leaseId":"process"})).unwrap();
    // Lost ACKs cannot resurrect a process after it has already been closed.
    assert!(
        update(&ops, "open", "lease_open", lease.clone())
            .unwrap()
            .reused
    );
    assert_eq!(read(&ops)["processLeases"], json!([]));
    assert!(matches!(
        update(
            &ops,
            "open",
            "lease_open",
            json!({"leaseId":"other","hostId":"host"})
        ),
        Err(RuntimeError::RequestConflict)
    ));
    ops.store().flush_process_leases("s").unwrap();
    drop(ops);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&root).unwrap()));
    assert_eq!(read(&ops)["processLeases"], json!([]));
    assert!(update(&ops, "open", "lease_open", lease).unwrap().reused);
    assert_eq!(read(&ops)["processLeases"], json!([]));
    drop(ops);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn concurrent_process_leases_do_not_conflict_with_each_other_or_lifecycle_updates() {
    let (root, ops) = setup();
    let start = std::time::Instant::now();
    std::thread::scope(|scope| {
        for worker in 0..6 {
            let ops = &ops;
            scope.spawn(move || {
                for index in 0..24 {
                    let id = format!("{worker}-{index}");
                    update(
                        ops,
                        &format!("open-{id}"),
                        "lease_open",
                        json!({"leaseId":id,"hostId":"h","pid":index+1}),
                    )
                    .unwrap();
                    update(
                        ops,
                        &format!("close-{id}"),
                        "lease_close",
                        json!({"leaseId":id}),
                    )
                    .unwrap();
                }
            });
        }
        for index in 0..32 {
            let fence = ops.snapshot("s").unwrap();
            ops.control(
                "s",
                &format!("patch-{index}"),
                fence.epoch,
                fence.revision,
                "session_patch",
                &serde_json::to_vec(&json!({"patch":{"title":format!("title-{index}")}})).unwrap(),
            )
            .unwrap();
        }
    });
    let fence = ops.snapshot("s").unwrap();
    assert_eq!(fence.revision, 32);
    assert_eq!(fence.cursor, 32);
    assert_eq!(read(&ops)["processLeases"], json!([]));
    eprintln!(
        "process leases: 288 concurrent updates + 32 lifecycle writes, zero conflicts, {:?}",
        start.elapsed()
    );
    // Lifecycle CAS remains strict.
    assert!(matches!(
        ops.control(
            "s",
            "stale",
            fence.epoch,
            0,
            "session_patch",
            br#"{"patch":{"title":"stale"}}"#
        ),
        Err(RuntimeError::RevisionConflict { .. })
    ));
    drop(ops);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn current_control_read_uses_one_immutable_publication_without_writer_lock_or_receipts() {
    let (root, ops) = setup();
    let handle = ops.handle("s").unwrap();
    let actor = handle.actor.lock();
    let commit = actor.commit;
    let receipts = actor.receipts.len();
    for _ in 0..100 {
        assert_eq!(read(&ops)["processLeases"], json!([]));
    }
    let fenced = ops
        .control(
            "s",
            "legacy-read",
            actor.state.epoch,
            actor.state.revision,
            "read",
            b"null",
        )
        .unwrap();
    assert_eq!(fenced.snapshot.revision, actor.state.revision);
    assert!(matches!(
        ops.control(
            "s",
            "old-read",
            actor.state.epoch,
            actor.state.revision + 1,
            "read",
            b"null"
        ),
        Err(RuntimeError::RevisionConflict { .. })
    ));
    assert_eq!(commit, actor.commit);
    assert_eq!(receipts, actor.receipts.len());
    drop(actor);
    drop(handle);
    drop(ops);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn settled_sessions_with_background_processes_remain_recoverable() {
    let (root, ops) = setup();
    let fence = ops.snapshot("s").unwrap();
    ops.control(
        "s",
        "settle",
        fence.epoch,
        fence.revision,
        "session_patch",
        br#"{"patch":{"status":"completed"}}"#,
    )
    .unwrap();
    assert_eq!(
        ops.store().session_summary("s").unwrap().unwrap()["runtimeRecoveryRequired"],
        false
    );
    update(
        &ops,
        "open",
        "lease_open",
        json!({"leaseId":"background","hostId":"h","kind":"background"}),
    )
    .unwrap();
    assert_eq!(
        ops.store().session_summary("s").unwrap().unwrap()["runtimeRecoveryRequired"],
        true
    );
    ops.store().flush_process_leases("s").unwrap();
    drop(ops);
    let ops = HotOps::new(Arc::new(JsonlStore::open(&root).unwrap()));
    assert_eq!(
        ops.store().session_summary("s").unwrap().unwrap()["runtimeRecoveryRequired"],
        true
    );
    update(
        &ops,
        "close",
        "lease_close",
        json!({"leaseId":"background"}),
    )
    .unwrap();
    assert_eq!(
        ops.store().session_summary("s").unwrap().unwrap()["runtimeRecoveryRequired"],
        false
    );
    drop(ops);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn atomic_process_launch_checks_execution_generation_and_stop_but_cleanup_remains_possible() {
    let (root, ops) = setup();
    let run = serde_json::to_vec(
        &json!({"id":"r","sessionId":"s","status":"queued","startedAt":"2026-10-26"}),
    )
    .unwrap();
    ops.admit_run("s", "admit", "hash", "r", 1, 0, &[], &run)
        .unwrap();
    ops.activate_run("s", "activate", &run, 1, 1).unwrap();
    let owner = json!({"sessionId":"s","runId":"r","epoch":"owner-1","hostId":"h"});
    let fence = ops.snapshot("s").unwrap();
    ops.control(
        "s",
        "executor",
        fence.epoch,
        fence.revision,
        "execution_open",
        &serde_json::to_vec(&owner).unwrap(),
    )
    .unwrap();
    {
        let handle = ops.handle("s").unwrap();
        let _writer = handle.actor.lock();
        ops.control(
            "s",
            "owner-check",
            0,
            0,
            "execution_check",
            &serde_json::to_vec(&owner).unwrap(),
        )
        .unwrap();
    }
    let lease =
        json!({"leaseId":"process","hostId":"h","runId":"r","executionLease":owner,"pid":123});
    let mut stale = lease.clone();
    stale["executionLease"]["epoch"] = json!("owner-0");
    assert!(matches!(
        update(&ops, "stale", "lease_open", stale),
        Err(RuntimeError::ExecutionSuperseded(_))
    ));
    let mut missing = lease.clone();
    missing.as_object_mut().unwrap().remove("executionLease");
    assert!(matches!(
        update(&ops, "missing-owner", "lease_open", missing),
        Err(RuntimeError::InvalidCommand(_))
    ));
    update(&ops, "open", "lease_open", lease.clone()).unwrap();
    let fence = ops.snapshot("s").unwrap();
    ops.control(
        "s",
        "stop",
        fence.epoch,
        fence.revision,
        "stop_begin",
        br#"{"runId":"r","reason":"test"}"#,
    )
    .unwrap();
    assert!(matches!(
        update(&ops, "late", "lease_open", lease),
        Err(RuntimeError::ExecutionSuperseded(_))
    ));
    update(&ops, "close", "lease_close", json!({"leaseId":"process"})).unwrap();
    assert_eq!(read(&ops)["processLeases"], json!([]));
    drop(ops);
    std::fs::remove_dir_all(root).unwrap();
}
