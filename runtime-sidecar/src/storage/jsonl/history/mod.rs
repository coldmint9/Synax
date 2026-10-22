//! Immutable runtime history storage.
//!
//! The hot store owns the live session fence and bounded replay window. This
//! store owns immutable transcript objects and named heads, so checkpoint,
//! fork, rollback and garbage collection never copy the full conversation.
//!
//! Storage substrate: one append-only [`AppendFile`] per session under
//! `<root>/sessions/<xx>/<id>/history/history.000000`. Every write appends
//! framed [`Record`]s, syncs once, then publishes a new in-memory index. Reads
//! take the published index from an [`ArcSwap`] and never wait for the writer.

mod checkpoint;
mod files;
mod json;
mod metadata;
mod ops;
mod sync;
mod wire;

#[cfg(test)]
mod tests;

pub use ops::HistoryOps;
pub use wire::HistoryError;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use arc_swap::ArcSwap;
use parking_lot::Mutex;

use super::file::AppendFile;
use super::layout;
use super::record::Record;

/// The file inside `history/` that holds this session's history records.
pub const HISTORY_FILE: &str = "history-v2.000000";

/// Largest history object, measured as `(kind, value, refs)` JSON.
const MAX_OBJECT_BYTES: usize = 4 * 1024 * 1024;
const MAX_COMMAND_BYTES: usize = 8 * 1024 * 1024;
const MAX_BLOB_CHUNK_BYTES: usize = 256 * 1024;
const MAX_BLOB_CHUNKS: u64 = 1024;
const PAGE_LIMIT: usize = 256;
const PAGE_CURSOR_MAX_ITEMS: usize = 4096;
const ENTITY_PAGE_BYTES: usize = 768 * 1024;

/// The upper bound of a `BTreeMap` prefix scan.
fn map_end(prefix: &str) -> String {
    let mut end = prefix.to_owned();
    end.push(char::MAX);
    end
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryObject {
    pub object_id: String,
    pub kind: String,
    pub value: serde_json::Value,
    #[serde(default)]
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryHead {
    pub session_id: String,
    pub object_id: Option<String>,
    pub revision: u64,
    pub updated_at: String,
}

/// A committed command receipt: the identity of its input and its reply.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HistoryReceipt {
    pub key: String,
    pub identity: String,
    pub result: Vec<u8>,
}

/// The append that built revision `revision`: its root and index changes.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntities {
    pub session_id: String,
    pub revision: u64,
    #[serde(default)]
    pub updated_at: String,
    pub next_root: String,
    pub generation: u64,
    /// The newest value of each id in this append, in root (newest-first)
    /// order.
    pub changes: Vec<ChangeEntry>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub collection: String,
    pub object_id: String,
}

/// Non-object history state: heads, generations, receipts and ordered maps
/// (pins, assets, bindings, file state) keyed by opaque strings.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuxRecord {
    Head(HistoryHead),
    Generation(u64),
    /// The visible-index generation, used as the `history_sync` epoch.
    IndexGeneration(u64),
    Set(String, Option<serde_json::Value>),
    Receipt(HistoryReceipt),
    Gc(Vec<String>),
    #[serde(other)]
    Unknown,
}

impl Record {
    /// Serialize this record for an append file. Receipts are stored as their
    /// aux form so both spellings replay identically.
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Record::HistoryReceipt(receipt) => {
                serde_json::to_vec(&Record::HistoryAux(AuxRecord::Receipt(receipt.clone())))
                    .expect("records serialize")
            }
            other => serde_json::to_vec(other).expect("records serialize"),
        }
    }
}

/// The published, immutable view of one session's history.
#[derive(Clone)]
pub struct SessionIndex {
    /// The visible head (a rollback moves it without touching the window).
    pub head: HistoryHead,
    /// The live head revision (advances with every append).
    pub current_head_revision: u64,
    /// Visible entities ordered by `(collection, order key, id, owner)`.
    pub order: BTreeMap<String, Arc<HistoryObject>>,
    /// Identity key (`collection \0 owner \0 id`) -> order key.
    pub identity: HashMap<String, String>,
    /// Every object this session wrote, by id.
    pub objects: HashMap<String, Arc<HistoryObject>>,
    /// The idempotency/liveness generation (pins, files, metadata).
    pub generation: u64,
    /// Changes only when the visible index is rebuilt from another root.
    pub index_generation: u64,
    /// The root the visible index was materialized from.
    pub index_root: Option<String>,
    /// Newest-value change feed, ordered by `(revision, offset)`.
    pub changes: BTreeMap<(u64, usize), ChangeEntry>,
    /// Ordered auxiliary map: `pin`, `asset`, `binding`, `file` namespaced keys.
    pub aux: BTreeMap<String, Option<serde_json::Value>>,
    pub blobs: HashSet<String>,
    pub metadata_scope: Option<String>,
    pub metadata_generation: u64,
    pub receipts: HashMap<String, HistoryReceipt>,
}

impl SessionIndex {
    fn empty(session_id: &str) -> Self {
        let mut head = HistoryHead::default();
        head.session_id = session_id.to_owned();
        Self {
            head,
            current_head_revision: 0,
            order: BTreeMap::new(),
            identity: HashMap::new(),
            objects: HashMap::new(),
            generation: 0,
            index_generation: 0,
            index_root: None,
            changes: BTreeMap::new(),
            aux: BTreeMap::new(),
            blobs: HashSet::new(),
            metadata_scope: None,
            metadata_generation: 0,
            receipts: HashMap::new(),
        }
    }

    /// A private copy for a command that stages writes before committing.
    fn clone_index(index: &SessionIndex) -> SessionIndex {
        SessionIndex {
            head: index.head.clone(),
            current_head_revision: index.current_head_revision,
            order: index.order.clone(),
            identity: index.identity.clone(),
            objects: index.objects.clone(),
            generation: index.generation,
            index_generation: index.index_generation,
            index_root: index.index_root.clone(),
            changes: index.changes.clone(),
            aux: index.aux.clone(),
            blobs: index.blobs.clone(),
            metadata_scope: index.metadata_scope.clone(),
            metadata_generation: index.metadata_generation,
            receipts: index.receipts.clone(),
        }
    }

    /// Visible entities of one collection, ascending, newest version per id.
    pub fn entity_keys(&self, kind: &str) -> impl Iterator<Item = (&String, &Arc<HistoryObject>)> {
        let prefix = format!("{kind}\0");
        let identity_prefix = prefix.clone();
        self.order
            .range(prefix.clone()..map_end(&prefix))
            .take_while(move |(key, _)| key.starts_with(&prefix))
            .filter(move |(key, _)| self.is_newest(&identity_prefix, key))
    }

    /// The same set as [`Self::entity_keys`], newest first.
    pub fn entity_keys_rev(
        &self,
        kind: &str,
    ) -> impl Iterator<Item = (&String, &Arc<HistoryObject>)> {
        let prefix = format!("{kind}\0");
        let identity_prefix = prefix.clone();
        self.order
            .range(prefix.clone()..map_end(&prefix))
            .rev()
            .take_while(move |(key, _)| key.starts_with(&prefix))
            .filter(move |(key, _)| self.is_newest(&identity_prefix, key))
    }

    pub fn entity_keys_before(
        &self,
        kind: &str,
        before: Option<&str>,
    ) -> impl Iterator<Item = (&String, &Arc<HistoryObject>)> {
        let prefix = format!("{kind}\0");
        let upper = before
            .map(str::to_owned)
            .unwrap_or_else(|| map_end(&prefix));
        self.order.range(prefix..upper).rev()
    }

    /// Fold one committed record into the index during replay.
    pub fn apply(
        &mut self,
        record: Record,
        lookup: &mut dyn FnMut(&str) -> Option<Arc<HistoryObject>>,
    ) -> Result<(), HistoryError> {
        match record {
            Record::HistoryObject(object) => self.object_inserted(Arc::new(object)),
            Record::HistoryHead(head) => self.head = head,
            Record::HistoryEntities(entities) => {
                for (offset, change) in entities.changes.iter().enumerate() {
                    if let Some(object) = self
                        .objects
                        .get(&change.object_id)
                        .cloned()
                        .or_else(|| lookup(&change.object_id))
                    {
                        self.changes.insert(
                            (entities.revision, offset),
                            ChangeEntry {
                                collection: change.collection.clone(),
                                object_id: change.object_id.clone(),
                            },
                        );
                        // The append record carries this revision's deleted
                        // ids; re-applying every change makes an older object
                        // win over a newer one.
                        let identity = identity_key(
                            &change.collection,
                            &entities.session_id,
                            object.value["id"].as_str().unwrap_or_default(),
                        );
                        if !self.identity.contains_key(&identity) {
                            self.object_inserted(object);
                        }
                    }
                }
                self.current_head_revision = entities.revision;
                self.index_root = Some(entities.next_root.clone());
            }
            Record::HistoryReceipt(receipt) => {
                self.receipts.insert(receipt.key.clone(), receipt);
            }
            Record::HistoryAux(aux) => match aux {
                AuxRecord::Head(head) => {
                    self.index_root = head.object_id.clone();
                    self.head = head;
                }
                AuxRecord::Generation(generation) => self.generation = generation,
                AuxRecord::IndexGeneration(generation) => self.index_generation = generation,
                AuxRecord::Set(key, value) => {
                    self.aux.insert(key, value);
                }
                AuxRecord::Receipt(receipt) => {
                    self.receipts.insert(receipt.key.clone(), receipt);
                }
                AuxRecord::Gc(object_ids) => {
                    for object_id in object_ids {
                        self.objects.remove(&object_id);
                    }
                    self.order
                        .retain(|_, object| self.objects.contains_key(&object.object_id));
                    self.identity.retain(|_, key| self.order.contains_key(key));
                }
                AuxRecord::Unknown => {}
            },
            Record::HistorySeal { .. } | _ => {}
        }
        Ok(())
    }

    /// Set the visible head.
    pub fn set_head(&mut self, head: HistoryHead) {
        self.head = head;
    }

    /// Set the live head revision.
    pub fn set_current_head_revision(&mut self, revision: u64) {
        self.current_head_revision = revision;
    }

    /// Set the pin/file/metadata generation.
    pub fn set_generation(&mut self, generation: u64) {
        self.generation = generation;
    }

    /// Set the editability generation used by history-sync cursors.
    pub fn set_index_generation(&mut self, generation: u64) {
        self.index_generation = generation.max(self.index_generation);
    }

    /// Record the root the visible index was built from.
    pub fn set_index_root(&mut self, root: Option<String>) {
        self.index_root = root;
    }

    /// Set the per-scope metadata generation.
    pub fn set_metadata_generation(&mut self, revision: u64) {
        self.metadata_generation = revision;
    }

    /// Index one object as the newest version of its identity.
    pub fn object_inserted(&mut self, object: Arc<HistoryObject>) {
        self.objects
            .insert(object.object_id.clone(), object.clone());
        let Some(kind) = indexed_kind(&object.kind, &object.value) else {
            return;
        };
        let Some(owner) = object.value["sessionId"].as_str() else {
            return;
        };
        let Some(id) = object.value["id"].as_str() else {
            return;
        };
        let identity = identity_key(kind, owner, id);
        if let Some(previous) = self.identity.remove(&identity) {
            self.order.remove(&previous);
        }
        if object.kind == "runtime.tombstone" {
            return;
        }
        let key = order_key(kind, &object.value, id, owner);
        self.identity.insert(identity, key.clone());
        self.order.insert(key, object);
    }

    /// Rebuild the visible index by walking refs from `root`, newest first.
    /// The caller has already bumped the editability generation.
    pub fn rebuild(
        &mut self,
        root: &str,
        lookup: &mut dyn FnMut(&str) -> Option<Arc<HistoryObject>>,
    ) -> Result<(), HistoryError> {
        self.order.clear();
        self.identity.clear();
        let mut visited = HashSet::new();
        let mut pending = vec![root.to_owned()];
        while let Some(id) = pending.pop() {
            if !visited.insert(id.clone()) {
                continue;
            }
            let Some(object) = lookup(&id) else {
                return Err(HistoryError::ObjectMissing(id));
            };
            pending.extend(object.refs.iter().cloned());
            let Some(kind) = indexed_kind(&object.kind, &object.value) else {
                continue;
            };
            let Some(owner) = object.value["sessionId"].as_str() else {
                continue;
            };
            let Some(entity_id) = object.value["id"].as_str() else {
                continue;
            };
            let identity = identity_key(kind, owner, entity_id);
            // Refs are walked newest first, so the first value seen for an
            // identity is the one the rollback restores.
            if self.identity.contains_key(&identity) || object.kind == "runtime.tombstone" {
                continue;
            }
            let key = order_key(kind, &object.value, entity_id, owner);
            self.identity.insert(identity, key.clone());
            self.order.insert(key, object);
        }
        self.index_root = Some(root.to_owned());
        Ok(())
    }

    /// Set the current metadata scope.
    pub fn set_metadata_scope(&mut self, scope: String) {
        self.metadata_scope = Some(scope);
    }

    /// Resolve an object id against what this index holds.
    pub fn object(&self, object_id: &str) -> Option<Arc<HistoryObject>> {
        self.objects.get(object_id).cloned()
    }

    /// One auxiliary value by key.
    pub fn aux_value(&self, key: &str) -> Option<&serde_json::Value> {
        self.aux.get(key).and_then(Option::as_ref)
    }

    /// Auxiliary entries under `prefix`, ascending.
    pub fn aux_entries(&self, prefix: &str) -> impl Iterator<Item = (&String, &serde_json::Value)> {
        let start = prefix.to_owned();
        let end = map_end(prefix);
        self.aux
            .range(start..end)
            .filter_map(|(key, value)| value.as_ref().map(|value| (key, value)))
    }

    /// Whether `key` is the current version of its identity within `scope`.
    fn is_newest(&self, _scope: &str, key: &str) -> bool {
        // order contains only the newest version; object_inserted removes the
        // previous key atomically. Never scan every identity for each row.
        self.order.contains_key(key)
    }
}

/// The writable half of a session's history: the open append file and the
/// index it is being folded into.
pub struct SessionState {
    failed: bool,
    pub file: AppendFile,
    pub index: SessionIndex,
    pub published: Arc<ArcSwap<SessionIndex>>,
    checkpoint_offset: u64,
}

pub struct HistorySession {
    session_id: String,
    lock: Mutex<SessionState>,
    published: Arc<ArcSwap<SessionIndex>>,
}

impl HistorySession {
    pub fn open(root: &Path, session_id: &str) -> Result<Self, HistoryError> {
        let dir = layout::history_dir(&layout::session_dir(root, session_id).map_err(convert_io)?);
        let restored = checkpoint::read(&dir, session_id);
        let (mut index, start) = restored.unwrap_or_else(|| (SessionIndex::empty(session_id), 0));
        if start == 0 {
            replay_into(&dir.join("history.000000"), &mut index, true, 0).map_err(convert_io)?;
        }
        let path = dir.join(HISTORY_FILE);
        let committed = replay_into(&path, &mut index, false, start).map_err(convert_io)?;
        let file = AppendFile::open_committed(&path, committed).map_err(convert_io)?;
        let published = Arc::new(ArcSwap::from_pointee(index.clone()));
        Ok(Self {
            session_id: session_id.to_owned(),
            lock: Mutex::new(SessionState {
                failed: false,
                checkpoint_offset: start,
                file,
                index,
                published: published.clone(),
            }),
            published,
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn read(&self) -> arc_swap::Guard<Arc<SessionIndex>> {
        self.published.load()
    }
}

impl Drop for HistorySession {
    fn drop(&mut self) {
        if let Err(error) = checkpoint::save(self.lock.get_mut(), true) {
            tracing::warn!(event = "storage.history_checkpoint_failed", error = %error,
                "History index will be rebuilt from committed logs");
        }
    }
}

/// Read legacy and overlay history one frame at a time. A complete but
/// unsealed tail is never allowed into a later transaction after reopening.
fn replay_into(
    path: &Path,
    index: &mut SessionIndex,
    legacy: bool,
    start: u64,
) -> super::JsonlResult<u64> {
    let mut sealed = None;
    let complete = super::seglog::visit_complete_from(path, start, |offset, bytes| {
        if matches!(
            serde_json::from_slice::<Record>(bytes)?,
            Record::HistorySeal { .. }
        ) {
            sealed = Some(offset + bytes.len() as u64 + 4);
        }
        Ok(())
    })?;
    let end = sealed.unwrap_or(if legacy { complete } else { start });
    super::seglog::visit(path, start, end, |_, bytes| {
        let record = serde_json::from_slice(bytes)?;
        if !matches!(record, Record::HistorySeal { .. }) {
            apply_record(index, record);
        }
        Ok(())
    })?;
    Ok(end)
}

fn apply_record(index: &mut SessionIndex, record: Record) {
    let mut lookup = |_: &str| None;
    let _ = index.apply(record, &mut lookup);
}

fn entity_index_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "runtime.run" => Some("run"),
        "runtime.message" => Some("message"),
        "runtime.step" => Some("step"),
        "runtime.part" => Some("part"),
        "runtime.tool_call" => Some("tool"),
        "runtime.event" => Some("event"),
        "runtime.artifact" => Some("artifact"),
        "runtime.plan" => Some("plan"),
        "runtime.work" => Some("work"),
        "runtime.context" => Some("context"),
        "runtime.aux_usage" => Some("aux"),
        "runtime.thinking" => Some("thinking"),
        "runtime.compaction" => Some("compaction"),
        "runtime.permission" => Some("permission"),
        "runtime.interaction" => Some("interaction"),
        "runtime.file_change" => Some("file_change"),
        "runtime.terminal" => Some("terminal"),
        _ => None,
    }
}

fn indexed_kind(kind: &str, value: &serde_json::Value) -> Option<&'static str> {
    entity_index_kind(if kind == "runtime.tombstone" {
        value["entityKind"].as_str()?
    } else {
        kind
    })
}

/// Change-feed collections exposed by `history_sync` (the pagination index
/// additionally covers steps, plans, artifacts and the rest).
fn change_collection(kind: &str, value: &serde_json::Value) -> Option<&'static str> {
    match indexed_kind(kind, value)? {
        "message" => Some("messages"),
        "run" => Some("runs"),
        "step" => Some("steps"),
        "tool" => Some("toolCalls"),
        "event" => Some("events"),
        "permission" => Some("permissions"),
        _ => None,
    }
}

fn identity_key(kind: &str, owner: &str, id: &str) -> String {
    format!("{kind}\0{owner}\0{id}")
}

fn entity_order(kind: &str, value: &serde_json::Value) -> String {
    let number = match kind {
        "message" | "part" | "file_change" => value["sequence"].as_u64(),
        "plan" => value["revision"].as_u64(),
        _ => None,
    };
    if let Some(number) = number {
        return format!("0/{number:020}");
    }
    let timestamp = ["createdAt", "startedAt", "timestamp"]
        .iter()
        .find_map(|field| value[*field].as_str())
        .unwrap_or("");
    format!("1/{}", layout::hex(timestamp.as_bytes()))
}

fn order_key(kind: &str, value: &serde_json::Value, id: &str, owner: &str) -> String {
    format!("{}\0{}\0{}\0{}", kind, entity_order(kind, value), id, owner)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityCursor {
    pub session_id: String,
    pub kind: String,
    pub revision: u64,
    pub reverse: bool,
    pub after: String,
}

fn required_string<'a>(value: &'a serde_json::Value, key: &str) -> Result<&'a str, HistoryError> {
    value[key]
        .as_str()
        .filter(|item| !item.is_empty())
        .ok_or_else(|| HistoryError::InvalidCommand(format!("{key} is required")))
}

fn required_u64(value: &serde_json::Value, key: &str) -> Result<u64, HistoryError> {
    value[key]
        .as_u64()
        .ok_or_else(|| HistoryError::InvalidCommand(format!("{key} is required")))
}

fn validate_object_id(object_id: &str) -> Result<(), HistoryError> {
    let digest = object_id
        .strip_prefix("sha256:")
        .filter(|digest| digest.len() == 64)
        .ok_or_else(|| HistoryError::InvalidCommand("history object id is invalid".into()))?;
    if !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(HistoryError::InvalidCommand(
            "history object id is invalid".into(),
        ));
    }
    Ok(())
}

fn decode_hex(value: &str) -> Result<Vec<u8>, HistoryError> {
    if value.len() % 2 != 0 {
        return Err(HistoryError::InvalidCommand("blob chunk is not hex".into()));
    }
    let mut out = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks_exact(2) {
        let text = std::str::from_utf8(pair)
            .map_err(|_| HistoryError::InvalidCommand("blob chunk is not hex".into()))?;
        let byte = u8::from_str_radix(text, 16)
            .map_err(|_| HistoryError::InvalidCommand("blob chunk is not hex".into()))?;
        out.push(byte);
    }
    Ok(out)
}

fn encode_hex(bytes: &[u8]) -> String {
    layout::hex(bytes)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn convert_io(error: crate::storage::jsonl::error::JsonlError) -> HistoryError {
    HistoryError::InvalidCommand(error.to_string())
}

fn history_path(root: &Path, session_id: &str) -> Result<PathBuf, HistoryError> {
    Ok(layout::history_dir(
        &layout::session_dir(root, session_id).map_err(convert_io)?,
    ))
}
