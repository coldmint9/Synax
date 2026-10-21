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
    assert_eq!(store.evict_idle(), 1);
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
