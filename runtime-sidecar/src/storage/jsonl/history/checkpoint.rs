//! Query-index snapshots plus an exact committed history-log position.
use super::{
    ChangeEntry, HISTORY_FILE, HistoryHead, HistoryObject, HistoryReceipt, HistorySession,
    SessionIndex, SessionState,
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
    offset != previous
        && (force || offset.saturating_sub(previous) >= previous.max(8 * 1024 * 1024))
}

#[derive(Serialize, Deserialize)]
struct IndexData<O, R = HashMap<String, HistoryReceipt>> {
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
    receipts: R,
}

#[derive(Serialize, Deserialize)]
struct Snapshot<O, R = HashMap<String, HistoryReceipt>> {
    session_id: String,
    position: Position,
    legacy: Option<Position>,
    index: IndexData<O, R>,
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
            step_text: order
                .values()
                .filter_map(|object| super::step_text_key(object).map(|key| (key, object.clone())))
                .collect(),
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

// Serialize one consistent index under its lock, then compress/fsync outside it.
// A busy gate skips periodic work rather than queueing full history copies.
pub(super) fn save_session(session: &HistorySession) -> JsonlResult<()> {
    save_session_with(session, checkpoint::Pending::stage)
}

fn save_session_with(
    session: &HistorySession,
    stage: impl FnOnce(checkpoint::Pending) -> JsonlResult<checkpoint::Staged>,
) -> JsonlResult<()> {
    let Some(_gate) = session.checkpoint_lock.try_lock() else {
        return Ok(());
    };
    let prepared = {
        let state = session.lock.lock();
        prepare(&state, false)?
            .map(|(pending, offset)| (pending, offset, state.checkpoint_generation))
    };
    let Some((pending, offset, generation)) = prepared else {
        return Ok(());
    };
    let staged = stage(pending)?;
    let mut state = session.lock.lock();
    // fork_copy can replace this session's log while compression runs.
    // Discard that old snapshot; its offset must not suppress a fresh one.
    if state.checkpoint_generation == generation {
        staged.publish()?;
        state.checkpoint_offset = offset;
    }
    Ok(())
}

// Drop owns the session exclusively; there are no concurrent readers/writers.
pub(super) fn save(state: &mut SessionState, force: bool) -> JsonlResult<()> {
    if state.failed { return Ok(()); }
    if let Some((pending, offset)) = prepare(state, force)? {
        pending.stage()?.publish()?;
        state.checkpoint_offset = offset;
    }
    Ok(())
}

fn prepare(state: &SessionState, force: bool) -> JsonlResult<Option<(checkpoint::Pending, u64)>> {
    if state.failed { return Ok(None); }
    let offset = state.file.len();
    // Full index snapshots grow with history. Geometric spacing bounds total
    // snapshot serialization/write volume over the lifetime of a hot session.
    if !should_save(offset, state.checkpoint_offset, force) {
        return Ok(None);
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
            identity: index
                .identity
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            first_revision: index
                .first_revision
                .iter()
                .map(|(k, v)| (k.clone(), *v))
                .collect(),
            birth_order: index
                .birth_order
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
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
            aux: index
                .aux
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            blobs: index.blobs.iter().cloned().collect(),
            metadata_scope: index.metadata_scope.clone(),
            metadata_generation: index.metadata_generation,
            receipts: index.receipts.iter().collect::<HashMap<_, _>>(),
        },
    };
    Ok(Some((
        checkpoint::Pending::new(directory.join(FILE), &saved)?,
        offset,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::jsonl::{file::AppendFile, record::Record};
    use serde_json::json;

    fn append(session: &HistorySession, value: serde_json::Value) {
        let record = Record::HistoryAux(super::super::AuxRecord::Set("test".into(), Some(value)));
        let mut state = session.lock.lock();
        state.file.append(&record.encode()).unwrap();
        state
            .file
            .append(&Record::HistorySeal { c: 1 }.encode())
            .unwrap();
        state.file.sync().unwrap();
        super::super::apply_record(&mut state.index, record);
    }

    fn setup() -> (std::path::PathBuf, Arc<HistorySession>) {
        let root =
            std::env::temp_dir().join(format!("synax-history-checkpoint-{}", uuid::Uuid::new_v4()));
        let session = Arc::new(HistorySession::open(&root, "s").unwrap());
        for _ in 0..5 {
            append(&session, json!("x".repeat(2 * 1024 * 1024)));
        }
        (root, session)
    }

    #[test]
    fn history_checkpoint_compression_allows_appends_and_replays_the_tail() {
        use std::{sync::mpsc, time::Duration};
        let (root, session) = setup();
        let offset = session.lock.lock().file.len();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = {
            let session = session.clone();
            std::thread::spawn(move || {
                save_session_with(&session, |pending| {
                    assert!(session.lock.try_lock().is_some());
                    ready_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                    pending.stage()
                })
                .unwrap()
            })
        };
        ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(session.lock.try_lock().is_some());
        append(&session, json!("newer"));
        save_session_with(&session, |_| panic!("must not queue a second full index")).unwrap();
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        let directory = super::super::history_path(&root, "s").unwrap();
        let (mut index, saved) = read(&directory, "s").unwrap();
        assert_eq!(saved, offset);
        super::super::replay_into(&directory.join(HISTORY_FILE), &mut index, false, saved).unwrap();
        assert_eq!(index.aux.get("test").unwrap(), &Some(json!("newer")));
        drop(session);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_log_discards_inflight_checkpoint_without_advancing_its_offset() {
        let (root, session) = setup();
        let directory = super::super::history_path(&root, "s").unwrap();
        save_session_with(&session, |pending| {
            let staged = pending.stage()?;
            let path = directory.join("replacement");
            let mut replacement = AppendFile::open(&path)?;
            let record = Record::HistoryAux(super::super::AuxRecord::Set(
                "test".into(),
                Some(json!("replacement")),
            ));
            replacement.append(&record.encode())?;
            replacement.append(&Record::HistorySeal { c: 1 }.encode())?;
            replacement.sync()?;
            let destination = directory.join(HISTORY_FILE);
            std::fs::rename(&path, &destination)?;
            replacement.relocate(destination);
            let mut state = session.lock.lock();
            state.file = replacement;
            state.index = SessionIndex::empty("s");
            super::super::apply_record(&mut state.index, record);
            state.checkpoint_generation += 1;
            state.checkpoint_offset = 0;
            Ok(staged)
        })
        .unwrap();
        assert_eq!(session.lock.lock().checkpoint_offset, 0);
        assert!(!directory.join(FILE).exists());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        drop(session);
        let (index, _) = read(&directory, "s").unwrap();
        assert_eq!(index.aux.get("test").unwrap(), &Some(json!("replacement")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_history_checkpoint_remains_eligible_for_retry() {
        let (root, session) = setup();
        assert!(
            save_session_with(&session, |_| Err(std::io::Error::other(
                "injected checkpoint failure"
            )
            .into()))
            .is_err()
        );
        assert_eq!(session.lock.lock().checkpoint_offset, 0);
        save_session(&session).unwrap();
        {
            let state = session.lock.lock();
            assert_eq!(state.checkpoint_offset, state.file.len());
        }
        drop(session);
        std::fs::remove_dir_all(root).unwrap();
    }

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
