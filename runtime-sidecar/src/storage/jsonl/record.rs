//! The single record codec.
//!
//! Every byte that reaches a segment file is produced here. Records are
//! serialized with serde straight into a reusable buffer — no hand-built JSON,
//! no `Value` round-trip on the hot path.

use serde::Serialize;
use serde_json::value::RawValue;

use crate::runtime::input_queue::QueueState;
use crate::runtime::projection::UiSnapshot;
use crate::runtime::session_types::ControlState;

/// A borrowed JSON value already serialized as text (an event payload).
pub type RawJson = Box<RawValue>;

/// Scalar session state; `Clone` is a handful of words.
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
pub struct SnapshotCond {
    pub epoch: u64,
    pub revision: u64,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_run_id: Option<String>,
    pub cursor: u64,
    pub retained_from: u64,
    pub history_cursor: u64,
    pub history_watermark: u64,
    #[serde(default)]
    pub producer_sequences: std::collections::BTreeMap<String, u64>,
    #[serde(default)]
    pub history_generation: u64,
    /// The header the session-list row carries (the projection's `session`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<serde_json::Value>,
}

/// The full session snapshot written by seeding and by compaction.
#[derive(Debug, Serialize, serde::Deserialize)]
pub struct SnapshotBody {
    pub id: String,
    pub header: serde_json::Value,
    pub state: SnapshotCond,
    pub projection: UiSnapshot,
}

/// A stream event frame.
#[derive(Debug, Serialize, serde::Deserialize)]
pub struct EventRecord {
    /// Session stream sequence, contiguous from 1.
    pub s: u64,
    pub r: String,
    pub k: String,
    /// The `schema:1` payload, stored as-is.
    pub p: serde_json::Value,
}

/// A receipt frame: the durable answer to one request id.
#[derive(Debug, Serialize, serde::Deserialize)]
pub struct ReceiptRecord {
    pub sc: String,
    pub id: String,
    pub f: String,
    pub at: u64,
    pub r: serde_json::Value,
}

/// One entry of a seal's coverage table.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Coverage {
    /// Segment directory number.
    pub d: u64,
    /// File kind within the directory.
    pub k: u8,
    /// Byte offset that this commit extends the file to.
    pub o: u64,
    /// Frame count that this commit extends the file to.
    pub n: u64,
}

/// The commit point of one batch across every file it touched.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct SealRecord {
    pub c: u64,
    pub g: Vec<Coverage>,
    pub snap: SnapshotCond,
}

/// Session-list row for the root index.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct ListRecord {
    pub s: String,
    pub u: String,
    pub h: serde_json::Value,
    #[serde(default)]
    pub del: bool,
}

/// The newest committed extent of one session, for the hot path to check
/// whether what it has in memory is still what the disk holds.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct IndexRecord {
    pub s: String,
    pub c: u64,
    pub d: u64,
    pub so: u64,
    pub sf: u64,
    pub u: String,
    pub h: serde_json::Value,
    pub m: u64,
    pub state: SnapshotCond,
    #[serde(default)]
    pub deleted: bool,
}

/// Every record kind on disk, tagged by `t` as the first key.
#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(tag = "t")]
pub enum Record {
    #[serde(rename = "delta_v2")]
    Delta {
        c: u64,
        changes: Vec<super::delta::Change>,
    },
    #[serde(rename = "commit_v2")]
    Commit { c: u64, g: Vec<Coverage> },
    #[serde(rename = "receipt_v2")]
    CompactReceipt(ReceiptRecord),
    #[serde(rename = "snapshot")]
    Snapshot(SnapshotBody),
    #[serde(rename = "cond")]
    Cond(SnapshotCond),
    #[serde(rename = "cursor")]
    Cursor { c: u64, cur: u64 },
    #[serde(rename = "control")]
    Control {
        c: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        ctl: Option<ControlState>,
        #[serde(skip_serializing_if = "Option::is_none")]
        queue: Option<QueueState>,
    },
    #[serde(rename = "event")]
    Event(EventRecord),
    #[serde(rename = "receipt")]
    Receipt(ReceiptRecord),
    #[serde(rename = "seal")]
    Seal(SealRecord),
    #[serde(rename = "list")]
    List(ListRecord),
    /// Root-level row: in-memory only, never written to a session segment.
    #[serde(rename = "index")]
    Index(IndexRecord),
    /// History segment records (the history store's own file family).
    #[serde(rename = "history_object")]
    HistoryObject(crate::storage::jsonl::history::HistoryObject),
    #[serde(rename = "history_head")]
    HistoryHead(crate::storage::jsonl::history::HistoryHead),
    #[serde(rename = "history_entities")]
    HistoryEntities(crate::storage::jsonl::history::HistoryEntities),
    #[serde(rename = "history_receipt")]
    HistoryReceipt(crate::storage::jsonl::history::HistoryReceipt),
    #[serde(rename = "history_aux")]
    HistoryAux(crate::storage::jsonl::history::AuxRecord),
    #[serde(rename = "history_seal")]
    HistorySeal { c: u64 },
}

/// Reusable serializer for hot-path writes.
pub struct LineWriter {
    buffer: Vec<u8>,
}

impl LineWriter {
    pub fn new() -> Self {
        Self {
            buffer: Vec::with_capacity(8 * 1024),
        }
    }

    /// Serialize one record and return the bytes. The buffer is reused, so the
    /// returned slice is valid only until the next call.
    pub fn line(&mut self, record: &Record) -> &[u8] {
        self.buffer.clear();
        serde_json::to_writer(&mut self.buffer, record).expect("records serialize infallibly");
        &self.buffer
    }
}

impl Default for LineWriter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(bytes: &[u8]) -> serde_json::Value {
        serde_json::from_slice(bytes).unwrap()
    }

    #[test]
    fn every_record_is_tagged_first() {
        let mut writer = LineWriter::new();
        let line = writer.line(&Record::Event(EventRecord {
            s: 7,
            r: "run".into(),
            k: "message_delta".into(),
            p: serde_json::json!({"schema": 1}),
        }));
        let value = parse(line);
        assert_eq!(value["t"], "event");
        assert_eq!(value["s"], 7);
        assert_eq!(value["p"]["schema"], 1);
        assert_eq!(value.as_object().unwrap().keys().next().unwrap(), "t");

        let line = parse(writer.line(&Record::Cursor { c: 3, cur: 42 }));
        assert_eq!(line["t"], "cursor");
        assert_eq!(line["cur"], 42);
    }

    #[test]
    fn a_seal_round_trips_through_disk_shape() {
        let seal = Record::Seal(SealRecord {
            c: 11,
            g: vec![Coverage {
                d: 0,
                k: 1,
                o: 4096,
                n: 12,
            }],
            snap: SnapshotCond {
                cursor: 12,
                retained_from: 1,
                ..Default::default()
            },
        });
        let text = serde_json::to_string(&seal).unwrap();
        let back: Record = serde_json::from_str(&text).unwrap();
        match back {
            Record::Seal(seal) => {
                assert_eq!(seal.g[0].n, 12);
                assert_eq!(seal.snap.cursor, 12);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_unknown_tag_is_a_parse_error() {
        assert!(serde_json::from_str::<Record>(r#"{"t":"nope"}"#).is_err());
    }
}
