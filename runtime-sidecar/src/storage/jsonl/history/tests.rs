//! History engine end-to-end tests through the command façade.

use std::sync::Arc;

use serde_json::Value;

use super::HistoryOps;
use super::json::{boolean, number, object, text};
use super::wire::HistoryError;
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
fn full_fork_needs_no_message_checkpoint_and_purge_cannot_resurrect_source() {
    use crate::storage::jsonl::hot::HotOps;
    let root = temp_root("session-actions");
    let (store, ops) = open(&root);
    let hot = HotOps::new(store.clone());
    hot.ui_snapshot("s", Some(br#"{"id":"s","projectId":"p","status":"completed","updatedAt":"2026-10-25T00:00:00Z"}"#)).unwrap();
    let retained = hot.handle("s").unwrap();
    ok(&ops, "s", "messages", "append_entities", objects(serde_json::json!([
        message("first", 1, "Original input"), message("last", 2, "Complete reply")
    ])));
    let payload = serde_json::json!({"sourceSessionId":"s","fullHistory":true,"allowSourceChanges":true});
    let fork = ok(&ops, "copy", "fork", "fork_copy", payload.clone());
    assert_eq!(ok(&ops, "copy", "fork", "fork_copy", payload.clone()), fork);
    let messages = ok(&ops, "copy", "messages", "list_messages", temp());
    assert_eq!(messages["items"].as_array().unwrap().len(), 2);
    assert_eq!(messages["items"][1]["content"], "Complete reply");
    assert_ne!(messages["items"][0]["id"], "first");
    let source_dir = super::layout::session_dir(&root, "s").unwrap();
    assert_eq!(ok(&ops, "s", "purge", "session_purge", temp())["deleted"], true);
    assert!(!source_dir.exists());
    assert!(store.session_summary("s").is_err());
    assert!(store.list().read().get("s").is_none());
    assert!(call(&ops, "s", "late", "append_entities", objects(serde_json::json!([message("late", 3, "Late write")]))).is_err());
    assert!(retained.seed(br#"{"id":"s","title":"Resurrect"}"#).is_err());
    drop(retained);
    hot.flush().unwrap();
    assert!(!source_dir.exists());
    assert_eq!(ok(&ops, "s", "retry", "session_purge", temp())["deleted"], true);
    assert_eq!(ok(&ops, "copy", "after-delete", "list_messages", temp()), messages);
    drop(hot); drop(ops); drop(store);
    let (store, ops) = open(&root);
    assert!(store.session("s").is_err());
    assert_eq!(ok(&ops, "copy", "reopened", "list_messages", temp()), messages);
    assert!(!source_dir.exists());
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn full_fork_copies_empty_and_compacted_conversations() {
    let root = temp_root("full-fork-without-pin");
    let (store, ops) = open(&root);
    ok(&ops, "empty", "fork", "fork_copy", serde_json::json!({"sourceSessionId":"s","fullHistory":true,"allowSourceChanges":true}));
    assert!(ok(&ops, "empty", "messages", "list_messages", temp())["items"].as_array().unwrap().is_empty());
    let active = begin_context(&ops);
    let checkpoint = checkpoint_candidate(&active);
    ok(&ops, "s", "commit-context", "context_commit", serde_json::json!({"checkpoint":checkpoint}));
    ok(&ops, "compacted", "fork", "fork_copy", serde_json::json!({"sourceSessionId":"s","fullHistory":true,"allowSourceChanges":true}));
    assert_eq!(ok(&ops, "compacted", "messages", "list_messages", temp())["items"][0]["content"], "Historical evidence");
    assert_eq!(ok(&ops, "compacted", "context", "context_current", temp())["checkpoint"]["sessionId"], "compacted");
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn session_purge_retry_after_a_durable_marker_never_recreates_history_on_drop() {
    let root = temp_root("purge-retry");
    let (store, ops) = open(&root);
    ok(&ops, "s", "messages", "append_entities", objects(serde_json::json!([message("m", 1, "Erase this")])));
    let marker = super::layout::deletion_marker(&root, "s");
    std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
    std::fs::write(marker, b"").unwrap();
    ok(&ops, "s", "resume-purge", "session_purge", temp());
    drop(ops); drop(store);
    assert!(!super::layout::session_dir(&root, "s").unwrap().exists());
    std::fs::remove_dir_all(root).unwrap();
}

fn begin_context(ops: &HistoryOps) -> Value {
    let head = ok(ops, "s", "context-seed", "append_entities", objects(serde_json::json!([
        message("old-message", 1, "Historical evidence"),
        {"kind":"runtime.step","value":{"id":"old-step","sessionId":"s","runId":"old-run",
            "index":1,"status":"completed","startedAt":"2026-10-23T00:00:00Z"}}
    ])));
    ok(ops, "s", "context-begin", "context_begin", serde_json::json!({
        "runId":"compact-run","stepId":"compact-step","throughStepId":"old-step","expectedRevision":head["revision"]
    }))
}

fn checkpoint_candidate(active: &Value) -> Value {
    serde_json::json!({"version":1,"id":"checkpoint-1","sessionId":"s","compactionRunId":active["runId"],
        "throughRevision":active["throughRevision"],"throughStepId":active["throughStepId"],
        "summary":{"goal":["Investigate"],"constraints":[],"decisions":[],"completedWork":[],
            "evidence":[],"failures":[],"openQuestions":[],"nextActions":["Continue"]},
        "sourceRefs":[],"sourceFingerprint":active["sourceFingerprint"],"createdAt":"2026-10-23T01:00:00Z"})
}

#[test]
fn complete_fork_copies_later_history_and_relationships_once_and_survives_source_deletion() {
    let root = temp_root("complete-fork");
    let (store, ops) = open(&root);
    let head = ok(&ops, "s", "first", "append_entities", objects(serde_json::json!([
        message("m-first", 1, "original message"),
        {"kind":"runtime.run","value":{"id":"run-1","sessionId":"s","status":"completed"}},
        {"kind":"runtime.work","value":{"id":"work-1","sessionId":"s","objective":"unchanged"}}
    ])));
    ok(&ops, "s", "pin", "checkpoint", serde_json::json!({"objectId":head["objectId"],"pinId":"selected",
        "metadata":{"kind":"reply","messageId":"m-first"}}));
    let head = ok(&ops, "s", "later", "append_entities", objects(serde_json::json!([
        message("m-later", 2, "Keep this later history too"),
        {"kind":"runtime.step","value":{"id":"step-1","sessionId":"s","runId":"run-1","status":"completed","index":1}},
        {"kind":"runtime.part","value":{"id":"part-1","sessionId":"s","runId":"run-1","stepId":"step-1","content":"Evidence"}},
        {"kind":"runtime.run","value":{"id":"running","sessionId":"s","status":"running","metadata":{"executionLease":{},"rustLoopId":"live"}}},
        {"kind":"runtime.plan","value":{"id":"plan-1","sessionId":"s","revision":1,"title":"Original plan"}}
    ])));
    let payload = serde_json::json!({"sourceSessionId":"s","checkpointId":"selected","expectedRevision":head["revision"],
        "sessionMetadata":{"activeWorkId":"work-1","planId":"plan-1"}});
    let forked = ok(&ops, "copy", "copy-request", "fork_copy", payload.clone());
    assert_eq!(forked["sourceRevision"], head["revision"]);
    assert_eq!(ok(&ops, "copy", "copy-request", "fork_copy", payload.clone()), forked);
    let messages = ok(&ops, "copy", "messages", "list_messages", temp());
    assert_eq!(messages["items"].as_array().unwrap().len(), 2);
    assert_eq!(messages["items"][1]["content"], "Keep this later history too");
    assert_eq!(messages["items"][0]["sessionId"], "copy");
    assert_ne!(messages["items"][0]["id"], "m-first");
    let step = ok(&ops, "copy", "steps", "list_steps", temp())["items"][0].clone();
    let part = ok(&ops, "copy", "parts", "list_parts", temp())["items"][0].clone();
    assert_eq!(part["stepId"], step["id"]);
    assert_eq!(part["runId"], step["runId"]);
    let work = ok(&ops, "copy", "work", "list_work", temp())["items"][0].clone();
    assert_eq!(forked["sessionMetadata"]["activeWorkId"], work["id"]);
    let runs = ok(&ops, "copy", "runs", "list_runs", temp());
    assert!(runs["items"].as_array().unwrap().iter().all(|run| run["status"] != "running" && run["metadata"]["rustLoopId"].is_null()));
    assert_eq!(ok(&ops, "s", "head", "head_read", temp()), head);
    drop(ops); drop(store);
    std::fs::remove_dir_all(super::layout::session_dir(&root, "s").unwrap()).unwrap();
    let (store, ops) = open(&root);
    assert_eq!(ok(&ops, "copy", "copy-request", "fork_copy", payload), forked);
    assert_eq!(ok(&ops, "copy", "messages", "list_messages", temp()), messages);
    assert_eq!(ok(&ops, "copy", "verify", "verify", temp())["ok"], true);
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_fork_never_publishes_history_and_cold_open_cleans_abandoned_staging() {
    let root = temp_root("fork-failure");
    let (store, ops) = open(&root);
    let head = ok(&ops, "s", "seed", "append_entities", objects(serde_json::json!([message("message", 1, "Source remains intact")])));
    ok(&ops, "s", "pin", "checkpoint", serde_json::json!({"objectId":head["objectId"],"pinId":"entry","metadata":{"messageId":"message"}}));
    let payload = serde_json::json!({"sourceSessionId":"s","checkpointId":"entry","allowSourceChanges":true,"testFailBeforePublish":true});
    assert!(call(&ops, "copy", "copy", "fork_copy", payload.clone()).unwrap_err().to_string().contains("injected publish failure"));
    assert_eq!(ok(&ops,"copy","head","head_read",temp())["revision"],0);
    assert!(ok(&ops,"copy","status","fork_status",serde_json::json!({"requestId":"copy"}))["result"].is_null());
    let directory = super::history_path(&root,"copy").unwrap();
    assert!(std::fs::read_dir(&directory).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().starts_with(".fork-")));
    drop(ops); drop(store);
    std::fs::create_dir_all(directory.join(".fork-crashed")).unwrap();
    std::fs::write(directory.join(".fork-crashed/partial"),b"not committed").unwrap();
    let (store,ops)=open(&root);
    let mut retry=payload;retry["testFailBeforePublish"]=serde_json::json!(false);
    ok(&ops,"copy","copy","fork_copy",retry);
    assert!(!directory.join(".fork-crashed").exists());
    assert_eq!(ok(&ops,"s","messages","list_messages",temp())["items"][0]["content"],"Source remains intact");
    assert_eq!(ok(&ops,"copy","messages","list_messages",temp())["items"][0]["content"],"Source remains intact");
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn complete_fork_preserves_checkpoint_seals_and_original_source_references() {
    let root = temp_root("fork-checkpoint");
    let (store, ops) = open(&root);
    let active = begin_context(&ops);
    let source = ok(&ops, "s", "read-source", "context_read", serde_json::json!({"kind":"message","id":"old-message"}));
    let mut checkpoint = checkpoint_candidate(&active);
    checkpoint["sourceRefs"] = serde_json::json!([source["objectId"]]);
    ok(&ops, "s", "commit", "context_commit", serde_json::json!({"checkpoint":checkpoint}));
    let head = ok(&ops, "s", "new-message", "append_entities", objects(serde_json::json!([message("new-message", 3, "New input")])));
    ok(&ops, "s", "pin-new", "checkpoint", serde_json::json!({"objectId":head["objectId"],"pinId":"new-boundary",
        "metadata":{"kind":"reply","messageId":"new-message"}}));
    ok(&ops, "copy", "fork", "fork_copy", serde_json::json!({"sourceSessionId":"s","checkpointId":"new-boundary","allowSourceChanges":true}));
    let current = ok(&ops, "copy", "current", "context_current", temp());
    assert_eq!(current["checkpoint"]["sessionId"], "copy");
    assert_eq!(current["checkpoint"]["throughRevision"], checkpoint["throughRevision"]);
    assert_ne!(current["checkpoint"]["id"], checkpoint["id"]);
    assert!(ok(&ops, "copy", "read-checkpoint", "context_read", serde_json::json!({"kind":"checkpoint","id":current["checkpoint"]["id"]}))["text"].as_str().unwrap().contains("throughRevision"));
    let original_ref = ok(&ops, "copy", "read-original-ref", "context_read", serde_json::json!({"kind":"object","id":source["objectId"]}));
    assert_eq!(original_ref["text"], "Historical evidence");
    let items = ok(&ops, "copy", "messages", "list_messages", temp());
    let mut old = items["items"].as_array().unwrap().iter().find(|v| v["content"] == "Historical evidence").unwrap().clone();
    old["content"] = serde_json::json!("attempted mutation");
    assert!(matches!(call(&ops, "copy", "edit-sealed", "append_entities", objects(serde_json::json!([{"kind":"runtime.message","value":old}]))), Err(HistoryError::ReadOnlyHistory)));
    let pins = ok(&ops, "copy", "pins", "list_checkpoints", temp());
    ok(&ops, "copy2", "fork-again", "fork_copy", serde_json::json!({"sourceSessionId":"copy","checkpointId":pins["items"][0]["id"],"allowSourceChanges":true}));
    assert_eq!(ok(&ops, "copy2", "original-ref", "context_read", serde_json::json!({"kind":"object","id":source["objectId"]}))["text"], "Historical evidence");
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn archived_step_text_pages_by_identity_without_private_parts_and_survives_reopen() {
    let root = temp_root("step-text");
    let (store, ops) = open(&root);
    ok(&ops, "s", "parts", "append_entities", objects(serde_json::json!([
        {"kind":"runtime.step","value":{"id":"step","sessionId":"s","status":"completed"}},
        {"kind":"runtime.part","value":{"id":"z","stepId":"step","sessionId":"s","kind":"text","sequence":1,"content":"第一条证据"}},
        {"kind":"runtime.part","value":{"id":"a","stepId":"step","sessionId":"s","kind":"text","sequence":3,"content":"Second evidence"}},
        {"kind":"runtime.part","value":{"id":"private","stepId":"step","sessionId":"s","kind":"thought","sequence":2,"content":"private reasoning"}}
    ])));
    drop(ops); drop(store);
    let (store, ops) = open(&root);
    let first = ok(&ops, "s", "one", "context_read", serde_json::json!({"kind":"step","id":"step","limit":12000}));
    assert_eq!(first["text"], "第一条证据"); assert_eq!(first["nextPartId"], "a"); assert_eq!(first["nextOffset"], 0);
    let second = ok(&ops, "s", "two", "context_read", serde_json::json!({"kind":"step","id":"step","partId":first["nextPartId"],"offset":first["nextOffset"]}));
    assert_eq!(second["text"], "Second evidence"); assert_eq!(second["hasMore"], false);
    assert!(call(&ops, "s", "private", "context_read", serde_json::json!({"kind":"step","id":"step","partId":"private"})).is_err());
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn copying_asset_bindings_keeps_target_readable_after_source_unbinds() {
    let root = temp_root("fork-assets");
    let (store, ops) = open(&root);
    ok(&ops, "assets", "put", "asset_put", serde_json::json!({"asset":{"id":"asset-one","projectId":"p",
        "filename":"image.png","mediaType":"image/png","size":3,"sha256":"a".repeat(64),"createdAt":"now"}}));
    ok(&ops, "assets", "bind", "asset_bind", serde_json::json!({"sessionId":"s","assetId":"asset-one"}));
    let input = serde_json::json!({"sourceSessionId":"s","targetSessionId":"copy"});
    assert_eq!(ok(&ops, "assets", "copy", "asset_copy_bindings", input.clone())["copied"], 1);
    assert_eq!(ok(&ops, "assets", "copy", "asset_copy_bindings", input)["copied"], 1);
    ok(&ops, "assets", "unbind", "asset_unbind", serde_json::json!({"sessionId":"s","assetId":"asset-one"}));
    assert_eq!(ok(&ops, "assets", "target", "asset_has_binding", serde_json::json!({"sessionId":"copy","assetId":"asset-one"}))["bound"], true);
    assert!(call(&ops, "assets", "delete", "asset_delete", serde_json::json!({"assetId":"asset-one"})).is_err());
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn checkpoint_boundary_excludes_the_next_running_step_and_new_input() {
    let root = temp_root("context-safe-boundary");
    let (store, ops) = open(&root);
    let seed = ok(&ops, "s", "seed", "append_entities", objects(serde_json::json!([
        message("old", 1, "old evidence"),
        {"kind":"runtime.step","value":{"id":"old-step","sessionId":"s","runId":"run","status":"completed","index":1}}
    ])));
    let mut new_input = message("new-input", 2, "new requirement");
    new_input["value"]["role"] = serde_json::json!("user");
    let next = ok(&ops, "s", "next", "append_entities", objects(serde_json::json!([
        new_input,
        {"kind":"runtime.step","value":{"id":"next-step","sessionId":"s","runId":"run","status":"running","index":2}}
    ])));
    let active = ok(&ops, "s", "begin", "context_begin", serde_json::json!({
        "runId":"compact-run","stepId":"compact-step","throughStepId":"old-step","expectedRevision":next["revision"]}));
    assert_eq!(active["throughRevision"], seed["revision"]);
    ok(&ops, "s", "commit", "context_commit", serde_json::json!({"checkpoint":checkpoint_candidate(&active)}));
    ok(&ops, "s", "complete-next", "append_entities", objects(serde_json::json!([
        {"kind":"runtime.step","value":{"id":"next-step","sessionId":"s","runId":"run","status":"completed","index":2}}
    ])));
    let head = ok(&ops, "s", "current", "context_current", temp());
    let tail = ok(&ops, "s", "tail", "context_prompt", serde_json::json!({"fromRevision":seed["revision"],
        "throughRevision":head["revision"],"generation":head["generation"],"tokenBudget":2000}));
    assert_eq!(tail["items"].as_array().unwrap().len(), 1);
    assert_eq!(tail["items"][0]["id"], "new-input");
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn revoking_manual_owner_fences_late_commit_and_recovery_clears_running_state() {
    use crate::storage::jsonl::hot::HotOps;
    let root = temp_root("context-owner");
    let (store, ops) = open(&root);
    let hot = HotOps::new(store.clone());
    hot.ui_snapshot("s", Some(&serde_json::to_vec(&serde_json::json!({"id":"s","projectId":"p","status":"completed","updatedAt":"2026-10-23T00:00:00Z"})).unwrap())).unwrap();
    let head = ok(&ops, "s", "seed", "append_entities", objects(serde_json::json!([
        {"kind":"runtime.step","value":{"id":"old-step","sessionId":"s","runId":"run","status":"completed","index":1}}
    ])));
    let fence = hot.snapshot("s").unwrap();
    hot.control("s", "lock", fence.epoch, fence.revision, "compaction_lock", br#"{"ownerId":"owner","hostId":"host"}"#).unwrap();
    let active = ok(&ops, "s", "begin", "context_begin", serde_json::json!({
        "runId":"compact-run","stepId":"compact-step","throughStepId":"old-step","expectedRevision":head["revision"],"ownerId":"owner"}));
    let fence = hot.snapshot("s").unwrap();
    hot.control("s", "permission-change", fence.epoch, fence.revision, "session_patch", br#"{"patch":{"permissionRules":[{"gate":"write","action":"deny","pattern":"*"}]}}"#).unwrap();
    assert!(call(&ops, "s", "changed-config", "context_commit", serde_json::json!({"checkpoint":checkpoint_candidate(&active),"ownerId":"owner"}))
        .unwrap_err().to_string().contains("COMPACTION_CONFIGURATION_CHANGED"));
    let fence = hot.snapshot("s").unwrap();
    hot.control("s", "unlock", fence.epoch, fence.revision, "compaction_unlock", br#"{"ownerId":"owner"}"#).unwrap();
    assert!(call(&ops, "s", "late", "context_commit", serde_json::json!({"checkpoint":checkpoint_candidate(&active),"ownerId":"owner"}))
        .unwrap_err().to_string().contains("COMPACTION_OWNER_SUPERSEDED"));
    let recovered = ok(&ops, "s", "recover", "context_recover", temp());
    assert_eq!(recovered["active"]["status"], "failed");
    assert!(recovered["checkpoint"].is_null());
    drop(hot); drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn superseded_running_compaction_is_terminalized_before_ui_refresh() {
    let root = temp_root("context-superseded");
    let (store, ops) = open(&root);
    let seed = ok(&ops, "s", "seed", "append_entities", objects(serde_json::json!([
        {"kind":"runtime.step","value":{"id":"old-step","sessionId":"s","runId":"run","status":"completed","index":1}}
    ])));
    let active = ok(&ops, "s", "begin", "context_begin", serde_json::json!({
        "runId":"compact-run","stepId":"compact-step","throughStepId":"old-step","expectedRevision":seed["revision"]
    }));
    // A newer completed step makes the captured compaction boundary stale.
    ok(&ops, "s", "advance", "append_entities", objects(serde_json::json!([
        {"kind":"runtime.step","value":{"id":"new-step","sessionId":"s","runId":"run","status":"completed","index":2}}
    ])));
    let current = ok(&ops, "s", "current", "context_current", temp());
    assert_eq!(current["active"]["runId"], active["runId"]);
    assert_eq!(current["active"]["status"], "failed");
    assert!(current["active"]["error"].as_str().unwrap().contains("superseded"));
    let recovered = ok(&ops, "s", "recover", "context_recover", temp());
    assert_eq!(recovered["active"]["status"], "failed");
    let runs = ok(&ops, "s", "runs", "list_runs", temp());
    assert_eq!(runs["items"][0]["status"], "interrupted");
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn corrupt_latest_checkpoint_uses_previous_summary_without_lowering_readonly_boundary() {
    let root = temp_root("checkpoint-fallback");
    let (store, ops) = open(&root);
    let first = begin_context(&ops);
    ok(&ops,"s","commit-one","context_commit",serde_json::json!({"checkpoint":checkpoint_candidate(&first)}));
    let head = ok(&ops,"s","next","append_entities",objects(serde_json::json!([
        message("second-msg",2,"Must remain read-only"),
        {"kind":"runtime.step","value":{"id":"second-step","sessionId":"s","runId":"r","status":"completed","index":2}}
    ])));
    let second = ok(&ops,"s","begin-two","context_begin",serde_json::json!({"runId":"compact-two","stepId":"compact-step-two","throughStepId":"second-step","expectedRevision":head["revision"]}));
    let mut candidate = checkpoint_candidate(&second);candidate["id"]=serde_json::json!("checkpoint-2");
    ok(&ops,"s","commit-two","context_commit",serde_json::json!({"checkpoint":candidate}));
    let current = ok(&ops,"s","current","context_current",temp());
    let corrupt = ok(&ops,"s","object","get_object",serde_json::json!({"objectId":current["checkpointObjectId"]}));
    let mut corrupt: super::HistoryObject = serde_json::from_value(corrupt).unwrap();
    corrupt.value["summary"]=serde_json::json!({"invalid":"corrupt"});
    drop(ops);drop(store);
    let directory=super::history_path(&root,"s").unwrap();
    let mut file=crate::storage::jsonl::file::AppendFile::open(&directory.join(super::HISTORY_FILE)).unwrap();
    file.append(&crate::storage::jsonl::record::Record::HistoryObject(corrupt).encode()).unwrap();
    file.append(&crate::storage::jsonl::record::Record::HistorySeal{c:100}.encode()).unwrap();file.sync().unwrap();drop(file);
    let (store,ops)=open(&root);
    let recovered=ok(&ops,"s","current","context_current",temp());
    assert_eq!(recovered["checkpoint"]["id"],"checkpoint-1");
    assert_eq!(recovered["sealedThroughRevision"],current["sealedThroughRevision"]);
    assert!(matches!(call(&ops,"s","write-old","append_entities",objects(serde_json::json!([message("second-msg",2,"Rewrite")] ))),Err(HistoryError::ReadOnlyHistory)));
    drop(ops);drop(store);std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn archived_tool_messages_are_read_by_exact_reference_without_execution() {
    let root = temp_root("context-read-tool");
    let (store, ops) = open(&root);
    let mut tool = message("tool-msg", 1, "原始工具结果 🦀 preserved");
    tool["value"]["role"] = serde_json::json!("tool");
    ok(&ops, "s", "seed", "append_entities", objects(serde_json::json!([tool])));
    let first = ok(&ops, "s", "read", "context_read", serde_json::json!({"kind":"message","id":"tool-msg","limit":8}));
    let mut text = first["text"].as_str().unwrap().to_owned();
    let next = ok(&ops, "s", "read", "context_read", serde_json::json!({"kind":"object","id":first["objectId"],"offset":first["nextOffset"]}));
    text.push_str(next["text"].as_str().unwrap());
    assert_eq!(text, "原始工具结果 🦀 preserved");
    assert_eq!(next["historical"], true);
    assert!(call(&ops, "other-session", "read", "context_read", serde_json::json!({"kind":"object","id":first["objectId"]})).is_err());
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn summary_source_omits_native_tool_media_bytes_but_preserves_text_evidence() {
    let root = temp_root("context-media-source");
    let (store, ops) = open(&root);
    let output = serde_json::json!({"type":"content","value":[{"type":"text","text":"Inspect evidence in this diagram"},
        {"type":"image","data":"DO_NOT_SUMMARIZE_BASE64"}]});
    let mut record = message("media-tool", 1, &output.to_string());
    record["value"]["role"] = serde_json::json!("tool");
    record["value"]["metadata"] = serde_json::json!({"rustMessage":{"role":"tool","content":[{"type":"tool-result","toolCallId":"c","output":output}]}});
    let head = ok(&ops, "s", "seed", "append_entities", objects(serde_json::json!([record])));
    let state = ok(&ops, "s", "current", "context_current", temp());
    let page = ok(&ops, "s", "page", "context_messages", serde_json::json!({"fromRevision":0,
        "throughRevision":head["revision"],"generation":state["generation"]}));
    assert_eq!(page["items"][0]["text"], "Inspect evidence in this diagram");
    assert_eq!(page["items"][0]["hasAttachments"], true);
    assert!(!page.to_string().contains("DO_NOT_SUMMARIZE_BASE64"));
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn context_checkpoint_run_and_boundary_commit_once_and_survive_reopen() {
    let root = temp_root("context-commit");
    let (store, ops) = open(&root);
    let active = begin_context(&ops);
    let current = ok(&ops, "s", "read", "context_current", temp());
    assert!(current["checkpoint"].is_null());
    assert_eq!(current["active"]["status"], "running");
    let input = serde_json::json!({"checkpoint":checkpoint_candidate(&active)});
    let done = ok(&ops, "s", "context-commit", "context_commit", input.clone());
    assert_eq!(done["status"], "completed");
    assert_eq!(ok(&ops, "s", "context-commit", "context_commit", input), done);
    let current = ok(&ops, "s", "read", "context_current", temp());
    assert_eq!(current["checkpoint"]["throughRevision"], active["throughRevision"]);
    let runs = ok(&ops, "s", "runs", "list_runs", temp());
    assert_eq!(runs["items"][0]["metadata"]["kind"], "context-compaction");
    assert_eq!(runs["items"][0]["status"], "completed");
    let messages = ok(&ops, "s", "messages", "list_messages", temp());
    assert_eq!(messages["items"].as_array().unwrap().len(), 2);
    assert_eq!(messages["items"][0]["content"], "Historical evidence");
    assert_eq!(messages["items"][1]["content"], "上下文已压缩");
    drop(ops); drop(store);
    let (store, ops) = open(&root);
    assert_eq!(ok(&ops, "s", "read", "context_current", temp()), current);
    drop(ops); drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_context_references_are_dropped_and_checkpoint_publishes() {
    let root = temp_root("context-cancel");
    let (store, ops) = open(&root);
    let active = begin_context(&ops);
    let mut candidate = checkpoint_candidate(&active);
    candidate["sourceRefs"] = serde_json::json!(["sha256:missing"]);
    let before = ok(&ops, "s", "head", "head_read", temp());
    let done = ok(&ops, "s", "bad-commit", "context_commit", serde_json::json!({"checkpoint":candidate}));
    assert_eq!(done["status"], "completed");
    let current = ok(&ops, "s", "head", "context_current", temp());
    assert!(current["checkpoint"]["sourceRefs"].as_array().unwrap().is_empty());
    assert!(current["revision"].as_u64().unwrap() > before["revision"].as_u64().unwrap());
    drop(ops); drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn context_seal_blocks_old_edits_but_allows_new_history_and_idempotent_replay() {
    let root = temp_root("context-readonly");
    let (store, ops) = open(&root);
    let active = begin_context(&ops);
    ok(&ops, "s", "commit", "context_commit", serde_json::json!({"checkpoint":checkpoint_candidate(&active)}));
    let same = objects(serde_json::json!([message("old-message", 1, "Historical evidence")]));
    ok(&ops, "s", "same", "append_entities", same);
    let changed = objects(serde_json::json!([message("old-message", 1, "Rewritten")]));
    assert!(matches!(call(&ops, "s", "write-old", "append_entities", changed), Err(HistoryError::ReadOnlyHistory)));
    assert!(matches!(call(&ops, "s", "raw-old", "put_object", message("old-message", 1, "Bypass")), Err(HistoryError::ReadOnlyHistory)));
    let mut new_message = message("new-message", 2, "new input");
    new_message["value"]["role"] = serde_json::json!("user");
    let head = ok(&ops, "s", "new", "append_entities", objects(serde_json::json!([new_message])));
    assert!(matches!(call(&ops, "s", "edit-old", "truncate_message",
        serde_json::json!({"messageId":"old-message","expectedRevision":head["revision"]})), Err(HistoryError::ReadOnlyHistory)));
    // The active checkpoint and its source-prefix reference survive a rollback
    // of a newer input; sealed messages are still visible through that root.
    ok(&ops, "s", "edit-new", "truncate_message",
        serde_json::json!({"messageId":"new-message","expectedRevision":head["revision"],"metadata":{}}));
    let messages = ok(&ops, "s", "messages", "list_messages", temp());
    assert!(messages["items"].as_array().unwrap().iter().any(|v| v["id"] == "old-message"));
    assert!(!messages["items"].as_array().unwrap().iter().any(|v| v["id"] == "new-message"));
    drop(ops); drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn context_pages_read_only_new_revisions_and_slice_large_utf8_text() {
    let root = temp_root("context-pages");
    let (store, ops) = open(&root);
    let old = ok(&ops, "s", "old", "append_entities", objects(serde_json::json!(
        (0..128).map(|n| message(&format!("old-{n}"), n, "old")).collect::<Vec<_>>()
    )));
    let text = "证据 🦀 ".repeat(20_000);
    let new = ok(&ops, "s", "new", "append_entities", objects(serde_json::json!([
        message("large", 129, &text), message("last", 130, "last")
    ])));
    let current = ok(&ops, "s", "current", "context_current", temp());
    let mut cursor = Value::Null;
    let mut recovered = String::new();
    let mut count = 0;
    loop {
        let page = ok(&ops, "s", "page", "context_messages", serde_json::json!({
            "fromRevision":old["revision"],"throughRevision":new["revision"],
            "generation":current["generation"],"cursor":cursor
        }));
        assert!(serde_json::to_vec(&page).unwrap().len() < 60 * 1024);
        for item in page["items"].as_array().unwrap() {
            assert!(!item["id"].as_str().unwrap().starts_with("old-"));
            if item["id"] == "large" { recovered.push_str(item["text"].as_str().unwrap()); }
            if item["id"] == "last" { count += 1; }
        }
        cursor = page["cursor"].clone();
        if cursor.is_null() { break; }
    }
    assert_eq!(recovered, text);
    assert_eq!(count, 1);
    drop(ops); drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn transaction_snapshot_shares_history_and_keeps_old_readers_immutable() {
    let mut index = super::SessionIndex::empty("s");
    for n in 0..4096 {
        let object = Arc::new(super::HistoryObject {
            object_id: format!("object-{n}"), kind: "runtime.message".into(),
            value: message(&format!("m-{n}"), n, "source")["value"].clone(), refs: Vec::new(),
        });
        index.object_inserted(object);
    }
    let mut copy = super::SessionIndex::clone_index(&index);
    assert!(copy.order.ptr_eq(&index.order));
    assert!(copy.identity.ptr_eq(&index.identity));
    assert!(copy.objects.ptr_eq(&index.objects));
    assert!(copy.changes.ptr_eq(&index.changes));
    assert!(copy.aux.ptr_eq(&index.aux));
    assert!(copy.blobs.ptr_eq(&index.blobs));
    assert!(copy.receipts.ptr_eq(&index.receipts));
    copy.object_inserted(Arc::new(super::HistoryObject {
        object_id: "new-object".into(), kind: "runtime.message".into(),
        value: message("new", 4097, "new content")["value"].clone(), refs: Vec::new(),
    }));
    assert_eq!(index.objects.len(), 4096);
    assert_eq!(copy.objects.len(), 4097);
    assert!(Arc::ptr_eq(index.objects.get("object-0").unwrap(), copy.objects.get("object-0").unwrap()));
}

#[test]
fn list_pages_seek_in_both_directions_without_losing_boundaries() {
    let root = temp_root("seek-pages");
    let (_store, ops) = open(&root);
    ok(&ops, "s", "seed-seek", "append_entities", objects(serde_json::json!(
        (0..128).map(|n| message(&format!("m-{n}"), n, "data")).collect::<Vec<_>>()
    )));
    for reverse in [false, true] {
        let mut cursor = Value::Null;
        let mut ids = Vec::new();
        loop {
            let page = ok(&ops, "s", "read-page", "list_messages",
                serde_json::json!({"limit":7,"reverse":reverse,"cursor":cursor}));
            ids.extend(page["items"].as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap().to_owned()));
            cursor = page["cursor"].clone();
            if cursor.is_null() { break; }
        }
        let mut expected: Vec<_> = (0..128).map(|n| format!("m-{n}")).collect();
        if reverse { expected.reverse(); }
        assert_eq!(ids, expected);
    }
    drop(ops); drop(_store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn history_index_snapshot_preserves_cursors_and_replays_only_the_committed_tail() {
    let root = temp_root("index-checkpoint");
    let (store, ops) = open(&root);
    ok(
        &ops,
        "s",
        "first",
        "append_entities",
        objects(serde_json::json!([
            message("a", 1, "a"),
            message("b", 2, "b")
        ])),
    );
    let window = ok(
        &ops,
        "s",
        "window",
        "history_sync",
        serde_json::json!({"limit":1}),
    );
    assert_eq!(window["messages"][0]["id"], "b");
    assert_eq!(ops.evict_idle(), 0);
    assert_eq!(ops.evict_with_policy(0, std::time::Duration::ZERO), 1);
    let directory = super::history_path(&root, "s").unwrap();
    let (snapshot, offset) = super::checkpoint::read(&directory, "s").unwrap();
    assert_eq!(snapshot.head.revision, 1);
    ok(
        &ops,
        "s",
        "second",
        "append_entities",
        objects(serde_json::json!([message("c", 3, "c")])),
    );
    // Replay directly from the persisted position before dropping the writer
    // (normal release will replace the snapshot with the newer index).
    let mut index = snapshot;
    let end = super::replay_into(
        &directory.join(super::HISTORY_FILE),
        &mut index,
        false,
        offset,
    )
    .unwrap();
    assert!(end > offset);
    let delta = super::sync::history_sync(
        &index,
        "s",
        &serde_json::json!({"since":window["historyWindow"]["syncCursor"]}),
    )
    .unwrap();
    assert_eq!(delta["messages"].as_array().unwrap().len(), 1);
    assert_eq!(delta["messages"][0]["id"], "c");
    let older = super::sync::history_sync(
        &index,
        "s",
        &serde_json::json!({"cursor":window["historyWindow"]["olderCursor"]}),
    )
    .unwrap();
    assert_eq!(older["messages"][0]["id"], "a");
    drop(ops);
    drop(store);
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
    let latest = ok(
        &ops,
        "s",
        "append",
        "append_entities",
        objects(serde_json::json!([message("latest", 1, "new content")])),
    );
    ok(
        &ops,
        "copy",
        "fork",
        "fork",
        serde_json::json!({"sourceSessionId":"s"}),
    );
    let copied = ok(&ops, "copy", "head", "head_read", temp());
    assert_eq!(copied["objectId"], latest["objectId"]);
    drop(ops);
    drop(store);
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
    ok(
        &ops,
        "s",
        "append",
        "append_entities",
        objects(Value::Array(items)),
    );
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
    ok(
        &ops,
        "s",
        "append",
        "append_entities",
        objects(Value::Array(vec![
            message("a", 1, "old"),
            message("b", 2, "keep"),
            message("c", 3, "remove"),
        ])),
    );
    let initial = ok(
        &ops,
        "s",
        "initial",
        "history_sync",
        with(&[("limit", number(1))]),
    );
    assert_eq!(initial["messages"][0]["id"], "c");
    let since = initial["historyWindow"]["syncCursor"].clone();
    let older_cursor = initial["historyWindow"]["olderCursor"].clone();
    let unchanged = ok(
        &ops,
        "s",
        "unchanged",
        "history_sync",
        with(&[("since", since.clone())]),
    );
    assert!(unchanged["messages"].as_array().unwrap().is_empty());
    assert_eq!(unchanged["historyWindow"]["hasMoreChanges"], false);

    ok(
        &ops,
        "s",
        "next-turn",
        "append_entities",
        objects(Value::Array(vec![
            message("a", 1, "updated"),
            tombstone("c"),
            message("d", 4, "new reply"),
        ])),
    );
    let first = ok(
        &ops,
        "s",
        "first",
        "history_sync",
        with(&[("limit", number(1)), ("since", since)]),
    );
    assert_eq!(first["messages"][0]["content"], "updated");
    assert_eq!(first["historyWindow"]["hasMoreChanges"], true);
    assert_eq!(
        first["historyWindow"]["generation"],
        initial["historyWindow"]["generation"]
    );

    // Writes during pagination belong to the following refresh, not this page set.
    ok(
        &ops,
        "s",
        "while-paging",
        "append_entities",
        objects(Value::Array(vec![message("e", 5, "later reply")])),
    );
    let second = ok(
        &ops,
        "s",
        "second",
        "history_sync",
        with(&[
            ("limit", number(1)),
            ("since", first["historyWindow"]["syncCursor"].clone()),
        ]),
    );
    assert_eq!(second["removed"][0]["id"], "c");
    assert_eq!(second["historyWindow"]["hasMoreChanges"], true);
    let third = ok(
        &ops,
        "s",
        "third",
        "history_sync",
        with(&[
            ("limit", number(1)),
            ("since", second["historyWindow"]["syncCursor"].clone()),
        ]),
    );
    assert_eq!(third["messages"][0]["id"], "d");
    assert_eq!(third["historyWindow"]["hasMoreChanges"], false);
    assert_eq!(
        third["historyWindow"]["revision"],
        first["historyWindow"]["revision"]
    );
    let later = ok(
        &ops,
        "s",
        "later",
        "history_sync",
        with(&[("since", third["historyWindow"]["syncCursor"].clone())]),
    );
    assert_eq!(later["messages"].as_array().unwrap().len(), 1);
    assert_eq!(later["messages"][0]["id"], "e");

    // Browsing earlier history still uses its own reverse cursor after appends.
    let older = ok(
        &ops,
        "s",
        "older",
        "history_sync",
        with(&[("cursor", older_cursor)]),
    );
    assert_eq!(older["messages"][0]["id"], "b");
    let cursor = later["historyWindow"]["syncCursor"].clone();
    drop(ops);
    drop(store);
    let (store, reopened) = open(&root);
    let unchanged = ok(
        &reopened,
        "s",
        "after-restart",
        "history_sync",
        with(&[("since", cursor.clone())]),
    );
    assert!(unchanged["messages"].as_array().unwrap().is_empty());
    ok(
        &reopened,
        "s",
        "after-restart-append",
        "append_entities",
        objects(Value::Array(vec![message("f", 6, "reopened reply")])),
    );
    let next = ok(
        &reopened,
        "s",
        "after-restart-sync",
        "history_sync",
        with(&[("since", cursor)]),
    );
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
    ok(
        &ops,
        "s",
        "updates",
        "append_entities",
        objects(Value::Array(vec![
            message("a", 1, "old"),
            message("a", 1, "new"),
            message("b", 2, "removed"),
            tombstone("b"),
            message("c", 3, "old"),
            tombstone("c"),
            message("c", 3, "recreated"),
        ])),
    );
    let page = ok(
        &ops,
        "s",
        "sync",
        "history_sync",
        with(&[("since", initial["historyWindow"]["syncCursor"].clone())]),
    );
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
    let run = object(&[
        ("kind", text("runtime.run")),
        (
            "value",
            object(&[
                ("id", text("r")),
                ("sessionId", text("s")),
                ("status", text("completed")),
            ]),
        ),
    ]);
    ok(
        &ops,
        "s",
        "append",
        "append_entities",
        objects(Value::Array(vec![
            message("big-1", 1, &large),
            message("big-2", 2, &large),
            run,
        ])),
    );
    for payload in [
        temp(),
        with(&[("since", initial["historyWindow"]["syncCursor"].clone())]),
    ] {
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
    entities.push(object(&[
        ("kind", text("runtime.run")),
        (
            "value",
            object(&[
                ("id", text("run")),
                ("sessionId", text("s")),
                ("status", text("completed")),
            ]),
        ),
    ]));
    ok(
        &ops,
        "s",
        "append",
        "append_entities",
        objects(Value::Array(entities)),
    );
    let mut cursor = Value::Null;
    let mut ids = std::collections::HashSet::new();
    for page_number in 0..30 {
        let page = ok(
            &ops,
            "s",
            "page",
            "history_sync",
            with(&[("cursor", cursor.clone())]),
        );
        assert!(serde_json::to_vec(&page).unwrap().len() <= 512 * 1024);
        if page_number == 0 {
            assert_eq!(page["runs"][0]["id"], "run");
        }
        for item in page["messages"].as_array().unwrap() {
            assert!(ids.insert(item["id"].as_str().unwrap().to_owned()));
        }
        let next = page["historyWindow"]["olderCursor"].clone();
        if next.is_null() {
            break;
        }
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
    let first = ok(
        &ops,
        "s",
        "first",
        "append_entities",
        objects(Value::Array(vec![message("a", 1, "keep")])),
    );
    ok(
        &ops,
        "s",
        "second",
        "append_entities",
        objects(Value::Array(vec![message("b", 2, "remove")])),
    );
    let page = ok(
        &ops,
        "s",
        "window",
        "history_sync",
        with(&[("limit", number(1))]),
    );
    ok(
        &ops,
        "s",
        "rollback",
        "head_switch",
        with(&[
            ("objectId", first["objectId"].clone()),
            ("expectedRevision", head(&ops)["revision"].clone()),
        ]),
    );
    for (name, token) in [
        ("since", page["historyWindow"]["syncCursor"].clone()),
        ("cursor", page["historyWindow"]["olderCursor"].clone()),
    ] {
        assert!(matches!(
            call(&ops, "s", "stale", "history_sync", with(&[(name, token)])),
            Err(HistoryError::StaleCursor)
        ));
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
    assert_eq!(
        list(&ops, "before", temp())["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
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
            with(&[("objectId", text(&object_id)), ("offset", number(offset))]),
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
    ok(
        &ops,
        "s",
        "first",
        "append_entities",
        objects(Value::Array(vec![message("old", 1, "old content")])),
    );
    drop(ops);
    drop(store);
    let dir = crate::storage::jsonl::layout::session_dir(&root, "s")
        .unwrap()
        .join("history");
    let legacy = dir.join("history.000000");
    std::fs::rename(dir.join(super::HISTORY_FILE), &legacy).unwrap();
    let original = std::fs::read(&legacy).unwrap();
    let (store, ops) = open(&root);
    ok(
        &ops,
        "s",
        "second",
        "append_entities",
        objects(Value::Array(vec![message("new", 2, "new content")])),
    );
    assert_eq!(std::fs::read(&legacy).unwrap(), original);
    drop(ops);
    drop(store);
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
    ok(
        &ops,
        "s",
        "owner",
        "append_entities",
        objects(Value::Array(vec![message("m", 1, "complete")])),
    );
    let mut observation = objects(Value::Array(vec![
        message("m", 1, "partial"),
        message("missing", 2, "preserved"),
    ]));
    observation["ifAbsent"] = Value::Bool(true);
    ok(&ops, "s", "observer", "append_entities", observation);
    let page = list(&ops, "read", temp());
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(
        items
            .iter()
            .any(|item| item["id"] == "m" && item["content"] == "complete")
    );
    assert!(
        items
            .iter()
            .any(|item| item["id"] == "missing" && item["content"] == "preserved")
    );
    cleanup(root);
}

#[test]
fn truncate_user_message_without_checkpoints_is_atomic_and_survives_restart() {
    let root = temp_root("edit-message");
    let (store, ops) = open(&root);
    let entity = |kind: &str, id: &str, run: &str, time: &str| serde_json::json!({
        "kind":kind, "value":{"id":id,"sessionId":"s","runId":run,"createdAt":time}
    });
    let mut input = message("u1", 1, "First");
    input["value"]["role"] = text("user");
    input["value"]["runId"] = text("r1");
    input["value"]["createdAt"] = text("2026-01-01T00:00:01Z");
    let mut reply = message("a1", 2, "Reply");
    reply["value"]["role"] = text("assistant");
    reply["value"]["runId"] = text("r1");
    let mut target = message("u2", 3, "Edit me");
    target["value"]["role"] = text("user");
    target["value"]["runId"] = text("r2");
    target["value"]["createdAt"] = text("2026-01-01T00:00:03Z");
    let first = ok(&ops, "s", "append", "append_entities", objects(serde_json::json!([
        input, reply, target, message("a2",4,"Remove me"),
        entity("runtime.run","r1","r1","2026-01-01T00:00:01Z"),
        entity("runtime.run","r2","r2","2026-01-01T00:00:02Z"),
        entity("runtime.tool_call","t1","r1","2026-01-01T00:00:01Z"),
        entity("runtime.tool_call","t2","r2","2026-01-01T00:00:04Z"),
        entity("runtime.event","e2","r2","2026-01-01T00:00:04Z"),
        entity("runtime.file_change","f2","r2","2026-01-01T00:00:04Z")
    ])));
    assert!(matches!(call(&ops,"s","stale","truncate_message",serde_json::json!({"messageId":"u2","expectedRevision":0})), Err(HistoryError::RevisionConflict{..})));
    assert!(matches!(call(&ops,"s","assistant","truncate_message",serde_json::json!({"messageId":"a1","expectedRevision":first["revision"]})), Err(HistoryError::InvalidCommand(_))));
    assert!(matches!(call(&ops,"s","missing","truncate_message",serde_json::json!({"messageId":"missing","expectedRevision":first["revision"]})), Err(HistoryError::ObjectMissing(_))));
    assert_eq!(list(&ops,"before",temp())["items"].as_array().unwrap().len(),4);
    let payload=serde_json::json!({"messageId":"u2","expectedRevision":first["revision"],"metadata":{"historyFields":{"contextSnapshotId":null}}});
    let result=ok(&ops,"s","edit","truncate_message",payload.clone());
    assert_eq!(ok(&ops,"s","edit","truncate_message",payload.clone()),result);
    let retained=list(&ops,"after",temp());
    assert_eq!(retained["items"].as_array().unwrap().len(),2);
    assert_eq!(retained["items"][1]["id"],"a1");
    assert_eq!(ok(&ops,"s","runs","list_runs",temp())["items"].as_array().unwrap().len(),1);
    assert_eq!(ok(&ops,"s","tools","list_tool_calls",temp())["items"][0]["id"],"t1");
    assert_eq!(ok(&ops,"s","events","list_events",temp())["items"],serde_json::json!([]));
    assert_eq!(ok(&ops,"s","files","list_file_changes",temp())["items"][0]["id"],"f2");
    assert_eq!(ok(&ops,"s","checkpoints","list_checkpoints",temp())["items"],serde_json::json!([]));
    drop(ops);drop(store);
    let (store,ops)=open(&root);
    assert_eq!(ok(&ops,"s","edit","truncate_message",payload),result);
    assert_eq!(list(&ops,"restart",temp())["items"].as_array().unwrap().len(),2);
    assert_eq!(ok(&ops,"s","recover","file_recover",temp())["recovered"],true);
    ok(&ops,"s","ack","file_restore_ack",serde_json::json!({"requestId":"edit"}));
    let revision=head(&ops)["revision"].clone();
    ok(&ops,"s","first-edit","truncate_message",serde_json::json!({"messageId":"u1","expectedRevision":revision,"metadata":{}}));
    assert_eq!(list(&ops,"empty",temp())["items"],serde_json::json!([]));
    drop(ops);drop(store);cleanup(root);
}

#[test]
fn truncate_history_retains_target_and_replays_without_an_index_checkpoint() {
    let root = temp_root("truncate-history");
    let (store, ops) = open(&root);
    let mut target = message("target", 2, "Keep selected assistant reply");
    target["value"]["role"] = text("assistant");
    target["value"]["runId"] = text("shared-run");
    target["value"]["stepId"] = text("keep-step");
    ok(&ops, "s", "prefix", "append_entities", objects(serde_json::json!([
        message("prefix", 1, "Keep prefix"), target,
        {"kind":"runtime.run","value":{"id":"shared-run","sessionId":"s","status":"completed"}},
        {"kind":"runtime.step","value":{"id":"keep-step","sessionId":"s","runId":"shared-run","status":"completed","index":1}}
    ])));
    let mut tail = message("tail", 3, "Never expose tail");
    tail["value"]["runId"] = text("shared-run");
    tail["value"]["stepId"] = text("tail-step");
    let before = ok(&ops, "s", "suffix", "append_entities", objects(serde_json::json!([
        tail,
        {"kind":"runtime.step","value":{"id":"tail-step","sessionId":"s","runId":"shared-run","status":"completed","index":2}},
        {"kind":"runtime.part","value":{"id":"tail-part","sessionId":"s","stepId":"tail-step","kind":"text","content":"tail"}},
        {"kind":"runtime.event","value":{"id":"tail-event","sessionId":"s","runId":"shared-run"}},
        {"kind":"runtime.file_change","value":{"id":"tail-file","sessionId":"s","sequence":1}}
    ])));
    let window = ok(&ops, "s", "window", "history_sync", temp());
    let payload = serde_json::json!({"messageId":"target","expectedRevision":before["revision"],"metadata":{}});
    let mut stale = payload.clone(); stale["expectedRevision"] = number(0);
    assert!(matches!(call(&ops, "s", "stale", "truncate_history", stale), Err(HistoryError::RevisionConflict { .. })));
    let mut latest = payload.clone(); latest["messageId"] = text("tail");
    assert!(matches!(call(&ops, "s", "latest", "truncate_history", latest), Err(HistoryError::InvalidCommand(_))));
    let mut missing = payload.clone(); missing["messageId"] = text("missing");
    assert!(matches!(call(&ops, "s", "missing", "truncate_history", missing), Err(HistoryError::ObjectMissing(_))));
    assert_eq!(head(&ops), before);
    let result = ok(&ops, "s", "truncate", "truncate_history", payload.clone());
    let after = head(&ops);
    assert_eq!(after["revision"], before["revision"].as_u64().unwrap() + 1);
    assert_eq!(ok(&ops, "s", "truncate", "truncate_history", payload.clone()), result);
    let mut reused = payload.clone(); reused["messageId"] = text("prefix");
    assert!(matches!(call(&ops, "s", "truncate", "truncate_history", reused), Err(HistoryError::RequestConflict)));
    assert!(matches!(call(&ops, "s", "old-window", "history_sync",
        serde_json::json!({"since":window["historyWindow"]["syncCursor"]})), Err(HistoryError::StaleCursor)));
    let assert_projection = |ops: &HistoryOps| {
        let messages = list(ops, "messages", temp());
        assert_eq!(messages["items"].as_array().unwrap().len(), 2);
        assert_eq!(messages["items"][1]["id"], "target");
        let steps = ok(ops, "s", "steps", "list_steps", temp());
        assert_eq!(steps["items"].as_array().unwrap().len(), 1);
        assert_eq!(steps["items"][0]["id"], "keep-step");
        for operation in ["list_parts", "list_events", "list_file_changes"] {
            assert_eq!(ok(ops, "s", operation, operation, temp())["items"], serde_json::json!([]));
        }
        let page = ok(ops, "s", "graph", "page", serde_json::json!({"objectId":after["objectId"],"limit":256}));
        assert!(page["cursor"].is_null());
        assert!(!page.to_string().contains("tail"));
        let current = ok(ops, "s", "current", "context_current", temp());
        let updates = ok(ops, "s", "updates", "history_updates", serde_json::json!({
            "generation":current["generation"],"afterRevision":0,"throughRevision":after["revision"]
        }));
        assert_eq!(updates["items"], serde_json::json!([]));
    };
    assert_projection(&ops);
    drop(ops); drop(store);
    // Exercise log replay, not just the optional saved query projection.
    let directory = super::history_path(&root, "s").unwrap();
    std::fs::write(directory.join("history-index.bin"), b"invalid checkpoint").unwrap();
    let (store, ops) = open(&root);
    assert_eq!(head(&ops), after);
    assert_eq!(ok(&ops, "s", "truncate", "truncate_history", payload), result);
    assert_projection(&ops);
    assert_eq!(ok(&ops, "s", "verify", "verify", temp())["ok"], true);
    ok(&ops, "s", "pin-target", "checkpoint", serde_json::json!({
        "objectId":after["objectId"],"pinId":"target-pin","metadata":{"messageId":"target"}
    }));
    ok(&ops, "copy", "copy-truncated", "fork_copy", serde_json::json!({
        "sourceSessionId":"s","checkpointId":"target-pin","expectedRevision":after["revision"]
    }));
    let copied = ok(&ops, "copy", "messages", "list_messages", temp());
    assert_eq!(copied["items"].as_array().unwrap().len(), 2);
    assert!(!copied.to_string().contains("Never expose tail"));
    ok(&ops, "s", "append-after", "append_entities", objects(serde_json::json!([message("new", 4, "New branch")])));
    let messages = list(&ops, "after-append", temp());
    assert_eq!(messages["items"].as_array().unwrap().len(), 3);
    assert!(!messages.to_string().contains("Never expose tail"));
    drop(ops); drop(store); cleanup(root);
}

#[test]
fn truncate_history_preserves_the_compaction_seal_and_rejects_its_prefix() {
    let root = temp_root("truncate-history-seal");
    let (store, ops) = open(&root);
    ok(&ops, "s", "earlier", "append_entities", objects(serde_json::json!([message("earlier", 0, "Earlier evidence")])));
    let active = begin_context(&ops);
    ok(&ops, "s", "commit", "context_commit", serde_json::json!({"checkpoint":checkpoint_candidate(&active)}));
    let current = ok(&ops, "s", "current", "context_current", temp());
    let before = ok(&ops, "s", "new", "append_entities", objects(serde_json::json!([
        message("target", 3, "Keep target"), message("tail", 4, "Remove tail")
    ])));
    for id in ["earlier", "old-message"] {
        assert!(matches!(call(&ops, "s", id, "truncate_history",
            serde_json::json!({"messageId":id,"expectedRevision":before["revision"]})), Err(HistoryError::ReadOnlyHistory)));
    }
    ok(&ops, "s", "truncate", "truncate_history", serde_json::json!({"messageId":"target","expectedRevision":before["revision"]}));
    let after = ok(&ops, "s", "current", "context_current", temp());
    assert_eq!(after["checkpoint"], current["checkpoint"]);
    assert_eq!(after["sealedThroughRevision"], current["sealedThroughRevision"]);
    let messages = list(&ops, "messages", temp());
    for id in ["earlier", "old-message", "target"] {
        assert!(messages["items"].as_array().unwrap().iter().any(|item| item["id"] == id));
    }
    assert!(!messages["items"].as_array().unwrap().iter().any(|item| item["id"] == "tail"));
    assert!(matches!(call(&ops, "s", "rewrite-sealed", "append_entities",
        objects(serde_json::json!([message("old-message", 1, "Forbidden rewrite")]))), Err(HistoryError::ReadOnlyHistory)));
    drop(ops); drop(store); cleanup(root);
}

#[test]
fn subagent_summary_is_monotonic_and_keeps_one_message_across_reopen() {
    let root = temp_root("subagent-summary");
    let (store, ops) = open(&root);
    let summary = |seq, content| serde_json::json!({"message":{
        "id":"subagent-summary:child","sessionId":"s","role":"assistant","content":content,
        "createdAt":"2026-10-23","runId":null,"stepId":null,
        "metadata":{"source":"subagent_summary","childSessionId":"child","eventSeq":seq}
    }});
    let first = ok(&ops, "s", "summary-1", "subagent_summary", summary(1,"first"));
    let next = ok(&ops, "s", "summary-3", "subagent_summary", summary(3,"newest"));
    assert_eq!(first["sequence"], next["sequence"]);
    drop(ops); drop(store);
    let (store, ops) = open(&root);
    let older = ok(&ops, "s", "summary-2", "subagent_summary", summary(2,"old late reply"));
    assert_eq!(older["content"], "newest");
    let page = ok(&ops,"s","summary-list","list_messages",temp());
    assert_eq!(page["items"].as_array().unwrap().len(),1);
    assert_eq!(page["items"][0]["content"],"newest");
    drop(ops); drop(store); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn history_sync_tail_resumes_evicted_rows_without_gaps() {
    let root = temp_root("tail-resume");
    let (store, ops) = open(&root);
    // Bodies exceed the per-row inline allowance: the count guarantee must
    // survive byte budgeting by returning immutable object references.
    ok(&ops, "s", "append-tail", "append_entities", objects(Value::Array(
        (0..240).map(|i| message(&format!("m{i}"), i, &"x".repeat(2000))).collect(),
    )));
    let latest = ok(&ops, "s", "tail", "history_sync", with(&[("limit", number(100))]));
    assert_eq!(latest["messages"].as_array().unwrap().len(), 100);
    assert_eq!(latest["messages"][0]["id"], "m239");
    assert_eq!(latest["messages"][99]["id"], "m140");
    assert!(serde_json::to_vec(&latest).unwrap().len() < 512 * 1024);
    let boundary = serde_json::json!({
        "generation": latest["historyWindow"]["generation"], "rows": {"messages":"m180"}
    });
    let older = ok(&ops, "s", "resume-tail", "history_sync", serde_json::json!({
        "limit":100, "cursor":latest["historyWindow"]["olderCursor"], "before":boundary
    }));
    assert_eq!(older["messages"].as_array().unwrap().len(), 100);
    assert_eq!(older["messages"][0]["id"], "m179");
    assert_eq!(older["messages"][99]["id"], "m80");
    let oldest = ok(&ops, "s", "resume-oldest", "history_sync", serde_json::json!({
        "limit":100, "cursor":older["historyWindow"]["olderCursor"]
    }));
    assert_eq!(oldest["messages"].as_array().unwrap().len(), 80);
    assert_eq!(oldest["messages"][79]["id"], "m0");
    let without_cursor = ok(&ops, "s", "resume-only-boundary", "history_sync", serde_json::json!({
        "limit":100, "before":boundary
    }));
    assert_eq!(without_cursor["messages"][0]["id"], "m179");
    assert!(matches!(call(&ops, "s", "invalid-boundary", "history_sync", serde_json::json!({
        "before":{"generation":999,"rows":{"messages":"m180"}}
    })), Err(HistoryError::StaleCursor)));
    assert!(matches!(call(&ops, "s", "missing-boundary", "history_sync", serde_json::json!({
        "before":{"generation": latest["historyWindow"]["generation"],"rows":{"messages":"gone"}}
    })), Err(HistoryError::StaleCursor)));
    drop(store);
    cleanup(root);
}
