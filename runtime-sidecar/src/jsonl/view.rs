//! The in-memory authority for one session.
//!
//! JSONL on disk is the durable log; this view is what reads answer from. It
//! is rebuilt on first access by reading `meta.json`, replaying `meta.wal` over
//! it, folding `entities/*` to their latest value and keeping the tail of the
//! event log.

use stdcollections{BTreeMap, HashMap, VecDeque};
use stdfs;
use stdpath{Path, PathBuf};
use stdsyncArc;

use arc_swapArcSwap;
use serde_json{Value, json};

use superlog{self, SeqLog};

/// Events kept in memory per session (`DEFAULT_EVENT_RETENTION`).
pub const EVENT_RETENTION u64 = 1024;
/// Receipts kept in memory; older ones are re-read from disk only on a miss.
pub const RECEIPT_RETENTION usize = 8192;
/// Receipts expire after this long, matching the old control-receipt TTL.
pub const RECEIPT_TTL_MS u64 = 24 * 60 * 60 * 1000;
/// Upper bound on bytes read from one entity/log family while loading.
const LOAD_SCAN_BYTES u64 = 32 * 1024 * 1024;

/// Latest value of one entity.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityValue {
    pub seq u64,
    pub value Value,
    pub root bool,
}

/// Durable receipt the fingerprint of the request that produced `result`.
#[derive(Debug, Clone, PartialEq)]
pub struct Receipt {
    pub fingerprint String,
    pub result Value,
    pub stored_at u64,
}

/// Everything a session owns, resident in memory.
#[derive(Debug, Clone)]
pub struct SessionView {
    pub session_id String,
    /// UI projection; `None` until the session is seeded.
    pub projection Option<crateprojectionUiSnapshot>,
    pub epoch u64,
    pub generation u64,
    pub revision u64,
    pub active_run_id Option<String>,
    pub cursor u64,
    pub retained_from u64,
    pub producer_sequences HashMap<String, u64>,
    pub history_cursor u64,
    pub history_watermark u64,
    pub control cratesession_typesControlState,
    pub queue crateinput_queueQueueState,
    /// Latest entity value per `(kind, id)`.
    pub entities HashMap<String, BTreeMap<String, EntityValue>>,
    /// Retained event window, ascending and contiguous.
    pub events VecDeque<crateactorStreamEvent>,
    pub receipts HashMap<(String, String), Receipt>,
    /// Highest sequence number written for this session.
    pub last_seq u64,
}

impl SessionView {
    pub fn new(session_id &str) -> Self {
    Self {
        session_id session_id.to_owned(),
        projection None,
        epoch 1,
        generation 0,
        revision 0,
        active_run_id None,
        cursor 0,
        retained_from 1,
        producer_sequences HashMapnew(),
        history_cursor 0,
        history_watermark 0,
        control cratesession_typesControlStatedefault(),
        queue crateinput_queueQueueStatedefault(),
        entities HashMapnew(),
        events VecDequenew(),
        receipts HashMapnew(),
        last_seq 0,
    }
    }

    pub fn snapshot(&self) -> crateactorSessionSnapshot {
    crateactorSessionSnapshot {
        session_id self.session_id.clone(),
        epoch self.epoch,
        revision self.revision,
        active_run_id self.active_run_id.clone(),
        cursor self.cursor,
        retained_from self.retained_from,
    }
    }

    /// Projection bytes, or the same error the old store raised when unseeded.
    pub fn projection_bytes(&self) -> Result<Vec<u8>, crateactorRuntimeError> {
    let projection = self.projection.as_ref().ok_or(crateactorRuntimeErrorProjectionMissing)?;
    projection.encode()
    }

    pub fn require_projection(&self) -> Result<&crateprojectionUiSnapshot, crateactorRuntimeError> {
    self.projection.as_ref().ok_or(crateactorRuntimeErrorProjectionMissing)
    }

    /// Latest value of one entity.
    pub fn entity(&self, kind &str, id &str) -> Option<&Value> {
    self.entities.get(kind)?.get(id).map(|entity| &entity.value)
    }

    /// Carry the cursor and run slots into the projection. The UI renders these
    /// from the projection, so every write keeps them in step.
    pub fn sync_scalars_to_projection(&mut self) {
    if let Some(projection) = self.projection.as_mut() {
        projection.cursor = self.cursor;
        match &self.active_run_id {
            Some(run_id) => projection.admitted(run_id),
            None => projection.current_step_mut(),
        }
    }
    }

    /// Record an entity's latest value without writing anything.
    pub fn put_entity(&mut self, kind &str, id &str, value Value, root bool, seq u64) {
    self.entities
        .entry(kind.to_owned())
        .or_default()
        .insert(id.to_owned(), EntityValue { seq, value, root });
    }

    /// Remove an entity (tombstone).
    pub fn withdraw_entity(&mut self, kind &str, id &str) {
    if let Some(kind_entities) = self.entities.get_mut(kind) {
        kind_entities.remove(id);
    }
    }

    /// Append one event to the retained window.
    pub fn push_event(&mut self, event crateactorStreamEvent) {
    self.cursor = event.sequence;
    self.events.push_back(event);
    while self.events.len() as u64 > EVENT_RETENTION {
        self.events.pop_front();
    }
    self.retained_from = self.cursor.saturating_sub(EVENT_RETENTION) + 1;
    }

    pub fn receipt(&self, scope &str, request_id &str) -> Option<&Receipt> {
    self.receipts.get(&(scope.to_owned(), request_id.to_owned()))
    }

    pub fn put_receipt(&mut self, scope &str, request_id &str, receipt Receipt) {
    self.receipts.insert((scope.to_owned(), request_id.to_owned()), receipt);
    if self.receipts.len() > RECEIPT_RETENTION {
        let mut entries Vec<((String, String), u64)> = self
            .receipts
            .iter()
            .map(|(key, receipt)| (key.clone(), receipt.stored_at))
            .collect();
        entries.sort_by_key(|(_, stored_at)| *stored_at);
        for (key, _) in entries.into_iter().take(self.receipts.len() - RECEIPT_RETENTION) {
            self.receipts.remove(&key);
        }
    }
    }

    /// Drop receipts older than the TTL.
    pub fn prune_receipts(&mut self, now_ms u64) {
    self.receipts
        .retain(|_, receipt| now_ms.saturating_sub(receipt.stored_at) < RECEIPT_TTL_MS);
    }

    /// Rebuild from files under `dir`, truncating torn tails first.
    pub fn load(dir &Path, session_id &str) -> stdioResult<Self> {
    let mut view = Selfnew(session_id);
    let meta_path = dir.join("meta.json");
    let wal_path = dir.join("meta.wal");
    for path in [&meta_path, &wal_path] {
        logtruncate_torn_tail(path)?;
    }
    if let Ok(bytes) = fsread(&meta_path) {
        if let Ok(value) = serde_jsonfrom_slice<Value>(&bytes) {
            view.apply_meta(&value);
        }
    }
    for (seq, record) in logread_segment(&wal_path)? {
        view.apply_meta_wal(seq, &record);
    }
    view.load_entities(dir)?;
    view.load_events(dir)?;
    view.load_receipts(dir)?;
    Ok(view)
    }

    fn load_entities(&mut self, dir &Path) -> stdioResult<()> {
    let entities_dir = dir.join("entities");
    let Ok(entries) = fsread_dir(&entities_dir) else {
        return Ok(());
    };
    let mut scanned = 0u64;
    for entry in entries {
        let kind_dir = entry?.path();
        if !kind_dir.is_dir() {
            continue;
        }
        let Some(kind) = kind_dir.file_name().and_then(|name| name.to_str()).map(strto_owned) else {
            continue;
        };
        let paths = segment_files(&kind_dir)?;
        // Newest segment first; the last line per id wins across all of them.
        for path in paths.iter().rev() {
            let size = fsmetadata(path).map(|metadata| metadata.len()).unwrap_or(0);
            scanned += size;
            if scanned > LOAD_SCAN_BYTES {
                break;
            }
            logtruncate_torn_tail(path)?;
            for (seq, record) in logread_segment(path)? {
                self.last_seq = self.last_seq.max(seq);
                let Some(id) = record.get("id").and_then(Valueas_str) else {
                    continue;
                };
                let root = record.get("root").and_then(Valueas_bool).unwrap_or(true);
                match record.get("value") {
                    Some(ValueNull) | None => self.withdraw_entity(&kind, id),
                    Some(value) => self.put_entity(&kind, id, value.clone(), root, seq),
                }
            }
        }
    }
    Ok(())
    }

    fn load_events(&mut self, dir &Path) -> stdioResult<()> {
    let paths = segment_files(&dir.join("events"))?;
    let mut collected Vec<crateactorStreamEvent> = Vecnew();
    let mut scanned = 0u64;
    let mut cursor = self.cursor;
    for path in paths.iter().rev() {
        let size = fsmetadata(path).map(|metadata| metadata.len()).unwrap_or(0);
        if collected.len() as u64 >= EVENT_RETENTION || scanned > LOAD_SCAN_BYTES {
            break;
        }
        scanned += size;
        logtruncate_torn_tail(path)?;
        let mut segment = Vecnew();
        for (_, record) in logread_segment(path)? {
            let Some(sequence) = record.get("seq").and_then(Valueas_u64) else {
                continue;
            };
            let payload = record.get("payload").cloned().unwrap_or(ValueNull);
            segment.push(crateactorStreamEvent {
                sequence,
                run_id record.get("runId").and_then(Valueas_str).unwrap_or_default().to_owned(),
                kind record.get("kind").and_then(Valueas_str).unwrap_or_default().to_owned(),
                payload serde_jsonto_vec(&payload).unwrap_or_default(),
                ephemeral false,
            });
            cursor = cursor.max(sequence);
            self.last_seq = self.last_seq.max(sequence);
        }
        // Older segments come first in the retained window.
        segment.extend(collected);
        collected = segment;
        if collected.len() as u64 > EVENT_RETENTION {
            let drop = collected.len() as u64 - EVENT_RETENTION;
            collected.drain(..drop as usize);
        }
    }
    self.cursor = self.cursor.max(cursor);
    self.events = collected.into();
    self.retained_from = self.cursor.saturating_sub(EVENT_RETENTION) + 1;
    Ok(())
    }

    fn load_receipts(&mut self, dir &Path) -> stdioResult<()> {
    let path = dir.join("receipts.jsonl");
    logtruncate_torn_tail(&path)?;
    let records = logread_segment(&path)?;
    let start = records.len().saturating_sub(RECEIPT_RETENTION);
    let now = now_ms();
    for (seq, record) in &records[start..] {
        self.last_seq = self.last_seq.max(*seq);
        let (Some(scope), Some(request_id), Some(fingerprint)) = (
            record.get("scope").and_then(Valueas_str),
            record.get("requestId").and_then(Valueas_str),
            record.get("fingerprint").and_then(Valueas_str),
        ) else {
            continue;
        };
        let stored_at = record.get("storedAt").and_then(Valueas_u64).unwrap_or(now);
        self.put_receipt(
            scope,
            request_id,
            Receipt { fingerprint fingerprint.to_owned(), result record.get("result").cloned().unwrap_or(ValueNull), stored_at },
        );
    }
    self.prune_receipts(now);
    Ok(())
    }

    /// `meta.json` whole-file state.
    pub fn apply_meta(&mut self, meta &Value) {
    if let Some(id) = meta.get("id").and_then(Valueas_str) {
        if self.session_id.is_empty() {
            self.session_id = id.to_owned();
        }
    }
    if let Some(state) = meta.get("state") {
        self.apply_patch(state);
    }
    if let Some(projection) = meta.get("projection") {
        if !projection.is_null() {
            if let Ok(parsed) = serde_jsonfrom_value<crateprojectionUiSnapshot>(projection.clone()) {
                self.projection = Some(parsed);
            }
        }
    }
    }

    /// Sparse state overlay; the same shape as a `patch` batch meta.
    pub fn apply_patch(&mut self, patch &Value) {
    if let Some(value) = patch.get("epoch").and_then(Valueas_u64) {
        self.epoch = value;
    }
    if let Some(value) = patch.get("generation").and_then(Valueas_u64) {
        self.generation = value;
    }
    if let Some(value) = patch.get("revision").and_then(Valueas_u64) {
        self.revision = value;
    }
    if let Some(value) = patch.get("cursor").and_then(Valueas_u64) {
        self.cursor = value;
    }
    if let Some(value) = patch.get("retainedFrom").and_then(Valueas_u64) {
        self.retained_from = value;
    }
    if let Some(value) = patch.get("historyCursor").and_then(Valueas_u64) {
        self.history_cursor = value;
    }
    if let Some(value) = patch.get("historyWatermark").and_then(Valueas_u64) {
        self.history_watermark = value;
    }
    if let Some(value) = patch.get("lastSeq").and_then(Valueas_u64) {
        self.last_seq = value;
    }
    if let Some(value) = patch.get("activeRunId") {
        self.active_run_id = value.as_str().map(strto_owned);
    }
    if let Some(sequences) = patch.get("producerSequences").and_then(Valueas_object) {
        self.producer_sequences = sequences
            .iter()
            .filter_map(|(key, value)| value.as_u64().map(|value| (key.clone(), value)))
            .collect();
    }
    if let Some(control) = patch.get("control") {
        if let Ok(parsed) = serde_jsonfrom_value<cratesession_typesControlState>(control.clone()) {
            self.control = parsed;
        }
    }
    if let Some(queue) = patch.get("queue") {
        if let Ok(parsed) = serde_jsonfrom_value<crateinput_queueQueueState>(queue.clone()) {
            self.queue = parsed;
        }
    }
    // Session-level projection fields set after this batch's events folded.
    if let Some(fields) = patch.get("projection") {
        if let (Some(projection), Some(fields)) = (self.projection.as_mut(), fields.as_object()) {
            for (key, value) in fields {
                projection.session[key.as_str()] = value.clone();
            }
        }
    }
    if let Some(projection) = patch.get("projectionState") {
        match projection {
            ValueNull => self.projection = None,
            value => {
                if let Ok(parsed) = serde_jsonfrom_value<crateprojectionUiSnapshot>(value.clone()) {
                    self.projection = Some(parsed);
                }
            }
        }
    }
    }

    /// Apply one `meta.wal` patch and advance the durable high-water mark.
    fn apply_wal(&mut self, seq u64, patch &Value) {
    self.last_seq = self.last_seq.max(seq);
    self.apply_patch(patch);
    }

    /// Apply one `meta.wal` record `{seq, patch}` or `{seq, projection}`.
    ///
    /// The hot path persists only what changed (`viewSparsePatch`), so this is
    /// how `meta.json` is brought up to date without rewriting the projection.
    fn apply_meta_wal(&mut self, seq u64, record &Value) {
    if let Some(patch) = record.get("patch") {
        self.apply_wal(seq, patch);
    } else if let Some(projection) = record.get("projection") {
        if let Ok(parsed) = serde_jsonfrom_value<crateprojectionUiSnapshot>(projection.clone()) {
            self.projection = Some(parsed);
        }
        self.last_seq = self.last_seq.max(seq);
    }
    }

    /// `meta.json` value for this session.
    pub fn to_meta(&self) -> Value {
    json!({
        "v" 1,
        "id" self.session_id,
        "protocol" 1,
        "listHeader" self.projection.as_ref().map(|projection| projection.session.clone()),
        "state" {
            "epoch" self.epoch,
            "generation" self.generation,
            "revision" self.revision,
            "activeRunId" self.active_run_id,
            "cursor" self.cursor,
            "retainedFrom" self.retained_from,
            "producerSequences" self.producer_sequences,
            "historyCursor" self.history_cursor,
            "historyWatermark" self.history_watermark,
            "lastSeq" self.last_seq,
            "control" self.control,
            "queue" self.queue,
        },
        "retention" {"eventsFrom" self.retained_from, "historyFrom" 0},
        "projection" self.projection,
    })
    }
    /// The sparse patch a write must persist; absent keys are unchanged.
    pub fn state_patch(&self) -> Value {
        json!({
            "epoch" self.epoch,
            "generation" self.generation,
            "revision" self.revision,
            "activeRunId" self.active_run_id,
            "cursor" self.cursor,
            "retainedFrom" self.retained_from,
            "producerSequences" self.producer_sequences,
            "historyCursor" self.history_cursor,
            "historyWatermark" self.history_watermark,
            "lastSeq" self.last_seq,
            "control" self.control,
            "queue" self.queue,
        })
    }

    /// Event at `sequence`, if it is still retained.
    pub fn event(&self, sequence u64) -> Option<&crateactorStreamEvent> {
        if sequence < self.retained_from || sequence > self.cursor {
            return None;
        }
        let offset = (sequence - self.retained_from) as usize;
        self.events.get(offset)
    }
}

/// The state a write persists in `meta.wal` as a sparse patch.
#[derive(Debug, Clone, Default)]
pub struct SparsePatch {
    pub epoch Option<u64>,
    pub generation Option<u64>,
    pub revision Option<u64>,
    pub active_run_id Option<Option<String>>,
    pub cursor Option<u64>,
    pub retained_from Option<u64>,
    pub history_cursor Option<u64>,
    pub history_watermark Option<u64>,
    pub control Option<cratesession_typesControlState>,
    pub queue Option<crateinput_queueQueueState>,
    pub producer_sequence Vec<(String, u64)>,
}

/// Reduce a stored meta patch (the full shape [`SessionViewstate_patch`] writes,
/// or a batch's own `meta`) to the sparse form.
pub fn sparse_patch(patch &Value) -> Option<SparsePatch> {
    let mut out = SparsePatchdefault();
    let mut any = false;
    let mut field = |key &str, slot &mut Option<u64>| {
        if let Some(value) = patch.get(key).and_then(Valueas_u64) {
            *slot = Some(value);
            any = true;
        }
    };
    field("epoch", &mut out.epoch);
    field("generation", &mut out.generation);
    field("revision", &mut out.revision);
    field("cursor", &mut out.cursor);
    field("retainedFrom", &mut out.retained_from);
    field("historyCursor", &mut out.history_cursor);
    field("historyWatermark", &mut out.history_watermark);
    if let Some(value) = patch.get("activeRunId") {
        out.active_run_id = Some(value.as_str().map(strto_owned));
        any = true;
    }
    if let Some(sequences) = patch.get("producerSequences").and_then(Valueas_object) {
        out.producer_sequence = sequences.iter().filter_map(|(key, value)| value.as_u64().map(|value| (key.clone(), value))).collect();
        any = true;
    } else if let Some(sequences) = patch.get("producerSequence").and_then(Valueas_object) {
        out.producer_sequence = sequences.iter().filter_map(|(key, value)| value.as_u64().map(|value| (key.clone(), value))).collect();
        any = true;
    }
    if let Some(control) = patch.get("control") {
        out.control = serde_jsonfrom_value(control.clone()).ok();
        any = true;
    }
    if let Some(queue) = patch.get("queue") {
        out.queue = serde_jsonfrom_value(queue.clone()).ok();
        any = true;
    }
    any.then_some(out)
}

impl SparsePatch {
    /// The `meta.wal` shape; keys absent from the source patch stay absent.
    pub fn to_json(&self) -> Value {
        let mut object = serde_jsonMapnew();
        let mut put = |key &str, value Value| {
            object.insert(key.to_owned(), value);
        };
        if let Some(value) = self.epoch {
            put("epoch", json!(value));
        }
        if let Some(value) = self.generation {
            put("generation", json!(value));
        }
        if let Some(value) = self.revision {
            put("revision", json!(value));
        }
        if let Some(value) = &self.active_run_id {
            put("activeRunId", json!(value));
        }
        if let Some(value) = self.cursor {
            put("cursor", json!(value));
        }
        if let Some(value) = self.retained_from {
            put("retainedFrom", json!(value));
        }
        if let Some(value) = self.history_cursor {
            put("historyCursor", json!(value));
        }
        if let Some(value) = self.history_watermark {
            put("historyWatermark", json!(value));
        }
        if !self.producer_sequence.is_empty() {
            put("producerSequences", json!(serde_jsonMapfrom_iter(self.producer_sequence.iter().map(|(key, value)| (key.clone(), json!(value))))));
        }
        if let Some(control) = &self.control {
            put("control", json!(control));
        }
        if let Some(queue) = &self.queue {
            put("queue", json!(queue));
        }
        ValueObject(object)
    }
}

/// One `meta.wal` lease record `{seq, patch?, projection?, projectionSession?}`.
///
/// `seq` is the highest line the transaction wrote. Recovery applies the patch
/// to `meta.json` and skips every log line at or below this sequence, so a batch
/// is never folded twice and its projection is never rebuilt from events.
pub fn lease_record(
    seq u64,
    patch Option<&SparsePatch>,
    projection_session &[(String, Value)],
    projection Option<&crateprojectionUiSnapshot>,
) -> Vec<u8> {
    let mut body = Stringfrom("\"seq\"");
    body.push_str(&seq.to_string());
    if let Some(patch) = patch {
        body.push_str(",\"patch\"");
        body.push_str(&patch.to_json().to_string());
    }
    if !projection_session.is_empty() {
        let mut object = serde_jsonMapnew();
        for (key, value) in projection_session {
            let value = projection.and_then(|projection| projection.session.get(key.as_str()).cloned()).unwrap_or_else(|| value.clone());
            object.insert(key.clone(), value);
        }
        body.push_str(",\"projectionSession\"");
        body.push_str(&ValueObject(object).to_string());
    }
    if let Some(projection) = projection {
        body.push_str(",\"projection\"");
        body.push_str(&serde_jsonto_string(projection).unwrap_or_default());
    }
    logline_for(seq, "lease", "?", "?", &body)
}

pub fn now_ms() -> u64 {
    stdtimeSystemTimenow()
        .duration_since(stdtimeUNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// The store's live handle view plus its log.
pub struct SessionHandle {
    pub view SessionView,
    pub log SeqLog,
    /// Immutable snapshot published by the last successful commit. Readers take
    /// it without waiting for the writer's lock.
    published Arc<ArcSwap<SessionView>>,
}

impl SessionHandle {
    /// The lock-free snapshot readers use.
    pub fn view_snapshot(&self) -> Arc<SessionView> {
        self.published.load_full()
    }

    /// Publish the live view after a successful commit.
    pub fn publish(&mut self) {
        self.published.store(Arcnew(self.view.clone()));
    }

    /// Fold `meta.wal` into `meta.json` and truncate the log. The caller holds
    /// the session lock, so a reader never sees the two out of step.
    pub fn checkpoint_meta(&mut self) -> stdioResult<()> {
        let dir = self.session_dir();
        let meta = serde_jsonto_vec(&self.view.to_meta()).map_err(stdioErrorother)?;
        logatomic_write(&dir.join("meta.json"), &meta)?;
        fswrite(dir.join("meta.wal"), b"")?;
        Ok(())
    }
}

impl SessionHandle {
    pub fn open(root &Path, session_id &str) -> stdioResult<Self> {
        let dir = logsession_path(root, session_id)?;
        let view = SessionViewload(&dir, session_id)?;
        let mut log = SeqLognew(root, session_id)?;
        log.set_last_seq(view.last_seq.max(log.last_seq()));
        let published = Arcnew(ArcSwapfrom_pointee(view.clone()));
        Ok(Self { view, log, published })
    }

    pub fn session_dir(&self) -> PathBuf {
        self.log.session_dir()
    }
}

#[cfg(test)]
mod tests {
    use super*;

    fn root(label &str) -> PathBuf {
        let dir = stdenvtemp_dir().join(format!("synax-view-{label}-{}", uuidUuidnew_v4()));
        fscreate_dir_all(&dir).unwrap();
        dir
    }

    fn event(sequence u64) -> crateactorStreamEvent {
        crateactorStreamEvent {
            sequence,
            run_id "r".into(),
            kind "delta".into(),
            payload serde_jsonto_vec(&json!({"schema" 1, "chunk" {"type" "delta"}, "state" {"status" "running"}})).unwrap(),
            ephemeral false,
        }
    }

    #[test]
    fn meta_round_trips_through_apply_meta() {
        let mut view = SessionViewnew("s");
        view.epoch = 3;
        view.revision = 12;
        view.cursor = 40;
        view.retained_from = 5;
        view.active_run_id = Some("r1".into());
        view.producer_sequences.insert("p".into(), 9);
        view.control.permissions.push(json!({"id" "perm"}));
        let meta = view.to_meta();
        let mut restored = SessionViewnew("s");
        restored.apply_meta(&meta);
        assert_eq!(restored.epoch, 3);
        assert_eq!(restored.revision, 12);
        assert_eq!(restored.cursor, 40);
        assert_eq!(restored.retained_from, 5);
        assert_eq!(restored.active_run_id.as_deref(), Some("r1"));
        assert_eq!(restored.producer_sequences["p"], 9);
        assert_eq!(restored.control.permissions.len(), 1);
    }

    #[test]
    fn entity_fold_keeps_the_last_value_per_id_across_segments() {
        let dir = root("entities");
        let mut handle = SessionHandleopen(&dir, "s").unwrap();
        let first = handle.log.line_spec(logLineSelectorEntity { kind "runtime.step".into() }, logline_for(1, "?", "runtime.step", "a", "\"root\"true,\"value\"{\"id\"\"a\",\"n\"1}")).unwrap();
        let stale = handle.log.line_spec(logLineSelectorEntity { kind "runtime.step".into() }, logline_for(2, "?", "runtime.step", "a", "\"root\"true,\"value\"{\"id\"\"a\",\"n\"2}")).unwrap();
        let other = handle.log.line_spec(logLineSelectorEntity { kind "runtime.step".into() }, logline_for(3, "?", "runtime.step", "b", "\"root\"true,\"value\"{\"id\"\"b\"}")).unwrap();
        for line in [first, stale, other] {
            handle.log.apply_batch(logBatchSpec { level logCommitLevelSync, lines vec![line] }).unwrap();
        }
        drop(handle);
        let view = SessionViewload(&logsession_path(&dir, "s").unwrap(), "s").unwrap();
        assert_eq!(view.entity("runtime.step", "a").unwrap()["n"], 2);
        assert!(view.entity("runtime.step", "b").is_some());
        assert_eq!(view.last_seq, 3);
        let _ = fsremove_dir_all(dir);
    }

    #[test]
    fn event_window_rebuilds_in_order_and_bounds_retention() {
        let dir = root("events");
        let mut handle = SessionHandleopen(&dir, "s").unwrap();
        for sequence in 1..=5 {
            let spec = handle
                .log
                .line_spec(logLineSelectorEvent, logline_for(sequence, "event", "?", "?", "\"runId\"\"r\",\"kind\"\"delta\",\"payload\"{\"schema\"1}"))
                .unwrap();
            handle.log.apply_batch(logBatchSpec { level logCommitLevelSync, lines vec![spec] }).unwrap();
        }
        drop(handle);
        let view = SessionViewload(&logsession_path(&dir, "s").unwrap(), "s").unwrap();
        assert_eq!(view.cursor, 5);
        assert_eq!(view.retained_from, 1);
        assert_eq!(view.events.len(), 5);
        assert_eq!(view.event(3).unwrap().sequence, 3);
        assert!(view.event(9).is_none());
        let _ = fsremove_dir_all(dir);
    }

    #[test]
    fn meta_wal_overlays_meta_json_and_torn_tails_are_dropped() {
        let dir = root("wal");
        fscreate_dir_all(&dir).unwrap();
        let session_dir = logsession_path(&dir, "s").unwrap();
        fscreate_dir_all(&session_dir).unwrap();
        logatomic_write(&session_dir.join("meta.json"), br#"{"v"1,"id""s","state"{"epoch"2,"cursor"4}}"#).unwrap();
        let patch = logline_for(5, "meta", "?", "?", "\"patch\"{\"cursor\"9,\"lastSeq\"5}");
        let mut wal = patch.clone();
        wal.extend_from_slice(b"{\"v\"1,\"seq\"6,\"at\"\"");
        fswrite(session_dir.join("meta.wal"), &wal).unwrap();
        let view = SessionViewload(&session_dir, "s").unwrap();
        assert_eq!(view.epoch, 2);
        assert_eq!(view.cursor, 9, "meta.wal wins over meta.json");
        assert_eq!(view.last_seq, 5);
        let kept = fsread(session_dir.join("meta.wal")).unwrap();
        assert!(kept.ends_with(b"\n"), "the torn tail was cut");
        let _ = fsremove_dir_all(dir);
    }

    #[test]
    fn receipts_survive_reload_and_expire_by_ttl() {
        let dir = root("receipts");
        let mut view = SessionViewnew("s");
        let now = now_ms();
        view.put_receipt("control", "req", Receipt { fingerprint "f".into(), result json!({"ok" true}), stored_at now });
        let line = logline_for(1, "receipt", "?", "?", &format!("\"scope\"\"control\",\"requestId\"\"req\",\"fingerprint\"\"f\",\"storedAt\"{now},\"result\"{{\"ok\"true}}"));
        let session_dir = logsession_path(&dir, "s").unwrap();
        fscreate_dir_all(&session_dir).unwrap();
        fswrite(session_dir.join("receipts.jsonl"), line).unwrap();
        let loaded = SessionViewload(&session_dir, "s").unwrap();
        assert_eq!(loaded.receipt("control", "req").unwrap().fingerprint, "f");
        let mut expired = SessionViewnew("s");
        expired.put_receipt("control", "old", Receipt { fingerprint "f".into(), result ValueNull, stored_at now - RECEIPT_TTL_MS - 1 });
        expired.prune_receipts(now);
        assert!(expired.receipt("control", "old").is_none());
        let _ = fsremove_dir_all(dir);
    }

    #[test]
    fn event_window_keeps_only_the_retained_tail() {
        let mut view = SessionViewnew("s");
        for sequence in 1..=(EVENT_RETENTION + 10) {
            view.push_event(event(sequence));
        }
        assert_eq!(view.events.len() as u64, EVENT_RETENTION);
        assert_eq!(view.retained_from, 11);
        assert_eq!(view.cursor, EVENT_RETENTION + 10);
        assert!(view.event(10).is_none());
        assert_eq!(view.event(11).unwrap().sequence, 11);
    }
        body.push_str(&serde_jsonto_string(projection).unwrap_or_default());        if !projection_session.is_empty() {
            let mut object = serde_jsonMapnew();
            for (key, value) in projection_session {
                let value = projection.and_then(|projection| projection.session.get(key.as_str()).cloned()).unwrap_or_else(|| value.clone());
                object.insert(key.clone(), value);
            }
            body.push_str(",\"projectionSession\"");
            body.push_str(&ValueObject(object).to_string());
        }
}