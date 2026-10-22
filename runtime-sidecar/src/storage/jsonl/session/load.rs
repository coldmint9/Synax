//! Read legacy files without modifying them, then replay committed v2 changes.
//! Every scanner holds at most one transaction rather than an entire log.
use super::{CommittedEvent, EVENT_WINDOW, Publisher, StoredReceipt};
use crate::runtime::{
    actor::{PendingEvent, StreamEvent},
    input_queue::QueueState,
    projection::UiSnapshot,
    session_types::ControlState,
};
use crate::storage::jsonl::{
    delta,
    error::{JsonlError, JsonlResult},
    layout,
    record::{Coverage, Record, SnapshotCond},
    seglog,
    segment::Projection,
    write::{Extent, Kind},
};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::Path;

pub struct Loaded {
    pub state: SnapshotCond,
    pub header: Value,
    pub projection: Projection,
    pub control: ControlState,
    pub queue: QueueState,
    pub events: VecDeque<CommittedEvent>,
    pub receipts: HashMap<(String, String), StoredReceipt>,
    pub files: Publisher,
    pub commit: u64,
    pub checkpoint_commit: u64,
    pub replayed_commits: usize,
}
pub(crate) fn empty_extent() -> Extent {
    Extent {
        offsets: [0; 3],
        frames: [0; 3],
    }
}
pub(crate) fn file(dir: &Path, kind: Kind) -> std::path::PathBuf {
    dir.join(match kind {
        Kind::Controls => "ctls.000000",
        Kind::Events => "evts.000000",
        Kind::Seal => "clse.000000",
    })
}
pub(crate) fn coverage(g: &[Coverage], segment: u64) -> JsonlResult<Extent> {
    let mut extent = empty_extent();
    for entry in g {
        if entry.d != segment || entry.k > 1 {
            return Err(JsonlError::corrupt("commit", 0, "invalid coverage"));
        }
        extent.offsets[entry.k as usize] = entry.o;
        extent.frames[entry.k as usize] = entry.n;
    }
    Ok(extent)
}

pub fn load(root: &Path, session_id: &str) -> JsonlResult<Loaded> {
    let dir = layout::session_dir(root, session_id)?;
    let v2 = dir.join("events-v2");
    let directories = segment_directories(&v2)?;
    let newest = directories.last().copied().unwrap_or(0);
    let snapshot = super::checkpoint::read(&dir, session_id);
    let resume = snapshot
        .as_ref()
        .map(|saved| (saved.segment, saved.extent()));
    let mut extent = resume
        .as_ref()
        .filter(|(segment, _)| *segment == newest)
        .map(|(_, extent)| extent.clone())
        .unwrap_or_else(empty_extent);
    seglog::visit_complete_from(
        &file(&layout::segment_dir(&v2, newest), Kind::Seal),
        extent.offsets[2],
        |offset, bytes| {
            let Record::Commit { g, .. } = serde_json::from_slice(bytes)? else {
                return Err(JsonlError::corrupt(&v2, offset, "expected v2 commit"));
            };
            let count = extent.frames[2] + 1;
            extent = coverage(&g, newest)?;
            extent.offsets[2] = offset + bytes.len() as u64 + 4;
            extent.frames[2] = count;
            Ok(())
        },
    )?;
    let mut loaded = Loaded {
        state: SnapshotCond {
            epoch: 1,
            retained_from: 1,
            ..Default::default()
        },
        header: Value::Null,
        projection: empty_projection(),
        control: ControlState::default(),
        queue: QueueState::default(),
        events: VecDeque::new(),
        receipts: HashMap::new(),
        commit: 0,
        checkpoint_commit: 0,
        replayed_commits: 0,
        files: Publisher::open(&dir, newest, extent)?,
    };
    if let Some(saved) = snapshot {
        saved.restore(&mut loaded);
    }
    if resume.is_none() {
        for segment in segment_directories(&dir)? {
            replay_segment(
                root,
                &layout::segment_dir(&dir, segment),
                segment,
                false,
                empty_extent(),
                &mut loaded,
            )?;
        }
    }
    for segment in directories {
        if resume.as_ref().is_some_and(|(saved, _)| segment < *saved) {
            continue;
        }
        replay_segment(
            root,
            &layout::segment_dir(&v2, segment),
            segment,
            true,
            resume
                .as_ref()
                .filter(|(saved, _)| segment == *saved)
                .map(|(_, extent)| extent.clone())
                .unwrap_or_else(empty_extent),
            &mut loaded,
        )?;
    }
    loaded.header = loaded.projection.session.to_json();
    loaded.state.header = None;
    loaded.state.retained_from = loaded
        .events
        .front()
        .map_or(loaded.state.cursor + 1, |event| event.sequence);
    Ok(loaded)
}

fn replay_segment(
    root: &Path,
    dir: &Path,
    segment: u64,
    v2: bool,
    mut prior: Extent,
    loaded: &mut Loaded,
) -> JsonlResult<()> {
    seglog::visit_complete_from(&file(dir, Kind::Seal), prior.offsets[2], |offset, bytes| {
        let record: Record = serde_json::from_slice(bytes)?;
        let (commit, extent, legacy_state) = match record {
            Record::Commit { c, g } if v2 => (c, coverage(&g, segment)?, None),
            Record::Seal(seal) if !v2 => (seal.c, coverage(&seal.g, segment)?, Some(seal.snap)),
            _ => return Err(JsonlError::corrupt(dir, offset, "invalid commit version")),
        };
        if commit <= loaded.commit {
            return Err(JsonlError::corrupt(
                dir,
                offset,
                "commit sequence regressed",
            ));
        }
        let mut changes = Vec::new();
        let mut receipts = Vec::new();
        seglog::visit(
            &file(dir, Kind::Controls),
            prior.offsets[0],
            extent.offsets[0],
            |_, payload| {
                match serde_json::from_slice::<Record>(payload)? {
                    Record::Delta { c, changes: patch } if v2 && c == commit => {
                        changes.extend(patch)
                    }
                    Record::CompactReceipt(receipt) if v2 => receipts.push((receipt, true)),
                    Record::Receipt(receipt) if !v2 => receipts.push((receipt, false)),
                    Record::Snapshot(snapshot) if !v2 => {
                        loaded.projection = Projection::from_snapshot(&snapshot.projection);
                        loaded.header = snapshot.header;
                        loaded.queue = loaded.projection.queue();
                        loaded.events.clear();
                    }
                    Record::Control { ctl, queue, .. } if !v2 => {
                        if let Some(control) = ctl {
                            loaded.control = control;
                        }
                        if let Some(queue) = queue {
                            loaded.queue = queue;
                        }
                    }
                    Record::Cond(_) | Record::Cursor { .. } if !v2 => {}
                    _ => return Err(JsonlError::corrupt(dir, 0, "invalid transaction record")),
                }
                Ok(())
            },
        )?;
        let mut events = Vec::new();
        seglog::visit(
            &file(dir, Kind::Events),
            prior.offsets[1],
            extent.offsets[1],
            |_, bytes| {
                let Record::Event(event) = serde_json::from_slice(bytes)? else {
                    return Err(JsonlError::corrupt(dir, 0, "expected event"));
                };
                let payload = serde_json::to_vec(&event.p)?;
                loaded.projection.apply(
                    event.s,
                    &event.r,
                    &PendingEvent {
                        kind: event.k.clone(),
                        payload: payload.clone(),
                    },
                )?;
                events.push(StreamEvent {
                    sequence: event.s,
                    run_id: event.r,
                    kind: event.k,
                    payload,
                    ephemeral: false,
                });
                Ok(())
            },
        )?;
        if v2 {
            super::replay::apply_changes(root, loaded, &changes)?;
            for event in &mut events {
                let mut payload: Value = serde_json::from_slice(&event.payload)?;
                if payload.as_object_mut().and_then(|m| m.remove("controlRef"))
                    == Some(Value::Bool(true))
                {
                    payload["chunk"]["control"] = serde_json::to_value(&loaded.control)?;
                    event.payload = serde_json::to_vec(&payload)?;
                }
            }
        } else if let Some(state) = legacy_state {
            if let Some(header) = &state.header {
                loaded.projection.session = super::super::segment::PValue::from_json(header);
            }
            loaded.state = state;
        }
        for (receipt, compact) in receipts {
            if super::now_ms().saturating_sub(receipt.at) >= super::RECEIPT_TTL_MS {
                continue;
            }
            let result = if compact {
                let control = if receipt.r.get("controlChanges").is_some() {
                    serde_json::to_value(&loaded.control)?
                } else {
                    Value::Null
                };
                let queue = if receipt.r.get("currentQueue").is_some() {
                    serde_json::to_value(&loaded.queue)?
                } else {
                    Value::Null
                };
                delta::expand_receipt(root, receipt.r, &control, &queue, &events)?
            } else {
                receipt.r
            };
            loaded.receipts.insert(
                (receipt.sc, receipt.id),
                StoredReceipt {
                    fingerprint: receipt.f,
                    result: serde_json::to_vec(&result)?,
                    at: receipt.at,
                },
            );
        }
        while loaded.receipts.len() > super::RECEIPT_RING {
            let oldest = loaded
                .receipts
                .iter()
                .min_by_key(|(_, v)| v.at)
                .map(|(k, _)| k.clone())
                .unwrap();
            loaded.receipts.remove(&oldest);
        }
        for event in events {
            loaded.events.push_back(CommittedEvent {
                sequence: event.sequence,
                run_id: event.run_id,
                kind: event.kind,
                payload: std::sync::Arc::from(event.payload),
            });
            while loaded.events.len() as u64 > EVENT_WINDOW {
                loaded.events.pop_front();
            }
        }
        loaded.commit = commit;
        loaded.replayed_commits += 1;
        prior = extent;
        Ok(())
    })?;
    Ok(())
}

pub fn segment_directories(dir: &Path) -> JsonlResult<Vec<u64>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(JsonlError::io(error)),
    };
    let mut dirs: Vec<u64> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.parse().ok()))
        .collect();
    dirs.sort_unstable();
    Ok(dirs)
}

pub fn empty_projection() -> Projection {
    Projection::from_snapshot(&UiSnapshot {
        session: Value::Null,
        run: Value::Null,
        cursor: 0,
        live_chunks: Vec::new(),
        completed_step_ids: Vec::new(),
        queued_inputs: Vec::new(),
        force_inject_item_id: None,
        queue_revision: 0,
        pending_queue_input: None,
        pending_partial_message: None,
    })
}
