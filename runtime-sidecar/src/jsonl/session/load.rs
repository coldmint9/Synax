//! Cold load: rebuild a session from its newest sealed state.
//!
//! The newest segment directory is the only one that can still receive writes.
//! Everything it holds up to its newest seal is the committed state; earlier
//! directories were compacted into that seal and are never re-read.

use std::collections::{HashMap, VecDeque};
use std::path::Path;

use crate::jsonl::error::{JsonlError, JsonlResult};
use crate::jsonl::layout;
use crate::jsonl::record::{Record, SnapshotCond};
use crate::jsonl::seglog::read_all;
use crate::jsonl::segment::Projection;
use crate::jsonl::write::Extent;

use super::{CommittedEvent, EVENT_WINDOW, Publisher, RECEIPT_TTL_MS, StoredReceipt};

/// Everything the actor needs before it can serve a session.
pub struct Loaded {
    pub state: SnapshotCond,
    pub header: serde_json::Value,
    pub projection: Projection,
    pub events: VecDeque<CommittedEvent>,
    pub receipts: HashMap<(String, String), StoredReceipt>,
    pub files: Publisher,
    pub commit: u64,
}

pub fn load(root: &Path, session_id: &str) -> JsonlResult<Loaded> {
    let session_dir = layout::session_dir(root, session_id)?;
    let directory = newest_directory(&session_dir)?;
    let mut loaded = Loaded {
        state: SnapshotCond {
            epoch: 1,
            retained_from: 1,
            ..Default::default()
        },
        header: serde_json::Value::Null,
        projection: empty_projection(),
        events: VecDeque::new(),
        receipts: HashMap::new(),
        files: Publisher::open(&session_dir, directory, Extent { offsets: [0; 3], frames: [0; 3] })?,
        commit: 0,
    };
    let dir = session_dir
        .join(format!("{:06}", directory / layout::SEGMENTS_PER_DIRECTORY));
    eprintln!("DBG load dir={:?} exists={}", dir.join("clse.000000"), dir.join("clse.000000").exists());
    let seals = records(&dir, "clse")?;
    let extent = apply_seals(&mut loaded, &seals)?;
    if loaded.commit == 0 {
        return Ok(loaded);
    }
    for payload in records(&dir, "ctls")? {
        apply_control(&mut loaded, &serde_json::from_slice(&payload)?)?;
    }
    for payload in records(&dir, "evts")? {
        let Record::Event(event) = serde_json::from_slice(&payload)? else {
            continue;
        };
        loaded
            .projection
            .apply(
                event.s,
                &event.r,
                &crate::actor::PendingEvent {
                    kind: event.k.clone(),
                    payload: serde_json::to_vec(&event.p)?,
                },
            )
            .map_err(|error| JsonlError::corrupt(&dir, 0, error.to_string()))?;
        loaded.events.push_back(CommittedEvent {
            sequence: event.s,
            run_id: event.r,
            kind: event.k,
            payload: serde_json::to_vec(&event.p)?,
        });
    }
    loaded
        .events
        .retain(|event| event.sequence < loaded.state.cursor + 1);
    while loaded
        .events
        .front()
        .is_some_and(|event| event.sequence + EVENT_WINDOW <= loaded.state.cursor)
    {
        loaded.events.pop_front();
    }
    loaded
        .receipts
        .retain(|_, receipt| super::now_ms().saturating_sub(receipt.at) < RECEIPT_TTL_MS);
    loaded.state.retained_from = loaded
        .events
        .front()
        .map_or(loaded.state.cursor + 1, |event| event.sequence);
    loaded.files.extent = extent;
    Ok(loaded)
}

/// Apply the newest seal and return the extent it commits to.
fn apply_seals(loaded: &mut Loaded, seals: &[Vec<u8>]) -> JsonlResult<Extent> {
    let mut extent = Extent {
        offsets: [0; 3],
        frames: [0; 3],
    };
    for payload in seals {
        let Record::Seal(seal) = serde_json::from_slice(payload)? else {
            continue;
        };
        if seal.c <= loaded.commit {
            continue;
        }
        loaded.commit = seal.c;
        loaded.state = seal.snap;
        for entry in &seal.g {
            extent.offsets[entry.k as usize] = entry.o;
            extent.frames[entry.k as usize] = entry.n;
        }
    }
    Ok(extent)
}

fn apply_control(loaded: &mut Loaded, record: &Record) -> JsonlResult<()> {
    match record {
        // The seal is the authority for scalars; a snapshot only restores the
        // projection and header it was written with.
        Record::Snapshot(snapshot) => {
            loaded.header = snapshot.header.clone();
            loaded.projection = Projection::from_snapshot(&snapshot.projection);
            loaded.events.clear();
        }
        Record::Cond(cond) => loaded.state = cond.clone(),
        Record::Cursor { cur, .. } => loaded.state.cursor = *cur,
        Record::Receipt(receipt) => {
            loaded.receipts.insert(
                (receipt.sc.clone(), receipt.id.clone()),
                StoredReceipt {
                    fingerprint: receipt.f.clone(),
                    result: receipt.r.clone(),
                    at: receipt.at,
                },
            );
        }
        _ => {}
    }
    Ok(())
}

/// The segment number of the newest directory, or 0 for a new session.
fn newest_directory(session_dir: &Path) -> JsonlResult<u64> {
    let entries = match std::fs::read_dir(session_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(JsonlError::io(error)),
    };
    let newest = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u64>().ok())
        })
        .max()
        .unwrap_or(0);
    Ok(newest * layout::SEGMENTS_PER_DIRECTORY)
}

fn records(dir: &Path, prefix: &str) -> JsonlResult<Vec<Vec<u8>>> {
    Ok(read_all(&dir.join(format!("{prefix}.000000")))?
        .into_iter()
        .map(|(_, payload)| payload)
        .collect())
}

pub fn empty_projection() -> Projection {
    Projection::from_snapshot(&crate::projection::UiSnapshot {
        session: serde_json::Value::Null,
        run: serde_json::Value::Null,
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
