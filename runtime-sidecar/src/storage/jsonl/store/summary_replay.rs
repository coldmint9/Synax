//! Repair a missing query row using only committed session-header/permission
//! fields. Never construct an execution actor, transcript, receipt cache or UI.
use crate::storage::jsonl::{
    JsonlError, JsonlResult,
    delta::{self, Change},
    layout,
    record::{ListRecord, Record},
    seglog,
    session::load,
    write::Kind,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Permissions {
    #[serde(default)]
    permissions: Vec<Value>,
    #[serde(default)]
    execution_lease: Value,
    #[serde(default)]
    runtime_control: Value,
    #[serde(default)]
    process_leases: Vec<Value>,
}

fn control_fields(value: &Value) -> Value {
    json!({"permissions":value["permissions"], "executionLease":value["executionLease"],
        "runtimeControl":value["runtimeControl"], "processLeases":value["processLeases"]})
}

#[derive(Deserialize)]
#[serde(tag = "t")]
enum Control {
    #[serde(rename = "snapshot")]
    Snapshot { header: Value },
    #[serde(rename = "control")]
    Control { ctl: Option<Permissions> },
    #[serde(rename = "delta_v2")]
    Delta { c: u64, changes: Vec<Change> },
    #[serde(other)]
    Other,
}
#[derive(Deserialize)]
struct Event {
    p: EventPayload,
}
#[derive(Deserialize)]
struct EventPayload {
    state: Value,
}

fn path(change: &Change) -> &[String] {
    match change {
        Change::Set { path, .. }
        | Change::Remove { path }
        | Change::Append { path, .. }
        | Change::Resize { path, .. }
        | Change::TextRef { path, .. } => path,
    }
}

fn apply(root: &Path, document: &mut Value, changes: Vec<Change>) -> JsonlResult<()> {
    for change in changes {
        let keys = path(&change);
        if keys.starts_with(&[
            "projection".into(),
            "session".into(),
            "sessionMetadata".into(),
            "latestSystemPrompt".into(),
        ]) {
            continue;
        }
        if keys.starts_with(&["projection".into(), "session".into()])
            || keys == ["state", "active_run_id"]
            || (keys.first().is_some_and(|key| key == "control")
                && keys.get(1).is_some_and(|key| {
                    [
                        "permissions",
                        "runtimeControl",
                        "executionLease",
                        "processLeases",
                    ]
                    .contains(&key.as_str())
                }))
        {
            delta::apply(root, document, &[change])?;
        } else if let Change::Set { path, value } = change {
            match path
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice()
            {
                [] => {
                    document["projection"]["session"] = value["projection"]["session"].clone();
                    document["control"] = control_fields(&value["control"]);
                    document["state"]["active_run_id"] = value["state"]["active_run_id"].clone();
                }
                ["projection"] => document["projection"]["session"] = value["session"].clone(),
                ["control"] => document["control"] = control_fields(&value),
                ["state"] => document["state"]["active_run_id"] = value["active_run_id"].clone(),
                _ => {}
            }
        }
    }
    Ok(())
}

pub(super) fn read(root: &Path, id: &str) -> JsonlResult<ListRecord> {
    let directory = layout::session_dir(root, id)?;
    let mut document = json!({"state":{"active_run_id":null},"projection":{"session":null},"control":{"permissions":[],"runtimeControl":null,"executionLease":null,"processLeases":[]}});
    let mut previous_commit = 0;
    for (base, v2) in [(&directory, false), (&directory.join("events-v2"), true)] {
        for segment in load::segment_directories(base)? {
            let directory = layout::segment_dir(base, segment);
            let mut prior = load::empty_extent();
            seglog::visit_complete(&load::file(&directory, Kind::Seal), |offset, bytes| {
                let (commit, extent, legacy) = match serde_json::from_slice::<Record>(bytes)? {
                    Record::Commit { c, g } if v2 => (c, load::coverage(&g, segment)?, None),
                    Record::Seal(seal) if !v2 => {
                        (seal.c, load::coverage(&seal.g, segment)?, Some(seal.snap))
                    }
                    _ => {
                        return Err(JsonlError::corrupt(
                            &directory,
                            offset,
                            "invalid summary commit",
                        ));
                    }
                };
                if commit <= previous_commit {
                    return Err(JsonlError::corrupt(
                        &directory,
                        offset,
                        "summary commit regressed",
                    ));
                }
                let mut changes = Vec::new();
                seglog::visit(
                    &load::file(&directory, Kind::Controls),
                    prior.offsets[0],
                    extent.offsets[0],
                    |_, bytes| {
                        match serde_json::from_slice::<Control>(bytes)? {
                            Control::Snapshot { header } if !v2 => {
                                document["projection"]["session"] = header
                            }
                            Control::Control { ctl: Some(control) } if !v2 => {
                                document["control"] = json!({
                                    "permissions":control.permissions, "executionLease":control.execution_lease,
                                    "runtimeControl":control.runtime_control, "processLeases":control.process_leases,
                                })
                            }
                            Control::Delta { c, changes: patch } if v2 && c == commit => {
                                changes.extend(patch)
                            }
                            _ => {}
                        }
                        Ok(())
                    },
                )?;
                seglog::visit(
                    &load::file(&directory, Kind::Events),
                    prior.offsets[1],
                    extent.offsets[1],
                    |_, bytes| {
                        let event: Event = serde_json::from_slice(bytes)?;
                        for key in [
                            "status",
                            "activeRunId",
                            "pendingResumeToken",
                            "blockedReason",
                            "updatedAt",
                        ] {
                            document["projection"]["session"][key] = event.p.state[key].clone();
                        }
                        Ok(())
                    },
                )?;
                if v2 {
                    apply(root, &mut document, changes)?;
                } else if let Some(state) = legacy {
                    if let Some(header) = state.header {
                        document["projection"]["session"] = header;
                    }
                    document["state"]["active_run_id"] = json!(state.active_run_id);
                }
                prior = extent;
                previous_commit = commit;
                Ok(())
            })?;
        }
    }
    let pending = document["control"]["permissions"]
        .as_array()
        .map_or(0, |items| {
            items
                .iter()
                .filter(|item| item["action"] == "ask" && item["resolvedAt"].is_null())
                .count()
        });
    let mut header = document["projection"]["session"].take();
    if header.is_object() {
        header["pendingPermissionCount"] = json!(pending);
        header["runtimeRecoveryRequired"] = json!(
            header["activeRunId"].is_string()
                || document["state"]["active_run_id"].is_string()
                || matches!(
                    header["status"].as_str(),
                    Some("running" | "stopping" | "queued")
                )
                || !document["control"]["runtimeControl"].is_null()
                || (document["control"]["executionLease"].is_object()
                    && document["control"]["executionLease"]["closed"] != true)
                || document["control"]["processLeases"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
        );
        if let Some(metadata) = header["sessionMetadata"].as_object_mut() {
            metadata.remove("latestSystemPrompt");
        }
    }
    Ok(ListRecord {
        s: id.into(),
        u: header["updatedAt"].as_str().unwrap_or_default().into(),
        h: header,
        del: false,
    })
}
