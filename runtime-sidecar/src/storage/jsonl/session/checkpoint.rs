use super::{CommittedEvent, SessionActor, StoredReceipt};
use crate::{
    runtime::{input_queue::QueueState, projection::UiSnapshot, session_types::ControlState},
    storage::jsonl::{
        JsonlResult,
        checkpoint::{self, Position},
        layout,
        record::SnapshotCond,
        segment::Projection,
        write::Extent,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::Arc,
};

pub const FILE: &str = "runtime-checkpoint.bin";

#[derive(Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    pub segment: u64,
    pub positions: [Position; 3],
    pub frames: [u64; 3],
    pub commit: u64,
    pub state: SnapshotCond,
    pub projection: UiSnapshot,
    pub control: ControlState,
    pub queue: QueueState,
    events: Vec<Event>,
    receipts: Vec<((String, String), StoredReceipt)>,
}

#[derive(Serialize, Deserialize)]
struct Event {
    sequence: u64,
    run_id: String,
    kind: String,
    #[serde(with = "checkpoint::bytes")]
    payload: Vec<u8>,
}

impl Snapshot {
    pub fn extent(&self) -> Extent {
        Extent {
            offsets: std::array::from_fn(|i| self.positions[i].offset),
            frames: self.frames,
        }
    }
    pub fn restore(self, loaded: &mut super::load::Loaded) {
        loaded.commit = self.commit;
        loaded.checkpoint_commit = self.commit;
        loaded.state = self.state;
        loaded.header = self.projection.session.clone();
        loaded.projection = Projection::from_snapshot(&self.projection);
        loaded.control = self.control;
        loaded.queue = self.queue;
        loaded.events = self
            .events
            .into_iter()
            .map(|event| CommittedEvent {
                sequence: event.sequence,
                run_id: event.run_id,
                kind: event.kind,
                payload: Arc::from(event.payload),
            })
            .collect::<VecDeque<_>>();
        loaded.receipts = self
            .receipts
            .into_iter()
            .filter(|(_, receipt)| {
                super::now_ms().saturating_sub(receipt.at) < super::RECEIPT_TTL_MS
            })
            .collect::<HashMap<_, _>>();
    }
}

pub fn read(directory: &Path, id: &str) -> Option<Snapshot> {
    let saved: Snapshot = checkpoint::read(&directory.join(FILE))?;
    if saved.id != id || saved.projection.session["id"] != id {
        return None;
    }
    let segment = layout::segment_dir(&directory.join("events-v2"), saved.segment);
    for (i, name) in ["ctls.000000", "evts.000000", "clse.000000"]
        .iter()
        .enumerate()
    {
        if !saved.positions[i].valid(&segment.join(name)) {
            return None;
        }
    }
    Some(saved)
}

pub fn save(root: &Path, actor: &mut SessionActor, force: bool) -> JsonlResult<()> {
    if !actor.header.is_object()
        || actor.commit == actor.checkpoint_commit
        || (!force
            && (actor.commit.saturating_sub(actor.checkpoint_commit) < 128
                || actor.checkpoint_at.elapsed().as_secs() < 30))
    {
        return Ok(());
    }
    let directory = layout::session_dir(root, &actor.id)?;
    let positions = [
        Position::capture(actor.files.controls.path(), actor.files.extent.offsets[0])?,
        Position::capture(actor.files.events.path(), actor.files.extent.offsets[1])?,
        Position::capture(actor.files.seals.path(), actor.files.extent.offsets[2])?,
    ];
    let snapshot = Snapshot {
        id: actor.id.clone(),
        segment: actor.files.segment,
        positions,
        frames: actor.files.extent.frames,
        commit: actor.commit,
        state: actor.state.clone(),
        projection: serde_json::from_value(
            actor
                .projection
                .as_ref()
                .expect("seeded projection")
                .to_json(),
        )?,
        control: actor.control.clone(),
        queue: actor.queue.clone(),
        events: actor
            .events
            .iter()
            .map(|event| Event {
                sequence: event.sequence,
                run_id: event.run_id.clone(),
                kind: event.kind.clone(),
                payload: event.payload.to_vec(),
            })
            .collect(),
        receipts: actor
            .receipts
            .iter()
            .map(|(id, receipt)| (id.clone(), receipt.clone()))
            .collect(),
    };
    checkpoint::write(&directory.join(FILE), &snapshot)?;
    actor.checkpoint_commit = actor.commit;
    actor.checkpoint_at = std::time::Instant::now();
    Ok(())
}
