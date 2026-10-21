//! Query-index snapshots plus an exact committed history-log position.
use super::{
    ChangeEntry, HISTORY_FILE, HistoryHead, HistoryObject, HistoryReceipt, SessionIndex,
    SessionState,
};
use crate::storage::jsonl::{
    JsonlResult,
    checkpoint::{self, Position},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    sync::Arc,
};

const FILE: &str = "history-index.bin";

#[derive(Serialize, Deserialize)]
struct IndexData<O> {
    head: HistoryHead,
    current_head_revision: u64,
    order: BTreeMap<String, String>,
    identity: HashMap<String, String>,
    objects: O,
    generation: u64,
    index_generation: u64,
    index_root: Option<String>,
    changes: Vec<((u64, usize), ChangeEntry)>,
    aux: BTreeMap<String, Option<serde_json::Value>>,
    blobs: HashSet<String>,
    metadata_scope: Option<String>,
    metadata_generation: u64,
    receipts: HashMap<String, HistoryReceipt>,
}

#[derive(Serialize, Deserialize)]
struct Snapshot<O> {
    session_id: String,
    position: Position,
    legacy: Option<Position>,
    index: IndexData<O>,
}

pub(super) fn read(directory: &Path, id: &str) -> Option<(SessionIndex, u64)> {
    let saved: Snapshot<HashMap<String, HistoryObject>> = checkpoint::read(&directory.join(FILE))?;
    if saved.session_id != id
        || saved.index.head.session_id != id
        || !saved.position.valid(&directory.join(HISTORY_FILE))
    {
        return None;
    }
    let legacy_path = directory.join("history.000000");
    if let Some(legacy) = saved.legacy {
        if std::fs::metadata(&legacy_path).ok()?.len() != legacy.offset
            || !legacy.valid(&legacy_path)
        {
            return None;
        }
    } else if legacy_path.exists() {
        return None;
    }
    let data = saved.index;
    let objects: HashMap<_, _> = data
        .objects
        .into_iter()
        .map(|(id, object)| (id, Arc::new(object)))
        .collect();
    let mut order = BTreeMap::new();
    for (key, id) in data.order {
        order.insert(key, objects.get(&id)?.clone());
    }
    Some((
        SessionIndex {
            head: data.head,
            current_head_revision: data.current_head_revision,
            order,
            identity: data.identity,
            objects,
            generation: data.generation,
            index_generation: data.index_generation,
            index_root: data.index_root,
            changes: data.changes.into_iter().collect(),
            aux: data.aux,
            blobs: data.blobs,
            metadata_scope: data.metadata_scope,
            metadata_generation: data.metadata_generation,
            receipts: data.receipts,
        },
        saved.position.offset,
    ))
}

pub(super) fn save(state: &mut SessionState, force: bool) -> JsonlResult<()> {
    let offset = state.file.len();
    if offset == state.checkpoint_offset
        || (!force && offset.saturating_sub(state.checkpoint_offset) < 8 * 1024 * 1024)
    {
        return Ok(());
    }
    let directory = state.file.path().parent().expect("history directory");
    let index = &state.index;
    let legacy_path = directory.join("history.000000");
    let legacy = if legacy_path.exists() {
        Some(Position::capture(
            &legacy_path,
            std::fs::metadata(&legacy_path)?.len(),
        )?)
    } else {
        None
    };
    let saved = Snapshot {
        session_id: index.head.session_id.clone(),
        position: Position::capture(state.file.path(), offset)?,
        legacy,
        index: IndexData {
            head: index.head.clone(),
            current_head_revision: index.current_head_revision,
            order: index
                .order
                .iter()
                .map(|(key, object)| (key.clone(), object.object_id.clone()))
                .collect(),
            identity: index.identity.clone(),
            objects: index
                .objects
                .iter()
                .map(|(id, object)| (id, object.as_ref()))
                .collect::<HashMap<_, _>>(),
            generation: index.generation,
            index_generation: index.index_generation,
            index_root: index.index_root.clone(),
            changes: index
                .changes
                .iter()
                .map(|(key, change)| (*key, change.clone()))
                .collect(),
            aux: index.aux.clone(),
            blobs: index.blobs.clone(),
            metadata_scope: index.metadata_scope.clone(),
            metadata_generation: index.metadata_generation,
            receipts: index.receipts.clone(),
        },
    };
    checkpoint::write(&directory.join(FILE), &saved)?;
    state.checkpoint_offset = offset;
    Ok(())
}
