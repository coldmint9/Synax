use super::*;
use crate::storage::jsonl::{hot::HotOps, store::JsonlStore};
use serde_json::json;
use std::{sync::mpsc, time::Duration};

fn setup() -> (std::path::PathBuf, HotOps, SessionHandle) {
    let root = std::env::temp_dir().join(format!("synax-checkpoint-lock-{}", uuid::Uuid::new_v4()));
    let ops = HotOps::new(Arc::new(JsonlStore::open(&root).unwrap()));
    ops.ui_snapshot(
        "s",
        Some(br#"{"id":"s","projectId":"p","status":"queued","title":"before","updatedAt":"2026-10-23T00:00:00Z"}"#),
    )
    .unwrap();
    let handle = ops.handle("s").unwrap();
    (root, ops, handle)
}
fn patch(ops: &HotOps, id: &str) {
    let fence = ops.snapshot("s").unwrap();
    ops.control(
        "s",
        id,
        fence.epoch,
        fence.revision,
        "session_patch",
        &serde_json::to_vec(&json!({"patch":{"title":id}})).unwrap(),
    )
    .unwrap();
}

#[test]
fn checkpoint_compression_allows_writes_and_bounds_inflight_copies() {
    let (root, ops, handle) = setup();
    let captured = handle.actor.lock().commit;
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let worker = {
        let handle = handle.clone();
        std::thread::spawn(move || {
            save_with(&handle, true, |pending| {
                assert!(handle.actor.try_lock().is_some());
                ready_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                pending.stage()
            })
            .unwrap()
        })
    };
    ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(handle.actor.try_lock().is_some());
    patch(&ops, "after capture");
    save_with(&handle, false, |_| {
        panic!("must skip an in-flight snapshot")
    })
    .unwrap();
    let expected = handle.read().projection.to_json();
    release_tx.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(read(&handle.session_dir(), "s").unwrap().commit, captured);
    let loaded = super::super::load::load(&root, "s").unwrap();
    assert_eq!(loaded.checkpoint_commit, captured);
    assert_eq!(loaded.replayed_commits, 1);
    assert_eq!(loaded.projection.to_json(), expected);
    drop(loaded);
    save(&handle, true).unwrap();
    assert_eq!(
        read(&handle.session_dir(), "s").unwrap().commit,
        handle.actor.lock().commit
    );
    drop(handle);
    drop(ops);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_checkpoint_does_not_advance_the_saved_commit_or_suppress_retry() {
    let (root, ops, handle) = setup();
    save(&handle, true).unwrap();
    let file = handle.session_dir().join(FILE);
    let prior = std::fs::read(&file).unwrap();
    let saved = handle.actor.lock().checkpoint_commit;
    patch(&ops, "after failure");
    assert!(
        save_with(&handle, true, |_| Err(std::io::Error::other(
            "injected write failure"
        )
        .into()))
        .is_err()
    );
    assert_eq!(handle.actor.lock().checkpoint_commit, saved);
    assert_eq!(std::fs::read(&file).unwrap(), prior);
    save(&handle, true).unwrap();
    assert!(handle.actor.lock().checkpoint_commit > saved);
    assert_eq!(
        read(&handle.session_dir(), "s").unwrap().projection.session["title"],
        "after failure"
    );
    drop(handle);
    drop(ops);
    std::fs::remove_dir_all(root).unwrap();
}
