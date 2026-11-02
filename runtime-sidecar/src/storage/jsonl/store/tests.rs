use super::*;
use crate::storage::jsonl::{hot::HotOps, layout};
use serde_json::json;

#[test]
fn opening_the_store_does_not_replay_unrelated_sessions() {
    let path = std::env::temp_dir().join(format!("synax-lazy-open-{}", uuid::Uuid::new_v4()));
    let broken = layout::session_dir(&path, "broken")
        .unwrap()
        .join("events-v2/000000");
    std::fs::create_dir_all(&broken).unwrap();
    let bad_json = b"invalid json";
    let mut bytes = (bad_json.len() as u32).to_le_bytes().to_vec();
    bytes.extend_from_slice(bad_json);
    std::fs::write(broken.join("clse.000000"), bytes).unwrap();
    let store = JsonlStore::open(&path).expect("store readiness must not wait for session replay");
    assert!(store.root.sessions.values().is_empty());
    assert!(store.session("broken").is_err());
    let hot = HotOps::new(Arc::new(store.clone()));
    hot.ui_snapshot("healthy", Some(&serde_json::to_vec(&json!({ "id":"healthy", "projectId":"p", "status":"queued", "updatedAt":"2026-10-21" })).unwrap())).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&hot.ui_snapshot("healthy", None).unwrap())
            .unwrap()["session"]["id"],
        "healthy"
    );
    drop(hot);
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn idle_eviction_releases_the_actor_and_handle_cell() {
    let path = std::env::temp_dir().join(format!("synax-idle-eviction-{}", uuid::Uuid::new_v4()));
    let store = JsonlStore::open(&path).unwrap();
    let handle = store.session("idle").unwrap();
    let actor = Arc::downgrade(&handle.actor);
    let cell = Arc::downgrade(handle.cell());
    drop(handle);
    assert_eq!(store.evict_idle(), 0);
    assert_eq!(store.evict_with_policy(0, std::time::Duration::ZERO), 1);
    assert_eq!(actor.strong_count(), 0);
    assert_eq!(cell.strong_count(), 0);
    assert!(actor.upgrade().is_none());
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn index_scan_reuses_loaded_handles_and_publishes_complete_pages_after_reopen() {
    let path = std::env::temp_dir().join(format!("synax-lazy-index-{}", uuid::Uuid::new_v4()));
    {
        let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
        for id in ["a", "b", "c"] {
            hot.ui_snapshot(id, Some(&serde_json::to_vec(&json!({ "id":id, "projectId":"p", "status":"queued", "updatedAt":"2026-10-21" })).unwrap())).unwrap();
        }
    }
    let store = JsonlStore::open(&path).unwrap();
    assert!(store.root.sessions.values().is_empty());
    let interactive = store.session("b").unwrap();
    assert!(!store.index_ready().unwrap());
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !store.index_ready().unwrap() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(Arc::ptr_eq(
        &interactive.actor,
        &store.session("b").unwrap().actor
    ));
    let (items, _) = store.list().read().page(None, 64);
    assert_eq!(items.len(), 3);
    drop(interactive);
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

fn seed_summary(hot: &HotOps, id: &str) {
    hot.ui_snapshot(
        id,
        Some(
            &serde_json::to_vec(&json!({
                "id": id, "projectId": "p", "status": "completed", "title": "Saved title",
                "updatedAt": "2026-10-22", "sessionMetadata": {
                    "latestSystemPrompt": "x".repeat(32_000), "pinned": true,
                },
            }))
            .unwrap(),
        ),
    )
    .unwrap();
}

#[test]
fn a_targeted_summary_does_not_start_the_global_scan_or_open_an_execution_actor() {
    let path =
        std::env::temp_dir().join(format!("synax-targeted-summary-{}", uuid::Uuid::new_v4()));
    {
        let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
        seed_summary(&hot, "s");
    }
    // Even a missing query cache repairs just the session's header. Debug
    // system-prompt assets are not needed to render a list row.
    let assets = path.join(layout::ASSETS_DIR);
    if assets.exists() {
        std::fs::remove_dir_all(assets).unwrap();
    }
    let store = JsonlStore::open(&path).unwrap();
    let row = store.session_summary("s").unwrap().unwrap();
    assert_eq!(row["title"], "Saved title");
    assert_eq!(row["runtimeRecoveryRequired"], false);
    assert!(store.root.sessions.values().is_empty());
    assert_eq!(store.root.index_state.load(Ordering::Acquire), 0);
    assert!(store.session_summary("missing").unwrap().is_none());
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn restart_restores_list_rows_without_replaying_session_history() {
    let path = std::env::temp_dir().join(format!("synax-summary-restart-{}", uuid::Uuid::new_v4()));
    {
        let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
        for id in ["a", "b", "c"] {
            seed_summary(&hot, id);
        }
        hot.flush().unwrap();
    }
    let store = JsonlStore::open(&path).unwrap();
    for id in ["a", "b", "c"] {
        assert!(!store.load_list_entry(id).unwrap());
    }
    // load_list_entry does not evict: an accidental replay would leave actors.
    assert!(store.root.sessions.values().is_empty());
    assert!(!store.index_ready().unwrap());
    store.wait_for_index_scan().await;
    assert!(store.index_ready().unwrap());
    let (rows, _) = store.list().read().page(None, 64);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["title"], "Saved title");
    assert_eq!(rows[0]["sessionMetadata"]["pinned"], true);
    assert!(
        rows[0]["sessionMetadata"]
            .get("latestSystemPrompt")
            .is_none()
    );
    assert!(store.root.sessions.values().is_empty());
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn missing_summaries_are_repaired_without_actors_and_idle_eviction_saves_new_rows() {
    let path =
        std::env::temp_dir().join(format!("synax-summary-backfill-{}", uuid::Uuid::new_v4()));
    {
        let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
        seed_summary(&hot, "old");
        assert!(summary_cache::read(&path, "old").is_none());
    }
    {
        let store = JsonlStore::open(&path).unwrap();
        store.load_list_entry("old").unwrap();
        assert!(store.root.sessions.values().is_empty());
        assert!(summary_cache::read(&path, "old").is_some());
        let hot = HotOps::new(Arc::new(store.clone()));
        seed_summary(&hot, "new");
        assert_eq!(store.evict_with_policy(0, std::time::Duration::ZERO), 1);
        assert!(summary_cache::read(&path, "new").is_some());
    }
    let store = JsonlStore::open(&path).unwrap();
    for id in ["old", "new"] {
        store.load_list_entry(id).unwrap();
    }
    assert!(store.root.sessions.values().is_empty());
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn commits_after_the_cached_summary_are_replayed_including_segment_rolls() {
    for roll in [false, true] {
        let path =
            std::env::temp_dir().join(format!("synax-summary-stale-{}", uuid::Uuid::new_v4()));
        {
            let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
            seed_summary(&hot, "s");
            hot.flush().unwrap();
            assert!(summary_cache::read(&path, "s").is_some());
            let summary_path = layout::session_dir(&path, "s")
                .unwrap()
                .join("list-summary.json");
            let old_summary = std::fs::read(&summary_path).unwrap();
            if roll {
                hot.handle("s").unwrap().actor.lock().files.extent.frames[2] =
                    super::super::session::FRAMES_PER_SEGMENT;
            }
            hot.control("s", "rename", 1, 0, "session_patch", &serde_json::to_vec(&json!({
                "patch": { "title": "Newest title", "sessionMetadata": { "archivedAt": "2026-10-22" } }
            })).unwrap()).unwrap();
            // An abrupt exit/older runtime can sync the source without refreshing
            // its disposable summary. Neither the old title nor visibility wins.
            hot.flush_session("s").unwrap();
            std::fs::write(&summary_path, old_summary).unwrap();
            assert!(summary_cache::read(&path, "s").is_none());
        }
        let store = JsonlStore::open(&path).unwrap();
        store.load_list_entry("s").unwrap();
        let (rows, _) = store.list().read().page(None, 64);
        assert_eq!(rows[0]["title"], "Newest title");
        assert_eq!(rows[0]["sessionMetadata"]["archivedAt"], "2026-10-22");
        assert!(summary_cache::read(&path, "s").is_some());
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }
}

#[test]
fn corrupt_or_unwritable_summary_caches_do_not_hide_durable_sessions() {
    for broken in [
        "invalid-json",
        "wrong-schema",
        "wrong-session",
        "unwritable",
    ] {
        let path =
            std::env::temp_dir().join(format!("synax-summary-invalid-{}", uuid::Uuid::new_v4()));
        {
            let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
            seed_summary(&hot, "s");
            hot.flush().unwrap();
        }
        let summary = layout::session_dir(&path, "s")
            .unwrap()
            .join("list-summary.json");
        let mut saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&summary).unwrap()).unwrap();
        match broken {
            "invalid-json" => std::fs::write(&summary, b"{").unwrap(),
            "unwritable" => {
                std::fs::remove_file(&summary).unwrap();
                std::fs::create_dir(&summary).unwrap();
            }
            _ => {
                if broken == "wrong-schema" {
                    saved["schema"] = json!(0);
                } else {
                    saved["row"]["s"] = json!("other");
                }
                std::fs::write(&summary, serde_json::to_vec(&saved).unwrap()).unwrap();
            }
        }
        let store = JsonlStore::open(&path).unwrap();
        store.load_list_entry("s").unwrap();
        let (rows, _) = store.list().read().page(None, 64);
        assert_eq!(rows[0]["title"], "Saved title");
        assert!(store.root.sessions.values().is_empty());
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }
}

#[test]
fn background_summary_cannot_overwrite_a_live_title_or_status() {
    let mut index = ListIndex::default();
    let row = |title: &str, updated: &str| ListRecord {
        s: "s".into(),
        u: updated.into(),
        del: false,
        h: json!({"id": "s", "title": title, "updatedAt": updated}),
    };
    index.upsert(row("Live title", "2026-10-22"));
    index.insert_cached(row("Old title", "2026-10-21"));
    assert_eq!(index.page(None, 64).0[0]["title"], "Live title");
}

#[tokio::test]
async fn summary_refreshes_once_after_a_fixed_window_and_coalesces_updates() {
    let path =
        std::env::temp_dir().join(format!("synax-summary-throttle-{}", uuid::Uuid::new_v4()));
    let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
    seed_summary(&hot, "s");
    hot.flush().unwrap();
    let summary_path = layout::session_dir(&path, "s")
        .unwrap()
        .join("list-summary.json");
    let original = std::fs::read(&summary_path).unwrap();

    hot.control(
        "s",
        "rename",
        1,
        0,
        "session_patch",
        &serde_json::to_vec(&json!({
            "patch": { "title": "Newest title" }
        }))
        .unwrap(),
    )
    .unwrap();
    hot.flush_session("s").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(std::fs::read(&summary_path).unwrap(), original);

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let refreshed: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&summary_path).unwrap()).unwrap();
    assert_eq!(refreshed["row"]["h"]["title"], "Newest title");
    drop(hot);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
#[ignore = "manual session-list startup benchmark"]
fn benchmark_session_list_restart() {
    let path =
        std::env::temp_dir().join(format!("synax-summary-benchmark-{}", uuid::Uuid::new_v4()));
    let ids: Vec<_> = (0..20).map(|i| format!("session-{i}")).collect();
    {
        let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
        for id in &ids {
            seed_summary(&hot, id);
            for revision in 0..50 {
                hot.control(id, &format!("patch-{revision}"), 1, revision, "session_patch",
                    &serde_json::to_vec(&json!({ "patch": {
                        "title": format!("Title {revision}"),
                        "sessionMetadata": { "latestSystemPrompt": format!("{} {revision}", "x".repeat(32_000)) },
                    }})).unwrap()).unwrap();
            }
            hot.flush_session(id).unwrap();
        }
        hot.flush().unwrap();
    }
    let cold = {
        for id in &ids {
            std::fs::remove_file(
                layout::session_dir(&path, id)
                    .unwrap()
                    .join("list-summary.json"),
            )
            .unwrap();
        }
        let store = JsonlStore::open(&path).unwrap();
        let start = std::time::Instant::now();
        for id in &ids {
            assert!(store.load_list_entry(id).unwrap());
        }
        start.elapsed()
    };
    let store = JsonlStore::open(&path).unwrap();
    let start = std::time::Instant::now();
    for id in &ids {
        assert!(!store.load_list_entry(id).unwrap());
    }
    let cached = start.elapsed();
    assert_eq!(store.list().read().len(), ids.len());
    assert!(store.root.sessions.values().is_empty());
    eprintln!(
        "Session list: {} sessions, 50 updates each; header-index rebuild {cold:?}, summary restore {cached:?}",
        ids.len()
    );
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

fn patch_summary(hot: &HotOps, request: &str, revision: u64, title: &str) {
    hot.control(
        "s",
        request,
        1,
        revision,
        "session_patch",
        &serde_json::to_vec(&json!({"patch": {"title": title}})).unwrap(),
    )
    .unwrap();
}

fn wait_for_summary(path: &std::path::Path, title: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if summary_cache::read(path, "s").is_some_and(|row| row.h["title"] == title) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "summary did not reach {title}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn repeated_dirty_updates_keep_the_first_deadline_and_idle_flushes_do_not_rewrite() {
    let path = std::env::temp_dir().join(format!("synax-summary-window-{}", uuid::Uuid::new_v4()));
    let store = JsonlStore::open(&path).unwrap();
    let hot = HotOps::new(Arc::new(store.clone()));
    seed_summary(&hot, "s");
    hot.flush().unwrap();
    patch_summary(&hot, "one", 0, "One");
    hot.flush_session("s").unwrap();
    let first = store.root.summary_cache.pending_deadline("s").unwrap();
    patch_summary(&hot, "two", 1, "Two");
    hot.flush_session("s").unwrap();
    assert_eq!(store.root.summary_cache.pending_deadline("s"), Some(first));
    wait_for_summary(&path, "Two");
    store.flush_session_summary("s");
    let file = layout::session_dir(&path, "s")
        .unwrap()
        .join("list-summary.json");
    let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
    for _ in 0..10 {
        hot.flush_session("s").unwrap();
    }
    assert!(store.root.summary_cache.pending_deadline("s").is_none());
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        modified
    );
    drop(hot);
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn updates_during_summary_staging_remain_dirty_and_capture_only_synced_commits() {
    let path =
        std::env::temp_dir().join(format!("synax-summary-inflight-{}", uuid::Uuid::new_v4()));
    let store = JsonlStore::open(&path).unwrap();
    let hot = HotOps::new(Arc::new(store.clone()));
    seed_summary(&hot, "s");
    hot.flush().unwrap();
    let (captured, wait_captured) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    store.root.summary_cache.before_stage(move || {
        captured.send(()).unwrap();
        resume
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    });
    patch_summary(&hot, "one", 0, "One");
    hot.flush_session("s").unwrap();
    wait_captured
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    patch_summary(&hot, "two", 1, "Two");
    hot.flush_session("s").unwrap();
    release.send(()).unwrap();
    wait_for_summary(&path, "Two");
    let handle = hot.handle("s").unwrap();
    let actor = handle.actor.lock();
    assert_eq!(actor.summary_commit, actor.commit);
    assert_eq!(actor.durable_commit, actor.commit);
    drop(actor);
    drop(handle);
    drop(hot);
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn failed_summary_publication_does_not_fail_durability_and_retries_after_repair() {
    let path = std::env::temp_dir().join(format!("synax-summary-retry-{}", uuid::Uuid::new_v4()));
    let store = JsonlStore::open(&path).unwrap();
    let hot = HotOps::new(Arc::new(store.clone()));
    seed_summary(&hot, "s");
    hot.flush().unwrap();
    let directory = layout::session_dir(&path, "s").unwrap();
    let file = directory.join("list-summary.json");
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    patch_summary(&hot, "changed", 0, "Durable despite cache failure");
    hot.flush_session("s").unwrap();
    // A final flush makes one failed attempt and returns without waiting through
    // the retry backoff. Committed records remain available to recovery.
    store.flush_session_summary("s");
    assert!(store.root.summary_cache.pending_deadline("s").is_some());
    assert!(!std::fs::read_dir(&directory).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    }));
    std::fs::remove_dir(&file).unwrap();
    wait_for_summary(&path, "Durable despite cache failure");
    drop(hot);
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn a_summary_captured_before_reset_cannot_publish_into_a_recreated_session() {
    let path = std::env::temp_dir().join(format!("synax-summary-reset-{}", uuid::Uuid::new_v4()));
    let store = JsonlStore::open(&path).unwrap();
    let hot = HotOps::new(Arc::new(store.clone()));
    seed_summary(&hot, "s");
    hot.flush().unwrap();
    let (captured, wait_captured) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    store.root.summary_cache.before_stage(move || {
        captured.send(()).unwrap();
        resume
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    });
    patch_summary(&hot, "old", 0, "Old lifecycle");
    hot.flush_session("s").unwrap();
    wait_captured
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    store.reset_all().unwrap();
    seed_summary(&hot, "s");
    patch_summary(&hot, "new", 0, "New lifecycle");
    hot.flush_session("s").unwrap();
    release.send(()).unwrap();
    store.flush_session_summary("s");
    wait_for_summary(&path, "New lifecycle");
    assert_eq!(
        store.session_summary("s").unwrap().unwrap()["title"],
        "New lifecycle"
    );
    drop(hot);
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn deletion_fences_a_captured_summary_and_removes_its_pending_work() {
    let path = std::env::temp_dir().join(format!("synax-summary-delete-{}", uuid::Uuid::new_v4()));
    let store = JsonlStore::open(&path).unwrap();
    let hot = HotOps::new(Arc::new(store.clone()));
    seed_summary(&hot, "s");
    hot.flush().unwrap();
    let (captured, wait_captured) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    store.root.summary_cache.before_stage(move || {
        captured.send(()).unwrap();
        resume
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    });
    patch_summary(&hot, "old", 0, "Will be deleted");
    hot.flush_session("s").unwrap();
    wait_captured
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let directory = layout::session_dir(&path, "s").unwrap();
    {
        let _lifecycle = store.summary_lifecycle();
        let marker = layout::deletion_marker(&path, "s");
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(marker, b"").unwrap();
        std::fs::remove_dir_all(&directory).unwrap();
        store.forget_deleted_session("s").unwrap();
    }
    release.send(()).unwrap();
    drop(hot);
    drop(store);
    assert!(!directory.exists());
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn summary_waits_for_normal_durability_and_process_lease_flush_wakes_existing_work() {
    let path = std::env::temp_dir().join(format!("synax-summary-durable-{}", uuid::Uuid::new_v4()));
    let store = JsonlStore::open(&path).unwrap();
    let hot = HotOps::new(Arc::new(store.clone()));
    seed_summary(&hot, "s");
    hot.flush().unwrap();
    let saved = hot.handle("s").unwrap().actor.lock().summary_commit;
    patch_summary(&hot, "synced", 0, "Synced");
    hot.flush_session("s").unwrap();
    patch_summary(&hot, "unsynced", 1, "Waiting for durability");
    std::thread::sleep(std::time::Duration::from_millis(1100));
    {
        let handle = hot.handle("s").unwrap();
        let actor = handle.actor.lock();
        assert_eq!(actor.summary_commit, saved);
        assert!(actor.durable_commit < actor.commit);
    }
    assert!(store.root.summary_cache.pending_deadline("s").is_some());
    store.flush_process_leases("s").unwrap();
    wait_for_summary(&path, "Waiting for durability");
    store.flush_session_summary("s");
    // Lease-only durability with no pending summary does not schedule one.
    store.flush_process_leases("s").unwrap();
    assert!(store.root.summary_cache.pending_deadline("s").is_none());
    drop(hot);
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn unavailable_summary_source_metadata_is_retried_without_another_business_update() {
    let path = std::env::temp_dir().join(format!(
        "synax-summary-source-retry-{}",
        uuid::Uuid::new_v4()
    ));
    let store = JsonlStore::open(&path).unwrap();
    let hot = HotOps::new(Arc::new(store.clone()));
    seed_summary(&hot, "s");
    hot.flush().unwrap();
    patch_summary(&hot, "changed", 0, "Retry source metadata");
    let (controls, saved) = {
        let handle = hot.handle("s").unwrap();
        let actor = handle.actor.lock();
        (
            actor.files.controls.path().to_path_buf(),
            actor.summary_commit,
        )
    };
    let moved = controls.with_extension("temporarily-moved");
    std::fs::rename(&controls, &moved).unwrap();
    // The open writer's fsync remains valid, while summary fingerprint capture
    // cannot stat the original name. This is a cache failure, never an ACK error.
    hot.flush_session("s").unwrap();
    store.flush_session_summary("s");
    assert!(store.root.summary_cache.pending_deadline("s").is_some());
    assert_eq!(hot.handle("s").unwrap().actor.lock().summary_commit, saved);
    std::fs::rename(&moved, &controls).unwrap();
    wait_for_summary(&path, "Retry source metadata");
    store.flush_session_summary("s");
    assert!(store.root.summary_cache.pending_deadline("s").is_none());
    drop(hot);
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn stale_staged_summary_does_not_replace_a_newer_published_cache() {
    let path = std::env::temp_dir().join(format!(
        "synax-summary-publish-order-{}",
        uuid::Uuid::new_v4()
    ));
    let store = JsonlStore::open(&path).unwrap();
    let hot = HotOps::new(Arc::new(store.clone()));
    seed_summary(&hot, "s");
    hot.flush().unwrap();
    let old = {
        let handle = hot.handle("s").unwrap();
        let actor = handle.actor.lock();
        summary_cache::capture(&path, &actor).unwrap().unwrap()
    }
    .stage()
    .unwrap();
    patch_summary(&hot, "new", 0, "Newer published cache");
    hot.flush().unwrap();
    assert!(!store.root.summary_cache.publish_rebuilt(old).unwrap());
    assert_eq!(
        summary_cache::read(&path, "s").unwrap().h["title"],
        "Newer published cache"
    );
    drop(hot);
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn sustained_sync_updates_publish_large_summaries_fairly_before_streams_stop() {
    use std::{
        collections::HashSet,
        time::{Duration, Instant},
    };

    let path =
        std::env::temp_dir().join(format!("synax-summary-continuous-{}", uuid::Uuid::new_v4()));
    let store = JsonlStore::open(&path).unwrap();
    let hot = HotOps::new(Arc::new(store.clone()));
    let ids = ["stream-a", "stream-b"];
    let metadata = json!({
        "mcpToolDefinitions": [{ "name": "large-tool", "description": "x".repeat(190_000) }],
    });
    for id in ids {
        hot.ui_snapshot(
            id,
            Some(
                &serde_json::to_vec(&json!({
                    "id": id, "projectId": "p", "status": "running", "title": format!("{id}-seed"),
                    "updatedAt": "2026-10-28T00:00:00Z", "sessionMetadata": metadata,
                }))
                .unwrap(),
            ),
        )
        .unwrap();
    }
    hot.flush().unwrap();
    let files = ids.map(|id| {
        layout::session_dir(&path, id)
            .unwrap()
            .join("list-summary.json")
    });
    let mut published: [HashSet<String>; 2] = std::array::from_fn(|_| HashSet::new());
    let mut revision = 0;
    let started = Instant::now();
    // Updates continue over multiple refresh windows. Reading the published row
    // directly observes replacements even when the next committed source prefix
    // has already invalidated that row for cold-start use.
    while started.elapsed() < Duration::from_millis(3300) {
        for (index, id) in ids.iter().enumerate() {
            hot.control(
                id,
                &format!("patch-{revision}"),
                1,
                revision,
                "session_patch",
                &serde_json::to_vec(&json!({"patch": {"title": format!("{id}-{revision}")}}))
                    .unwrap(),
            )
            .unwrap();
            hot.flush_session(id).unwrap();
            let saved: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&files[index]).unwrap()).unwrap();
            let title = saved["row"]["h"]["title"].as_str().unwrap();
            if title != format!("{id}-seed") {
                published[index].insert(title.to_owned());
            }
            assert!(saved["row"]["h"]["sessionMetadata"].get("mcpToolDefinitions").is_none());
            assert_eq!(hot.handle(id).unwrap().read().header.to_json()["sessionMetadata"]["mcpToolDefinitions"], metadata["mcpToolDefinitions"],
                "execution metadata must remain authoritative outside the list projection");
        }
        revision += 1;
        std::thread::sleep(Duration::from_millis(40));
    }
    assert!(
        revision > 4,
        "test must keep producing across the refresh windows"
    );
    for (index, id) in ids.iter().enumerate() {
        assert!(
            published[index].len() >= 2,
            "{id} must publish repeatedly while both streams are still updating: {:?}",
            published[index]
        );
    }

    hot.flush().unwrap();
    let mut final_modified = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        let final_row = summary_cache::read(&path, id).unwrap();
        assert_eq!(final_row.h["title"], format!("{id}-{}", revision - 1));
        assert!(final_row.h["sessionMetadata"].get("mcpToolDefinitions").is_none());
        assert!(store.root.summary_cache.pending_deadline(id).is_none());
        final_modified.push(
            std::fs::metadata(&files[index])
                .unwrap()
                .modified()
                .unwrap(),
        );
    }
    // Cross another full refresh window with no business updates. Successful
    // redundant durability calls must not requeue or rewrite an unchanged row.
    let idle = Instant::now();
    while idle.elapsed() < Duration::from_millis(1100) {
        for id in ids {
            hot.flush_session(id).unwrap();
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    for (index, id) in ids.iter().enumerate() {
        assert!(store.root.summary_cache.pending_deadline(id).is_none());
        assert_eq!(
            std::fs::metadata(&files[index])
                .unwrap()
                .modified()
                .unwrap(),
            final_modified[index]
        );
    }
    drop(hot);
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn old_summary_cache_is_compacted_without_losing_execution_metadata_or_replaying_history() {
    let path = std::env::temp_dir().join(format!("summary-upgrade-{}", uuid::Uuid::new_v4()));
    let definitions = json!({"schema":"x".repeat(190_000)});
    {
        let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
        hot.ui_snapshot("s", Some(&serde_json::to_vec(&json!({"id":"s", "projectId":"p", "title":"upgrade", "status":"completed", "updatedAt":"2026-10-28T00:00:00Z", "sessionMetadata":{
            "mcpToolDefinitions":definitions,"pinned":true
        }})).unwrap())).unwrap();
        hot.flush().unwrap();
    }
    let file = layout::session_dir(&path, "s").unwrap().join("list-summary.json");
    let mut legacy: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    legacy["schema"] = json!(2);
    legacy["row"]["h"]["sessionMetadata"]["mcpToolDefinitions"] = definitions.clone();
    std::fs::write(&file, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let store = JsonlStore::open(&path).unwrap();
    assert!(!store.load_list_entry("s").unwrap(), "valid legacy cache must not replay the journal");
    assert!(store.root.sessions.values().is_empty());
    assert!(std::fs::metadata(&file).unwrap().len() < 2000);
    assert!(store.session_summary("s").unwrap().unwrap()["sessionMetadata"].get("mcpToolDefinitions").is_none());
    let hot = HotOps::new(Arc::new(store.clone()));
    let detail: serde_json::Value = serde_json::from_slice(&hot.ui_snapshot("s", None).unwrap()).unwrap();
    assert_eq!(detail["session"]["sessionMetadata"]["mcpToolDefinitions"], definitions);
    drop(hot); drop(store);
    std::fs::remove_dir_all(path).unwrap();
}
