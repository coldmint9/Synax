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
    hot.ui_snapshot(id, Some(&serde_json::to_vec(&json!({
        "id": id, "projectId": "p", "status": "completed", "title": "Saved title",
        "updatedAt": "2026-10-22", "sessionMetadata": {
            "latestSystemPrompt": "x".repeat(32_000), "pinned": true,
        },
    })).unwrap())).unwrap();
}

#[test]
fn a_targeted_summary_does_not_start_the_global_scan_or_open_an_execution_actor() {
    let path = std::env::temp_dir().join(format!("synax-targeted-summary-{}", uuid::Uuid::new_v4()));
    {
        let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
        seed_summary(&hot, "s");
    }
    // Even a missing query cache repairs just the session's header. Debug
    // system-prompt assets are not needed to render a list row.
    let assets = path.join(layout::ASSETS_DIR);
    if assets.exists() { std::fs::remove_dir_all(assets).unwrap(); }
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
        for id in ["a", "b", "c"] { seed_summary(&hot, id); }
        hot.flush().unwrap();
    }
    let store = JsonlStore::open(&path).unwrap();
    for id in ["a", "b", "c"] { assert!(!store.load_list_entry(id).unwrap()); }
    // load_list_entry does not evict: an accidental replay would leave actors.
    assert!(store.root.sessions.values().is_empty());
    assert!(!store.index_ready().unwrap());
    store.wait_for_index_scan().await;
    assert!(store.index_ready().unwrap());
    let (rows, _) = store.list().read().page(None, 64);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["title"], "Saved title");
    assert_eq!(rows[0]["sessionMetadata"]["pinned"], true);
    assert!(rows[0]["sessionMetadata"].get("latestSystemPrompt").is_none());
    assert!(store.root.sessions.values().is_empty());
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn missing_summaries_are_repaired_without_actors_and_idle_eviction_saves_new_rows() {
    let path = std::env::temp_dir().join(format!("synax-summary-backfill-{}", uuid::Uuid::new_v4()));
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
    for id in ["old", "new"] { store.load_list_entry(id).unwrap(); }
    assert!(store.root.sessions.values().is_empty());
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn commits_after_the_cached_summary_are_replayed_including_segment_rolls() {
    for roll in [false, true] {
        let path = std::env::temp_dir().join(format!("synax-summary-stale-{}", uuid::Uuid::new_v4()));
        {
            let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
            seed_summary(&hot, "s");
            hot.flush().unwrap();
            assert!(summary_cache::read(&path, "s").is_some());
            let summary_path = layout::session_dir(&path, "s").unwrap().join("list-summary.json");
            let old_summary = std::fs::read(&summary_path).unwrap();
            if roll {
                hot.handle("s").unwrap().actor.lock().files.extent.frames[2] = super::super::session::FRAMES_PER_SEGMENT;
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
    for broken in ["invalid-json", "wrong-schema", "wrong-session", "unwritable"] {
        let path = std::env::temp_dir().join(format!("synax-summary-invalid-{}", uuid::Uuid::new_v4()));
        {
            let hot = HotOps::new(Arc::new(JsonlStore::open(&path).unwrap()));
            seed_summary(&hot, "s");
            hot.flush().unwrap();
        }
        let summary = layout::session_dir(&path, "s").unwrap().join("list-summary.json");
        let mut saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&summary).unwrap()).unwrap();
        match broken {
            "invalid-json" => std::fs::write(&summary, b"{").unwrap(),
            "unwritable" => { std::fs::remove_file(&summary).unwrap(); std::fs::create_dir(&summary).unwrap(); }
            _ => {
                if broken == "wrong-schema" { saved["schema"] = json!(0); }
                else { saved["row"]["s"] = json!("other"); }
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
        s: "s".into(), u: updated.into(), del: false,
        h: json!({"id": "s", "title": title, "updatedAt": updated}),
    };
    index.upsert(row("Live title", "2026-10-22"));
    index.insert_cached(row("Old title", "2026-10-21"));
    assert_eq!(index.page(None, 64).0[0]["title"], "Live title");
}

#[test]
#[ignore = "manual session-list startup benchmark"]
fn benchmark_session_list_restart() {
    let path = std::env::temp_dir().join(format!("synax-summary-benchmark-{}", uuid::Uuid::new_v4()));
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
    }
    let cold = {
        for id in &ids {
            std::fs::remove_file(layout::session_dir(&path, id).unwrap().join("list-summary.json")).unwrap();
        }
        let store = JsonlStore::open(&path).unwrap();
        let start = std::time::Instant::now();
        for id in &ids { assert!(store.load_list_entry(id).unwrap()); }
        start.elapsed()
    };
    let store = JsonlStore::open(&path).unwrap();
    let start = std::time::Instant::now();
    for id in &ids { assert!(!store.load_list_entry(id).unwrap()); }
    let cached = start.elapsed();
    assert_eq!(store.list().read().len(), ids.len());
    assert!(store.root.sessions.values().is_empty());
    eprintln!("Session list: {} sessions, 50 updates each; header-index rebuild {cold:?}, summary restore {cached:?}", ids.len());
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}
