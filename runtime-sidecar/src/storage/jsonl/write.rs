//! One commit across every file a batch touches.
//!
//! A `SessionWriter` owns the open segment per file family, appends the batch's
//! frames, and finishes with a Seal that names the exact byte/frame extent each
//! file was extended to. Recovery only trusts frames covered by the newest Seal,
//! so a batch that never reached its seal is invisible.

use std::path::{Path, PathBuf};

use super::error::JsonlResult;
use super::layout;
use super::record::{Coverage, Record, SealRecord, SnapshotCond};
use super::seglog::SegLog;

/// Segment file families inside a session directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Controls = 0,
    Events = 1,
    Seal = 2,
}

impl Kind {
    pub const ALL: [Kind; 3] = [Kind::Controls, Kind::Events, Kind::Seal];

    fn file_prefix(self) -> &'static str {
        match self {
            Kind::Controls => "ctls",
            Kind::Events => "evts",
            Kind::Seal => "clse",
        }
    }

    pub fn from_index(index: u8) -> Option<Kind> {
        Kind::ALL.iter().copied().find(|kind| *kind as u8 == index)
    }
}

/// Frames per file before rolling into the next number.
pub const FRAMES_PER_SEGMENT: u64 = 16 * 1024;
/// Bytes per file before rolling into the next number.
pub const BYTES_PER_SEGMENT: u64 = 16 * 1024 * 1024;

pub struct SessionWriter {
    dir: PathBuf,
    logs: [SegLog; 3],
    /// Files written since the last durable sync.
    unsynced: bool,
}

impl SessionWriter {
    /// Open every family in the newest segment directory of `session_dir`.
    pub fn open(session_dir: &Path, segment: u64) -> JsonlResult<Self> {
        let dir = layout::segment_dir(session_dir, segment);
        let mut logs = [
            SegLog::open(&dir.join(format!("{}.000000", Kind::Controls.file_prefix())))?,
            SegLog::open(&dir.join(format!("{}.000000", Kind::Events.file_prefix())))?,
            SegLog::open(&dir.join(format!("{}.000000", Kind::Seal.file_prefix())))?,
        ];
        // A previous process may have died between the data append and the
        // seal. Whatever sits past the newest seal is not a commit.
        let latest = newest_seal(logs[Kind::Seal as usize].path())?;
        let covered = sealed_coverage(&mut logs, latest)?;
        let mut writer = Self {
            dir,
            logs,
            unsynced: false,
        };
        writer.truncate_to(&covered)?;
        Ok(writer)
    }

    pub fn segment(&self) -> u64 {
        self.dir
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.parse().ok())
            .unwrap_or(0)
    }

    pub fn events_log(&self) -> &SegLog {
        &self.logs[Kind::Events as usize]
    }

    /// Append a batch and seal it. Returns the new commit id.
    pub fn commit(
        &mut self,
        commit: u64,
        controls: &[&[u8]],
        events: &[&[u8]],
        snap: SnapshotCond,
    ) -> JsonlResult<()> {
        self.logs[Kind::Controls as usize].append(controls)?;
        self.logs[Kind::Events as usize].append(events)?;
        let coverage: Vec<Coverage> = Kind::ALL
            .iter()
            .filter(|kind| **kind != Kind::Seal)
            .map(|kind| {
                let log = &self.logs[*kind as usize];
                Coverage {
                    d: self.segment(),
                    k: *kind as u8,
                    o: log.len(),
                    n: log.frames(),
                }
            })
            .collect();
        let mut seal = Vec::with_capacity(256);
        serde_json::to_writer(
            &mut seal,
            &Record::Seal(SealRecord {
                c: commit,
                g: coverage,
                snap,
            }),
        )?;
        self.logs[Kind::Seal as usize].append(&[&seal])?;
        self.unsynced = true;
        Ok(())
    }

    /// Whether any batch is waiting for a durable sync.
    pub fn needs_sync(&self) -> bool {
        self.unsynced
    }

    /// Force every written frame to stable media.
    pub fn sync(&mut self) -> JsonlResult<()> {
        for log in &mut self.logs {
            log.sync()?;
        }
        self.unsynced = false;
        Ok(())
    }

    /// Whether this writer has outgrown its segment directory.
    pub fn should_roll(&self) -> bool {
        self.logs[Kind::Events as usize].frames() >= FRAMES_PER_SEGMENT
            || self.logs[Kind::Events as usize].len() >= BYTES_PER_SEGMENT
    }

    fn truncate_to(
        &mut self,
        covered: &std::collections::HashMap<u8, (u64, u64)>,
    ) -> JsonlResult<()> {
        for kind in [Kind::Controls, Kind::Events] {
            let Some((offset, frames)) = covered.get(&(kind as u8)).copied() else {
                continue;
            };
            let log = &mut self.logs[kind as usize];
            if log.len() > offset {
                log.truncate(offset, frames)?;
            }
        }
        Ok(())
    }
}

/// The seal with the largest commit id in the new segment directory.
fn newest_seal(path: &Path) -> JsonlResult<Option<SealRecord>> {
    let mut newest: Option<SealRecord> = None;
    for (_, payload) in super::seglog::read_all(path)? {
        if let Ok(Record::Seal(seal)) = serde_json::from_slice::<Record>(&payload)
            && newest.as_ref().is_none_or(|current| seal.c > current.c)
        {
            newest = Some(seal);
        }
    }
    Ok(newest)
}

/// Coverage that the newest seal of *this* directory commits to.
fn sealed_coverage(
    logs: &mut [SegLog; 3],
    newest: Option<SealRecord>,
) -> JsonlResult<std::collections::HashMap<u8, (u64, u64)>> {
    if let Some(seal) = newest {
        return Ok(seal
            .g
            .into_iter()
            .map(|entry| (entry.k, (entry.o, entry.n)))
            .collect());
    }
    // No seal at all in this directory: nothing in it is committed.
    for log in logs.iter_mut() {
        if log.len() > 0 {
            log.truncate(0, 0)?;
        }
    }
    Ok(std::collections::HashMap::new())
}

/// Segment number that a newly created session starts at.
pub const FIRST_SEGMENT: u64 = 0;

/// The directory number a segment belongs to.
pub fn directory_of(segment: u64) -> u64 {
    segment
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::jsonl::seglog::MAX_FRAME;

    fn dir(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("synax-write-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn state(cursor: u64) -> SnapshotCond {
        SnapshotCond {
            cursor,
            retained_from: 1,
            ..Default::default()
        }
    }

    #[test]
    fn a_sealed_batch_survives_reopen() {
        let root = dir("sealed");
        let mut writer = SessionWriter::open(&root, 0).unwrap();
        writer
            .commit(
                1,
                &[b"{\"t\":\"cond\"}"],
                &[b"{\"t\":\"event\",\"s\":1}"],
                state(1),
            )
            .unwrap();
        writer
            .commit(2, &[], &[b"{\"t\":\"event\",\"s\":2}"], state(2))
            .unwrap();
        writer.sync().unwrap();
        drop(writer);

        let mut reopened = SessionWriter::open(&root, 0).unwrap();
        assert_eq!(reopened.events_log().frames(), 2);
        reopened
            .commit(3, &[], &[b"{\"t\":\"event\",\"s\":3}"], state(3))
            .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_unsealed_tail_is_discarded_on_reopen() {
        let root = dir("unsealed");
        let mut writer = SessionWriter::open(&root, 0).unwrap();
        writer
            .commit(1, &[], &[b"{\"t\":\"event\",\"s\":1}"], state(1))
            .unwrap();
        // Simulate a crash after the data append but before the seal.
        let events = layout::segment_dir(&root, 0).join("evts.000000");
        let mut raw = std::fs::OpenOptions::new()
            .append(true)
            .open(&events)
            .unwrap();
        use std::io::Write;
        raw.write_all(&[9, 0, 0, 0]).unwrap();
        raw.write_all(b"{\"t\":\"ev").unwrap();
        drop(raw);

        let reopened = SessionWriter::open(&root, 0).unwrap();
        assert_eq!(reopened.events_log().frames(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn frames_without_any_seal_are_not_committed() {
        let root = dir("noseal");
        let mut writer = SessionWriter::open(&root, 0).unwrap();
        writer
            .commit(1, &[], &[b"{\"t\":\"event\",\"s\":1}"], state(1))
            .unwrap();
        std::fs::remove_dir_all(layout::segment_dir(&root, 0)).unwrap();
        std::fs::create_dir_all(layout::segment_dir(&root, 0)).unwrap();
        let events = layout::segment_dir(&root, 0).join("evts.000000");
        std::fs::write(&events, [7u8, 0, 0, 0, b'{', b'}', b'{', b'}', b'{']).unwrap();
        let reopened = SessionWriter::open(&root, 0).unwrap();
        assert_eq!(reopened.events_log().frames(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn max_frame_is_respected() {
        assert_eq!(MAX_FRAME, 4 * 1024 * 1024);
    }
}

/// One frame ready to be written: which family and which segment number.
#[derive(Debug, Clone)]
pub struct Slot {
    pub kind: Kind,
    pub segment: u64,
    pub payload: Vec<u8>,
}

/// The result of one pipeline commit: what each family now extends to.
#[derive(Debug, Clone)]
pub struct Extent {
    pub offsets: [u64; 3],
    pub frames: [u64; 3],
}

/// A commit that may span directory rolls.
pub struct CommitPlan {
    pub seal: Vec<u8>,
    pub seal_sequence: u64,
    /// Non-seal frames grouped by segment number, in write order.
    pub data: Vec<(u64, Vec<Slot>)>,
    pub extents: Extent,
}

/// First segment number that belongs to a segment directory.
pub fn first_segment_of_directory(directory: u64) -> u64 {
    directory
}

/// The coverage table of a seal, for the newest `Seal` of a directory.
pub fn seal_coverage(path: &std::path::Path) -> JsonlResult<Option<SealRecord>> {
    let mut newest: Option<SealRecord> = None;
    for (_, payload) in super::seglog::read_all(path)? {
        if let Ok(Record::Seal(seal)) = serde_json::from_slice::<Record>(&payload)
            && newest.as_ref().is_none_or(|current| seal.c > current.c)
        {
            newest = Some(seal);
        }
    }
    Ok(newest)
}
