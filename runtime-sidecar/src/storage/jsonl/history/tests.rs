//! History engine end-to-end tests through the command façade.

use std::sync::Arc;

use serde_json::Value;

use super::json::{boolean, number, object, text};
use super::wire::HistoryError;
use super::HistoryOps;
use crate::storage::jsonl::store::JsonlStore;

fn temp_root(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("synax-history-{label}-{}", uuid::Uuid::new_v4()))
}

fn open(root: &std::path::Path) -> (Arc<JsonlStore>, HistoryOps) {
    let store = Arc::new(JsonlStore::open(root).unwrap());
    let ops = HistoryOps::new(store.clone());
    (store, ops)
}

fn temp() -> Value {
    Value::Object(Default::default())
}

#[test]
fn history_index_snapshot_preserves_cursors_and_replays_only_the_committed_tail() {
    let root = temp_root("index-checkpoint");
    let (store, ops) = open(&root);
    ok(&ops, "s", "first", "append_entities", objects(serde_json::json!([message("a", 1, "a"), message("b", 2, "b")])));
    let window = ok(&ops, "s", "window", "history_sync", serde_json::json!({"limit":1}));
    assert_eq!(window["messages"][0]["id"], "b");
    assert_eq!(ops.evict_idle(), 0);
    assert_eq!(ops.evict_with_policy(0, std::time::Duration::ZERO), 1);
    let directory = super::history_path(&root, "s").unwrap();
    let (snapshot, offset) = super::checkpoint::read(&directory, "s").unwrap();
    assert_eq!(snapshot.head.revision, 1);
    ok(&ops, "s", "second", "append_entities", objects(serde_json::json!([message("c", 3, "c")])));
    // Replay directly from the persisted position before dropping the writer
    // (normal release will replace the snapshot with the newer index).
    let mut index = snapshot;
    let end = super::replay_into(&directory.join(super::HISTORY_FILE), &mut index, false, offset).unwrap();
    assert!(end > offset);
    let delta = super::sync::history_sync(&index, "s", &serde_json::json!({"since":window["historyWindow"]["syncCursor"]})).unwrap();
    assert_eq!(delta["messages"].as_array().unwrap().len(), 1);
    assert_eq!(delta["messages"][0]["id"], "c");
    let older = super::sync::history_sync(&index, "s", &serde_json::json!({"cursor":window["historyWindow"]["olderCursor"]})).unwrap();
    assert_eq!(older["messages"][0]["id"], "a");
    drop(ops); drop(store);
    let session = super::HistorySession::open(&root, "s").unwrap();
    assert_eq!(session.lock.lock().checkpoint_offset, end);
    assert_eq!(session.lock.lock().index.head.revision, 2);
    drop(session);
    std::fs::write(directory.join("history-index.bin"), b"corrupt").unwrap();
    let repaired = super::HistorySession::open(&root, "s").unwrap();
    assert_eq!(repaired.lock.lock().checkpoint_offset, 0);
    assert_eq!(repaired.lock.lock().index.head.revision, 2);
    drop(repaired);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn commits_publish_the_new_query_index_to_other_sessions_without_reopening() {
    let root = temp_root("published-index");
    let (store, ops) = open(&root);
    let latest = ok(&ops, "s", "append", "append_entities", objects(serde_json::json!([message("latest", 1, "new content")])));
    ok(&ops, "copy", "fork", "fork", serde_json::json!({"sourceSessionId":"s"}));
    let copied = ok(&ops, "copy", "head", "head_read", temp());
    assert_eq!(copied["objectId"], latest["objectId"]);
    drop(ops); drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

fn call(
    ops: &HistoryOps,
    session: &str,
    request: &str,
    operation: &str,
    payload: Value,
) -> Result<Value, HistoryError> {
    let bytes = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(ops.command_async(
            session.to_owned(),
            request.to_owned(),
            operation.to_owned(),
            serde_json::to_vec(&payload).unwrap(),
        ));
    bytes.map(|bytes| serde_json::from_slice(&bytes).unwrap())
}

fn ok(ops: &HistoryOps, session: &str, request: &str, operation: &str, payload: Value) -> Value {
    match call(ops, session, request, operation, payload) {
        Ok(value) => value,
        Err(error) => panic!("{operation} failed: {error:?}"),
    }
}

/// `{"objects": [...]}` as an append payload.
fn objects(items: Value) -> Value {
    object(&[("objects", items)])
}

fn with(pairs: &[(&str, Value)]) -> Value {
    object(pairs)
}

fn message(id: &str, sequence: u64, content: &str) -> Value {
    object(&[
        ("kind", text("runtime.message")),
        (
            "value",
            object(&[
                ("id", text(id)),
                ("sessionId", text("s")),
                ("sequence", number(sequence)),
                ("content", text(content)),
            ]),
        ),
    ])
}

fn tombstone(id: &str) -> Value {
    object(&[
        ("kind", text("runtime.tombstone")),
        (
            "value",
            object(&[
                ("id", text(id)),
                ("sessionId", text("s")),
                ("entityKind", text("runtime.message")),
            ]),
        ),
    ])
}

fn head(ops: &HistoryOps) -> Value {
    ok(ops, "s", "head", "head_read", temp())
}

fn list(ops: &HistoryOps, request: &str, payload: Value) -> Value {
    ok(ops, "s", request, "list_messages", payload)
}

fn cleanup(root: std::path::PathBuf) {
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn append_entities_bumps_revision_and_receipts_are_idempotent() {
    let root = temp_root("append");
    let (store, ops) = open(&root);
    let payload = objects(Value::Array(vec![message("m", 1, "hello")]));
    let first = ok(&ops, "s", "append", "append_entities", payload.clone());
    assert_eq!(first["revision"], 1);
    assert_eq!(first["sessionId"], "s");
    // The same request id with the same input replays the receipt.
    assert_eq!(
        ok(&ops, "s", "append", "append_entities", payload.clone()),
        first
    );
    assert_eq!(head(&ops), first);
    // The same request id with different input is a conflict.
    let changed = objects(Value::Array(vec![message("n", 2, "x")]));
    assert!(matches!(
        call(&ops, "s", "append", "append_entities", changed.clone()),
        Err(HistoryError::RequestConflict)
    ));
    // Revision fencing.
    let stale = with(&[
        ("expectedRevision", number(0)),
        ("objects", Value::Array(vec![message("n", 2, "x")])),
    ]);
    assert!(matches!(
        call(&ops, "s", "stale", "append_entities", stale),
        Err(HistoryError::RevisionConflict {
            expected: 0,
            actual: 1
        })
    ));
    let fenced = with(&[
        ("expectedRevision", number(1)),
        ("objects", Value::Array(vec![message("m", 2, "again")])),
    ]);
    let second = ok(&ops, "s", "append-2", "append_entities", fenced);
    assert_eq!(second["revision"], 2);
    // A rejected multi-entity append publishes nothing.
    let mut foreign = message("foreign", 3, "no");
    foreign["value"]["sessionId"] = text("other");
    let rejected = objects(Value::Array(vec![message("orphan", 3, "no"), foreign]));
    assert!(call(&ops, "s", "bad", "append_entities", rejected).is_err());
    assert_eq!(head(&ops)["revision"], 2);
    // A cold open replays the file and the receipts to the same head.
    drop(ops);
    drop(store);
    let (store, reopened) = open(&root);
    assert_eq!(head(&reopened), second);
    // The persisted receipt fences a reused request id regardless of the
    // current head revision.
    assert_eq!(
        ok(&reopened, "s", "append", "append_entities", payload),
        first
    );
    assert_eq!(
        list(&reopened, "list_messages", temp())["items"][0]["content"],
        "again"
    );
    drop(store);
    cleanup(root);
}

#[test]
fn list_pages_walk_latest_first_with_revision_fencing() {
    let root = temp_root("list");
    let (store, ops) = open(&root);
    let items: Vec<Value> = (1..=5)
        .map(|i| message(&format!("m{i}"), i, &format!("c{i}")))
        .collect();
    ok(&ops, "s", "append", "append_entities", objects(Value::Array(items)));
    let mut cursor = Value::Null;
    let mut order = Vec::new();
    loop {
        let page = list(
            &ops,
            &format!("p{}", order.len()),
            with(&[
                ("reverse", boolean(true)),
                ("limit", number(2)),
                ("cursor", cursor),
            ]),
        );
        for item in page["items"].as_array().unwrap() {
            order.push(item["id"].as_str().unwrap().to_owned());
        }
        cursor = page["cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(order, ["m5", "m4", "m3", "m2", "m1"]);
    // Forward paging is oldest first.
    let first = list(
        &ops,
        "f1",
        with(&[("reverse", boolean(false)), ("limit", number(3))]),
    );
    assert_eq!(first["items"][0]["sequence"], 1);
    let next_payload = with(&[
        ("reverse", boolean(false)),
        ("cursor", first["cursor"].clone()),
    ]);
    let second_page = list(&ops, "f2", next_payload.clone());
    assert_eq!(second_page["items"][0]["sequence"], 4);
    // A stale page cursor (the head moved) is a revision conflict.
    ok(
        &ops,
        "s",
        "more",
        "append_entities",
        objects(Value::Array(vec![message("m6", 6, "c6")])),
    );
    assert!(matches!(
        call(&ops, "s", "f3", "list_messages", next_payload),
        Err(HistoryError::RevisionConflict {
            expected: 1,
            actual: 2
        })
    ));
    // The newest value of an id wins and tombstones remove it.
    ok(
        &ops,
        "s",
        "replace",
        "append_entities",
        objects(Value::Array(vec![
            message("m1", 1, &format!("v{}", 1)),
            message("m1", 2, &format!("v{}{}", 2, "st")),
        ])),
    );
    let page = list(&ops, "all", temp());
    assert_eq!(page["items"].as_array().unwrap().len(), 6);
    let newest = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "m1")
        .expect("m1 is visible");
    assert_eq!(newest["content"], format!("v{}{}", 2, "st"));
    ok(
        &ops,
        "s",
        "remove",
        "append_entities",
        objects(Value::Array(vec![tombstone("m2")])),
    );
    let page = list(&ops, "after-remove", temp());
    let items = page["items"].as_array().unwrap();
    assert!(items.iter().all(|item| item["id"] != "m2"));
    assert_eq!(items.len(), 5);
    drop(store);
    cleanup(root);
}

#[test]
fn history_sync_is_incremental_after_the_watermark() {
    let root = temp_root("sync");
    let (store, ops) = open(&root);
    ok(&ops, "s", "append", "append_entities", objects(Value::Array(vec![
        message("a", 1, "old"), message("b", 2, "keep"), message("c", 3, "remove"),
    ])));
    let initial = ok(&ops, "s", "initial", "history_sync", with(&[("limit", number(1))]));
    assert_eq!(initial["messages"][0]["id"], "c");
    let since = initial["historyWindow"]["syncCursor"].clone();
    let older_cursor = initial["historyWindow"]["olderCursor"].clone();
    let unchanged = ok(&ops, "s", "unchanged", "history_sync", with(&[("since", since.clone())]));
    assert!(unchanged["messages"].as_array().unwrap().is_empty());
    assert_eq!(unchanged["historyWindow"]["hasMoreChanges"], false);

    ok(&ops, "s", "next-turn", "append_entities", objects(Value::Array(vec![
        message("a", 1, "updated"), tombstone("c"), message("d", 4, "new reply"),
    ])));
    let first = ok(&ops, "s", "first", "history_sync", with(&[
        ("limit", number(1)), ("since", since),
    ]));
    assert_eq!(first["messages"][0]["content"], "updated");
    assert_eq!(first["historyWindow"]["hasMoreChanges"], true);
    assert_eq!(first["historyWindow"]["generation"], initial["historyWindow"]["generation"]);

    // Writes during pagination belong to the following refresh, not this page set.
    ok(&ops, "s", "while-paging", "append_entities", objects(Value::Array(vec![message("e", 5, "later reply")])));
    let second = ok(&ops, "s", "second", "history_sync", with(&[
        ("limit", number(1)), ("since", first["historyWindow"]["syncCursor"].clone()),
    ]));
    assert_eq!(second["removed"][0]["id"], "c");
    assert_eq!(second["historyWindow"]["hasMoreChanges"], true);
    let third = ok(&ops, "s", "third", "history_sync", with(&[
        ("limit", number(1)), ("since", second["historyWindow"]["syncCursor"].clone()),
    ]));
    assert_eq!(third["messages"][0]["id"], "d");
    assert_eq!(third["historyWindow"]["hasMoreChanges"], false);
    assert_eq!(third["historyWindow"]["revision"], first["historyWindow"]["revision"]);
    let later = ok(&ops, "s", "later", "history_sync", with(&[
        ("since", third["historyWindow"]["syncCursor"].clone()),
    ]));
    assert_eq!(later["messages"].as_array().unwrap().len(), 1);
    assert_eq!(later["messages"][0]["id"], "e");

    // Browsing earlier history still uses its own reverse cursor after appends.
    let older = ok(&ops, "s", "older", "history_sync", with(&[("cursor", older_cursor)]));
    assert_eq!(older["messages"][0]["id"], "b");
    let cursor = later["historyWindow"]["syncCursor"].clone();
    drop(ops);
    drop(store);
    let (store, reopened) = open(&root);
    let unchanged = ok(&reopened, "s", "after-restart", "history_sync", with(&[("since", cursor.clone())]));
    assert!(unchanged["messages"].as_array().unwrap().is_empty());
    ok(&reopened, "s", "after-restart-append", "append_entities", objects(Value::Array(vec![message("f", 6, "reopened reply")])));
    let next = ok(&reopened, "s", "after-restart-sync", "history_sync", with(&[("since", cursor)]));
    assert_eq!(next["messages"][0]["id"], "f");
    drop(reopened);
    drop(store);
    cleanup(root);
}

#[test]
fn history_sync_preserves_latest_update_delete_and_recreate_order() {
    let root = temp_root("sync-updates");
    let (store, ops) = open(&root);
    let initial = ok(&ops, "s", "initial", "history_sync", temp());
    ok(&ops, "s", "updates", "append_entities", objects(Value::Array(vec![
        message("a", 1, "old"), message("a", 1, "new"),
        message("b", 2, "removed"), tombstone("b"),
        message("c", 3, "old"), tombstone("c"), message("c", 3, "recreated"),
    ])));
    let page = ok(&ops, "s", "sync", "history_sync", with(&[("since", initial["historyWindow"]["syncCursor"].clone())]));
    assert_eq!(page["messages"].as_array().unwrap().len(), 2);
    assert_eq!(page["messages"][0]["content"], "new");
    assert_eq!(page["messages"][1]["content"], "recreated");
    assert_eq!(page["removed"].as_array().unwrap().len(), 1);
    assert_eq!(page["removed"][0]["id"], "b");
    drop(ops);
    drop(store);
    cleanup(root);
}

#[test]
fn history_sync_large_records_do_not_hide_other_collections() {
    let root = temp_root("sync-large");
    let (store, ops) = open(&root);
    let large = "上下文🙂".repeat(50_000);
    let initial = ok(&ops, "s", "initial", "history_sync", temp());
    let run = object(&[("kind", text("runtime.run")), ("value", object(&[
        ("id", text("r")), ("sessionId", text("s")), ("status", text("completed")),
    ]))]);
    ok(&ops, "s", "append", "append_entities", objects(Value::Array(vec![
        message("big-1", 1, &large), message("big-2", 2, &large), run,
    ])));
    for payload in [temp(), with(&[("since", initial["historyWindow"]["syncCursor"].clone())])] {
        let page = ok(&ops, "s", "sync", "history_sync", payload);
        assert_eq!(page["messages"].as_array().unwrap().len(), 2);
        assert_eq!(page["runs"][0]["id"], "r");
        assert!(page["messages"][0]["bytes"].as_u64().unwrap() > 512 * 1024);
        assert!(serde_json::to_vec(&page).unwrap().len() < 512 * 1024);
    }
    drop(ops);
    drop(store);
    cleanup(root);
}

#[test]
fn history_sync_byte_budget_preserves_all_collection_cursors() {
    let root = temp_root("sync-budget");
    let (store, ops) = open(&root);
    let mut entities: Vec<Value> = (0..30)
        .map(|n| message(&format!("m{n}"), n, &"x".repeat(30_000)))
        .collect();
    entities.push(object(&[("kind", text("runtime.run")), ("value", object(&[
        ("id", text("run")), ("sessionId", text("s")), ("status", text("completed")),
    ]))]));
    ok(&ops, "s", "append", "append_entities", objects(Value::Array(entities)));
    let mut cursor = Value::Null;
    let mut ids = std::collections::HashSet::new();
    for page_number in 0..30 {
        let page = ok(&ops, "s", "page", "history_sync", with(&[("cursor", cursor.clone())]));
        assert!(serde_json::to_vec(&page).unwrap().len() <= 512 * 1024);
        if page_number == 0 {
            assert_eq!(page["runs"][0]["id"], "run");
        }
        for item in page["messages"].as_array().unwrap() {
            assert!(ids.insert(item["id"].as_str().unwrap().to_owned()));
        }
        let next = page["historyWindow"]["olderCursor"].clone();
        if next.is_null() { break; }
        assert_ne!(next, cursor);
        cursor = next;
    }
    assert_eq!(ids.len(), 30);
    drop(ops);
    drop(store);
    cleanup(root);
}

#[test]
fn history_sync_cursors_are_invalidated_after_rollback() {
    let root = temp_root("sync-rollback");
    let (store, ops) = open(&root);
    let first = ok(&ops, "s", "first", "append_entities", objects(Value::Array(vec![message("a", 1, "keep")])));
    ok(&ops, "s", "second", "append_entities", objects(Value::Array(vec![message("b", 2, "remove")])));
    let page = ok(&ops, "s", "window", "history_sync", with(&[("limit", number(1))]));
    ok(&ops, "s", "rollback", "head_switch", with(&[
        ("objectId", first["objectId"].clone()), ("expectedRevision", head(&ops)["revision"].clone()),
    ]));
    for (name, token) in [
        ("since", page["historyWindow"]["syncCursor"].clone()),
        ("cursor", page["historyWindow"]["olderCursor"].clone()),
    ] {
        assert!(matches!(call(&ops, "s", "stale", "history_sync", with(&[(name, token)])), Err(HistoryError::StaleCursor)));
    }
    let restored = ok(&ops, "s", "restored", "history_sync", temp());
    assert_eq!(restored["messages"].as_array().unwrap().len(), 1);
    assert_eq!(restored["messages"][0]["id"], "a");
    drop(ops);
    drop(store);
    cleanup(root);
}

#[test]
fn checkpoints_survive_head_switch_and_rebuild_the_index() {
    let root = temp_root("checkpoint");
    let (store, ops) = open(&root);
    let first = ok(
        &ops,
        "s",
        "first",
        "append_entities",
        objects(Value::Array(vec![
            message("a", 1, "old"),
            message("b", 2, "last"),
        ])),
    );
    let checkpoint = with(&[
        ("pinId", text("cp")),
        ("objectId", first["objectId"].clone()),
        ("metadata", object(&[("kind", text("input"))])),
    ]);
    let pinned = ok(&ops, "s", "cp", "checkpoint", checkpoint);
    assert_eq!(pinned["pinId"], "cp");
    assert_eq!(pinned["metadata"]["kind"], "input");
    let checkpoints = ok(&ops, "s", "list-cp", "list_checkpoints", temp());
    assert_eq!(checkpoints["items"][0]["id"], "cp");
    let newer = ok(
        &ops,
        "s",
        "newer",
        "append_entities",
        objects(Value::Array(vec![message("c", 3, &format!("v{}", 3))])),
    );
    assert_eq!(newer["revision"], 2);
    ok(
        &ops,
        "s",
        "remove",
        "append_entities",
        objects(Value::Array(vec![tombstone("c")])),
    );
    assert_eq!(list(&ops, "before", temp())["items"].as_array().unwrap().len(), 2);
    // Rollback: the head moves to the checkpoint root and the index is rebuilt.
    let rollback = with(&[
        ("objectId", first["objectId"].clone()),
        ("expectedRevision", number(3)),
    ]);
    let rolled = ok(&ops, "s", "rollback", "head_switch", rollback.clone());
    assert_eq!(rolled["revision"], 4);
    let messages = list(&ops, "after", temp());
    assert_eq!(messages["items"].as_array().unwrap().len(), 2);
    assert_eq!(messages["items"][0]["id"], "a");
    // The rollback receipt replays; a fresh request with a stale fence does not.
    assert_eq!(
        ok(&ops, "s", "rollback", "head_switch", rollback.clone()),
        rolled
    );
    assert!(matches!(
        call(&ops, "s", "rollback-2", "head_switch", rollback),
        Err(HistoryError::RevisionConflict {
            expected: 3,
            actual: 4
        })
    ));
    // Cold open: head and index are rebuilt from the file.
    drop(ops);
    drop(store);
    let (store, reopened) = open(&root);
    assert_eq!(head(&reopened)["revision"], 4);
    assert_eq!(
        list(&reopened, "after", temp())["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    ok(&reopened, "s", "rebuild", "rebuild_index", temp());
    assert_eq!(
        list(&reopened, "after2", temp())["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    ok(
        &reopened,
        "s",
        "pin",
        "pin",
        with(&[
            ("pinId", text("p2")),
            ("objectId", first["objectId"].clone()),
        ]),
    );
    assert_eq!(ok(&reopened, "s", "verify", "verify", temp())["ok"], true);
    drop(store);
    cleanup(root);
}

#[test]
fn object_value_chunk_respects_utf8_boundaries() {
    let root = temp_root("chunk");
    let (store, ops) = open(&root);
    let large = "中文🙂".repeat(40_000);
    ok(
        &ops,
        "s",
        "append",
        "append_entities",
        objects(Value::Array(vec![message("big", 1, &large)])),
    );
    let sync = ok(&ops, "s", "sync", "history_sync", temp());
    let object_id = sync["messages"][0]["$historyObject"]
        .as_str()
        .unwrap_or_else(|| panic!("large value was not externalized: {}", sync["messages"][0]))
        .to_owned();
    let expected = serde_json::to_string(&message("big", 1, &large)["value"]).unwrap();
    // Node validates this UTF-8 byte length before fetching the chunks.
    assert_eq!(sync["messages"][0]["bytes"], number(expected.len() as u64));
    let mut text_value = String::new();
    let mut offset = 0u64;
    loop {
        let chunk = ok(
            &ops,
            "s",
            &format!("chunk-{offset}"),
            "object_value_chunk",
            with(&[
                ("objectId", text(&object_id)),
                ("offset", number(offset)),
            ]),
        );
        let part = chunk["text"].as_str().unwrap();
        assert!(!part.is_empty());
        assert!(part.len() <= 64 * 1024);
        text_value.push_str(part);
        match chunk["next"].as_u64() {
            Some(next) => {
                assert_eq!(next as usize, text_value.len());
                offset = next;
            }
            None => break,
        }
    }
    assert_eq!(text_value, expected);
    // Offsets must be in bounds.
    let out_of_bounds = with(&[
        ("objectId", text(&object_id)),
        ("offset", number(expected.len() as u64 + 1)),
    ]);
    assert!(matches!(
        call(&ops, "s", "oob", "object_value_chunk", out_of_bounds),
        Err(HistoryError::InvalidCommand(_))
    ));
    drop(store);
    cleanup(root);
}

#[test]
fn unknown_operations_and_blobs_are_fenced() {
    let root = temp_root("blob");
    let (store, ops) = open(&root);
    assert!(matches!(
        call(&ops, "s", "unknown", "no_such_operation", temp()),
        Err(HistoryError::InvalidCommand(_))
    ));
    assert_eq!(
        ok(&ops, "s", "reconcile", "reconcile_stream", temp())["reconciled"],
        0
    );
    assert_eq!(
        ok(
            &ops,
            "s",
            "ack",
            "ack_history_outbox",
            with(&[("through", number(7))])
        )["ackedThrough"],
        7
    );
    let chunk = |index: u64, bytes: &str| {
        with(&[
            ("blobId", text("b")),
            ("total", number(2)),
            ("index", number(index)),
            ("bytesHex", text(bytes)),
        ])
    };
    ok(&ops, "s", "c0", "put_blob_chunk", chunk(0, "68656c6c6f20"));
    ok(&ops, "s", "c1", "put_blob_chunk", chunk(1, "776f726c64"));
    // A reused (blob, index) with different bytes is a conflict.
    assert!(matches!(
        call(&ops, "s", "c0", "put_blob_chunk", chunk(0, "00")),
        Err(HistoryError::RequestConflict)
    ));
    let manifest = ok(
        &ops,
        "s",
        "m",
        "put_blob_manifest",
        with(&[
            ("blobId", text("b")),
            ("total", number(2)),
            ("size", number(11)),
        ]),
    );
    assert_eq!(
        manifest["sha256"],
        crate::storage::jsonl::layout::sha256_hex(b"hello world")
    );
    let fetched = ok(
        &ops,
        "s",
        "get",
        "get_blob_chunk",
        with(&[("blobId", text("b")), ("index", number(1))]),
    );
    assert_eq!(fetched["bytesHex"], "776f726c64");
    assert_eq!(fetched["total"], 2);
    assert!(matches!(
        call(
            &ops,
            "s",
            "missing",
            "get_blob_manifest",
            with(&[("blobId", text("none"))])
        ),
        Err(HistoryError::ObjectMissing(_))
    ));
    drop(store);
    cleanup(root);
}

#[test]
fn legacy_transcript_is_read_only_and_overlay_keeps_all_entities() {
    let root = temp_root("legacy-overlay");
    let (store, ops) = open(&root);
    ok(&ops, "s", "first", "append_entities", objects(Value::Array(vec![message("old", 1, "old content")])));
    drop(ops); drop(store);
    let dir = crate::storage::jsonl::layout::session_dir(&root, "s").unwrap().join("history");
    let legacy = dir.join("history.000000");
    std::fs::rename(dir.join(super::HISTORY_FILE), &legacy).unwrap();
    let original = std::fs::read(&legacy).unwrap();
    let (store, ops) = open(&root);
    ok(&ops, "s", "second", "append_entities", objects(Value::Array(vec![message("new", 2, "new content")])));
    assert_eq!(std::fs::read(&legacy).unwrap(), original);
    drop(ops); drop(store);
    let (_store, ops) = open(&root);
    let page = list(&ops, "read", temp());
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    assert_eq!(std::fs::read(&legacy).unwrap(), original);
    cleanup(root);
}

#[test]
fn delayed_observation_cannot_overwrite_a_newer_authoritative_entity() {
    let root = temp_root("observed-entity");
    let (_store, ops) = open(&root);
    ok(&ops, "s", "owner", "append_entities", objects(Value::Array(vec![message("m", 1, "complete")])));
    let mut observation = objects(Value::Array(vec![message("m", 1, "partial"), message("missing", 2, "preserved")]));
    observation["ifAbsent"] = Value::Bool(true);
    ok(&ops, "s", "observer", "append_entities", observation);
    let page = list(&ops, "read", temp());
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().any(|item| item["id"] == "m" && item["content"] == "complete"));
    assert!(items.iter().any(|item| item["id"] == "missing" && item["content"] == "preserved"));
    cleanup(root);
}
