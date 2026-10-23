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

fn should_save(offset: u64, previous: u64, force: bool) -> bool {
    offset != previous && (force || offset.saturating_sub(previous) >= previous.max(8 * 1024 * 1024))
}

#[derive(Serialize, Deserialize)]
struct IndexData<O> {
    head: HistoryHead,
    current_head_revision: u64,
    order: BTreeMap<String, String>,
    identity: HashMap<String, String>,
    first_revision: HashMap<String, u64>,
    birth_order: Vec<((String, u64, String), String)>,
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
            step_text: order.values().filter_map(|object| super::step_text_key(object).map(|key| (key, object.clone()))).collect(),
            order: order.into_iter().collect(),
            identity: data.identity.into_iter().collect(),
            first_revision: data.first_revision.into_iter().collect(),
            birth_order: data.birth_order.into_iter().collect(),
            objects: objects.into_iter().collect(),
            generation: data.generation,
            index_generation: data.index_generation,
            index_root: data.index_root,
            changes: data.changes.into_iter().collect(),
            aux: data.aux.into_iter().collect(),
            blobs: data.blobs.into_iter().collect(),
            metadata_scope: data.metadata_scope,
            metadata_generation: data.metadata_generation,
            receipts: data.receipts.into_iter().collect(),
        },
        saved.position.offset,
    ))
}

pub(super) fn save(state: &mut SessionState, force: bool) -> JsonlResult<()> {
    let offset = state.file.len();
    // Full index snapshots grow with history. Geometric spacing bounds total
    // snapshot serialization/write volume over the lifetime of a hot session.
    if !should_save(offset, state.checkpoint_offset, force) {
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
            identity: index.identity.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            first_revision: index.first_revision.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            birth_order: index.birth_order.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
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
            aux: index.aux.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            blobs: index.blobs.iter().cloned().collect(),
            metadata_scope: index.metadata_scope.clone(),
            metadata_generation: index.metadata_generation,
            receipts: index.receipts.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        },
    };
    checkpoint::write(&directory.join(FILE), &saved)?;
    state.checkpoint_offset = offset;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::should_save;

    #[test]
    fn automatic_snapshot_writes_are_amortized_linear() {
        let unit = 1024 * 1024;
        let mut previous = 0;
        let mut total = 0;
        for offset in (1..=1024).map(|n| n * unit) {
            if should_save(offset, previous, false) {
                total += offset;
                previous = offset;
            }
        }
        // Full snapshots at 8, 16, 32, ... MiB; not every additional 8 MiB.
        assert!(total < 2 * 1024 * unit);
        assert!(!should_save(previous, previous, true));
        assert!(should_save(previous + 1, previous, true));
    }
}
