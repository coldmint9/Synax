//! The agent-loop journal: a checkpoint plus the ordered events after it.
//!
//! Frames are `{"t":"ckp","seq":N,"v":…}` and `{"t":"ev",…}` in one appended
//! file per loop. A checkpoint is written at start, on every terminal
//! transition and every `CHECKPOINT_EVERY` events, so recovery reads the newest
//! checkpoint and the short tail after it instead of replaying the loop.

use std::path::Path;

use serde_json::value::RawValue;

use super::error::JsonlResult;
use super::layout::loop_journal_path;
use super::seglog::SegLog;

pub const CHECKPOINT_EVERY: u64 = 64;

/// What the loop executor needs to resume.
pub struct Journal {
    pub checkpoint: Vec<u8>,
    pub events: Vec<Vec<u8>>,
    /// Sequence of the last event the checkpoint already covers.
    pub checkpoint_sequence: u64,
}

pub struct LoopJournal {
    log: SegLog,
}

impl LoopJournal {
    pub fn open(root: &Path, loop_id: &str) -> JsonlResult<Self> {
        Ok(Self {
            log: SegLog::open(&loop_journal_path(root, loop_id)?)?,
        })
    }

    /// Append events and, when due, a new checkpoint. One write for the batch.
    pub fn append(
        &mut self,
        checkpoint: Option<(&RawValue, u64)>,
        events: &[(u64, &RawValue)],
    ) -> JsonlResult<()> {
        let mut lines: Vec<Vec<u8>> = Vec::with_capacity(events.len() + 1);
        // The checkpoint goes first: a torn batch then leaves the events
        // without a checkpoint rather than a checkpoint covering a gap.
        if let Some((value, sequence)) = checkpoint {
            lines.push(format_raw(&sequence, "ckp", value));
        }
        for (sequence, event) in events {
            lines.push(format_raw(sequence, "ev", event));
        }
        let borrowed: Vec<&[u8]> = lines.iter().map(Vec::as_slice).collect();
        self.log.append(&borrowed)
    }

    pub fn sync(&mut self) -> JsonlResult<()> {
        self.log.sync()
    }

    /// The newest checkpoint and every event after it.
    pub fn load(root: &Path, loop_id: &str) -> JsonlResult<Option<Journal>> {
        let path = loop_journal_path(root, loop_id)?;
        let frames = super::seglog::read_all(&path)?;
        if frames.is_empty() {
            return Ok(None);
        }
        let mut checkpoint: Option<(Vec<u8>, u64)> = None;
        let mut events: Vec<(u64, Vec<u8>)> = Vec::new();
        for (_, payload) in frames {
            let value: serde_json::Value = serde_json::from_slice(&payload)?;
            let sequence = value["seq"].as_u64().unwrap_or_default();
            match value["t"].as_str() {
                Some("ckp") => {
                    checkpoint = Some((serde_json::to_vec(&value["v"])?, sequence));
                    events.clear();
                }
                Some("ev") => events.push((sequence, serde_json::to_vec(&value["e"])?)),
                _ => {}
            }
        }
        let Some((checkpoint, checkpoint_sequence)) = checkpoint else {
            return Ok(None);
        };
        Ok(Some(Journal {
            checkpoint,
            events: events.into_iter().map(|(_, event)| event).collect(),
            checkpoint_sequence,
        }))
    }
}

fn format_raw(sequence: &u64, tag: &str, raw: &RawValue) -> Vec<u8> {
    let key = if tag == "ckp" { "v" } else { "e" };
    format!("{{\"t\":\"{tag}\",\"seq\":{sequence},\"{key}\":{raw}}}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_newest_checkpoint_wins_and_later_events_follow() {
        let root = std::env::temp_dir().join(format!("synax-loop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let first: Box<RawValue> =
            serde_json::value::to_raw_value(&serde_json::json!({"version": 1, "sequence": 0}))
                .unwrap();
        let second: Box<RawValue> =
            serde_json::value::to_raw_value(&serde_json::json!({"version": 1, "sequence": 2}))
                .unwrap();
        let event = |n: u64| -> Box<RawValue> {
            serde_json::value::to_raw_value(&serde_json::json!({"sequence": n, "loopId": "l"}))
                .unwrap()
        };
        let mut journal = LoopJournal::open(&root, "l").unwrap();
        journal
            .append(Some((&first, 0)), &[(1, &event(1)), (2, &event(2))])
            .unwrap();
        journal
            .append(Some((&second, 2)), &[(3, &event(3))])
            .unwrap();
        journal.sync().unwrap();

        let loaded = LoopJournal::load(&root, "l").unwrap().unwrap();
        assert_eq!(loaded.checkpoint_sequence, 2);
        assert_eq!(loaded.events.len(), 1);
        let checkpoint: serde_json::Value = serde_json::from_slice(&loaded.checkpoint).unwrap();
        assert_eq!(checkpoint["sequence"], 2);
        std::fs::remove_dir_all(root).unwrap();
    }
}
