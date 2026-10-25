//! One-pass, committed-prefix history copy. No per-entity RPC, full payload
//! array, or source writer lock while serializing the copied transcript.
use super::*;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use crate::storage::jsonl::{record::Record, seglog::frame_at};
use serde_json::json;

fn invalid(text: &str) -> HistoryError { HistoryError::InvalidCommand(text.into()) }

struct Remap {
    source: String,
    target: String,
    ids: HashMap<String, String>,
    objects: HashMap<String, String>,
}

impl Remap {
    fn value(&self, value: &mut Value, field: &str) {
        match value {
            Value::String(text) => {
                if field == "sessionId" || field == "rootSessionId" {
                    if text == &self.source { *text = self.target.clone(); }
                } else if !field.starts_with("forkedFrom") &&
                    (field == "id" || field == "refs" || field == "sourceRefs" || field.ends_with("Id") || field.ends_with("Ids") || field == "next_root" || field == "object_id") {
                    if let Some(mapped) = self.objects.get(text).or_else(|| self.ids.get(text)) { *text = mapped.clone(); }
                }
            }
            Value::Array(values) => { for value in values { self.value(value, field); } }
            Value::Object(values) => { for (field, value) in values { self.value(value, field); } }
            _ => {}
        }
    }

    fn record(&mut self, record: Record) -> Result<Option<Record>, HistoryError> {
        Ok(Some(match record {
            Record::HistoryObject(mut object) => {
                let original = object.object_id.clone();
                self.value(&mut object.value, "");
                // Runtime processes/approval tokens are not inherited by a
                // copied conversation. Keep the record, terminate its control.
                if matches!(object.kind.as_str(), "runtime.run" | "runtime.step") {
                    if matches!(object.value["status"].as_str(), Some("running" | "queued" | "waiting_input" | "waiting_permission")) {
                        object.value["status"] = json!("interrupted");
                    }
                    if let Some(metadata) = object.value["metadata"].as_object_mut() {
                        for key in ["executionLease", "recovery", "rustLoopId", "rustLoopSequence", "hostProcessId", "runtime"] { metadata.remove(key); }
                    }
                } else if object.kind == "runtime.permission" && object.value["action"] == "ask" {
                    object.value["action"] = json!("deny");
                    object.value["resumeToken"] = Value::Null;
                } else if object.kind == "runtime.interaction" {
                    object.value["status"] = json!("cancelled");
                    object.value["resumeToken"] = Value::Null;
                } else if object.kind == "runtime.tool_call" && matches!(object.value["status"].as_str(), Some("pending" | "running")) {
                    object.value["status"] = json!("cancelled");
                }
                for reference in &mut object.refs {
                    *reference = self.objects.get(reference).cloned().ok_or_else(|| invalid("fork source has a forward/missing object reference"))?;
                }
                object.object_id = format!("sha256:{}", layout::sha256_hex(&serialized(&(&object.kind, &object.value, &object.refs))?));
                self.objects.insert(original, object.object_id.clone());
                Record::HistoryObject(object)
            }
            Record::HistoryHead(mut head) => {
                head.session_id = self.target.clone();
                head.object_id = head.object_id.map(|id| self.objects.get(&id).cloned().ok_or_else(|| invalid("fork head missing"))).transpose()?;
                Record::HistoryHead(head)
            }
            Record::HistoryEntities(mut entities) => {
                entities.session_id = self.target.clone();
                entities.next_root = self.objects.get(&entities.next_root).cloned().ok_or_else(|| invalid("fork root missing"))?;
                for change in &mut entities.changes {
                    change.object_id = self.objects.get(&change.object_id).cloned().ok_or_else(|| invalid("fork change missing"))?;
                }
                Record::HistoryEntities(entities)
            }
            Record::HistoryAux(AuxRecord::Head(mut head)) => {
                head.session_id = self.target.clone();
                head.object_id = head.object_id.map(|id| self.objects.get(&id).cloned().ok_or_else(|| invalid("fork head missing"))).transpose()?;
                Record::HistoryAux(AuxRecord::Head(head))
            }
            Record::HistoryAux(AuxRecord::RebuildHead(mut head)) => {
                head.session_id = self.target.clone();
                head.object_id = head.object_id.map(|id| self.objects.get(&id).cloned().ok_or_else(|| invalid("fork head missing"))).transpose()?;
                Record::HistoryAux(AuxRecord::RebuildHead(head))
            }
            Record::HistoryAux(AuxRecord::TruncateHead(mut head)) => {
                head.session_id = self.target.clone();
                head.object_id = head.object_id.map(|id| self.objects.get(&id).cloned().ok_or_else(|| invalid("fork head missing"))).transpose()?;
                Record::HistoryAux(AuxRecord::TruncateHead(head))
            }
            Record::HistoryAux(AuxRecord::Set(mut key, mut value)) => {
                if key == "context\0active" || key.starts_with("file\0restore") || key.starts_with("file\0pending") || key.starts_with("file\0claim") || key.starts_with("file\0mutation") {
                    // A copy inherits historical outcomes, never an active
                    // executor or file restore transaction.
                    value = None;
                } else if let Some(value) = &mut value {
                    if key.starts_with("fork\0object\0") {
                        if let Some(id) = value.as_str().and_then(|id| self.objects.get(id)) { *value = json!(id); }
                    } else { self.value(value, ""); }
                }
                if let Some(id) = key.strip_prefix("context\0step-boundary\0") {
                    if let Some(mapped) = self.ids.get(id) { key = format!("context\0step-boundary\0{mapped}"); }
                }
                if let Some(id) = key.strip_prefix("pin\0") {
                    if let Some(mapped) = self.ids.get(id) { key = format!("pin\0{mapped}"); }
                    // Workspace choice is independent of transcript copying.
                    // A copied rollback pin cannot authorize restoration of
                    // source workspace paths or its old file before-images.
                    if let Some(pin) = &mut value { pin["metadata"]["transcriptOnly"] = json!(true); }
                }
                Record::HistoryAux(AuxRecord::Set(key, value))
            }
            Record::HistoryAux(AuxRecord::Gc(ids)) => Record::HistoryAux(AuxRecord::Gc(ids.into_iter().filter_map(|id| self.objects.get(&id).cloned()).collect())),
            // Old command receipts belong to source ownership. Copying them
            // could acknowledge target writes that were never performed.
            Record::HistoryReceipt(_) | Record::HistoryAux(AuxRecord::Receipt(_)) => return Ok(None),
            Record::HistoryAux(other) => Record::HistoryAux(other),
            Record::HistorySeal { c } => Record::HistorySeal { c },
            _ => return Err(invalid("unexpected non-history record in fork source")),
        }))
    }
}

fn write_record(file: &mut BufWriter<File>, record: &Record) -> Result<(), HistoryError> {
    let bytes = record.encode();
    if bytes.len() > crate::storage::jsonl::seglog::MAX_FRAME { return Err(invalid("fork record exceeds frame bounds")); }
    file.write_all(&(bytes.len() as u32).to_le_bytes())?;
    file.write_all(&bytes)?;
    Ok(())
}

impl HistoryTask {
    pub(super) fn fork_copy(&self, target_id: &str, request_id: &str, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let source_id = required_string(value, "sourceSessionId")?;
        if source_id == target_id { return Err(invalid("fork target must differ from source")); }
        let target = self.session(target_id)?;
        let receipt_key = receipt_key(target_id, request_id);
        let identity = receipt_identity(target_id, "fork_copy", value)?;
        {
            let mut guard = target.lock.lock();
            if guard.failed && guard.index.receipts.contains_key(&receipt_key) {
                File::open(history_path(self.root(), target_id)?)?.sync_all()?;
                guard.failed = false;
            }
            if guard.failed { return Err(invalid("fork target writer requires reopen")); }
            if let Some(receipt) = guard.index.receipts.get(&receipt_key) {
                if receipt.identity != identity { return Err(HistoryError::RequestConflict); }
                return Ok(receipt.result.clone());
            }
        }
        layout::validate_session_id(source_id).map_err(convert_io)?;
        let source = self.session(source_id)?;
        let pins = ResourcePins::new(history_path(self.root(), target_id)?.join(format!(".fork-pins-{}", uuid::Uuid::new_v4())))?;
        // Capture both the immutable index and committed file extent under a
        // short lock. An open file handle pins bytes even if source is deleted.
        let (source_index, file, length, legacy, resources) = {
            let guard = source.lock.lock();
            let head = &guard.index.head;
            if value["allowSourceChanges"] != true {
                let expected = required_u64(value, "expectedRevision")?;
                if expected != head.revision { return Err(HistoryError::RevisionConflict { expected, actual: head.revision }); }
            }
            if value["fullHistory"] != true {
            let pin = required_string(value, "checkpointId")?;
            let saved = guard.index.aux_value(&format!("pin\0{pin}")).ok_or_else(|| HistoryError::ObjectMissing(pin.into()))?;
            let message_id = saved["metadata"]["messageId"].as_str().ok_or_else(|| invalid("fork checkpoint has no message"))?;
            let key = super::super::identity_key("message", source_id, message_id);
            let boundary = guard.index.aux_value("context\0current").and_then(|v| v["throughRevision"].as_u64());
            if boundary.is_some_and(|boundary| guard.index.first_revision.get(&key).is_some_and(|r| *r <= boundary)) {
                return Err(HistoryError::ReadOnlyHistory);
            }
            }
            let path = history_path(self.root(), source_id)?.join("history.000000");
            let legacy = if path.exists() { let file = File::open(path)?; let length = file.metadata()?.len(); Some((file, length)) } else { None };
            let mut resources = Vec::new();
            let source_dir = history_path(self.root(), source_id)?;
            for name in ["blobs", "metadata"] {
                capture_resources(&source_dir.join(name), Path::new(name), &pins.0, &mut resources)?;
            }
            (guard.index.clone(), guard.file.handle(), guard.file.len(), legacy, resources)
        };
        let mut guard = target.lock.lock();
        layout::ensure_not_deleted(self.root(), target_id).map_err(convert_io)?;
        if let Some(receipt) = guard.index.receipts.get(&receipt_key) {
            if receipt.identity != identity { return Err(HistoryError::RequestConflict); }
            return Ok(receipt.result.clone());
        }
        if guard.index.order.values().any(|object| object.kind != "runtime.context"
            && !(object.kind == "runtime.event" && object.value["type"] == "session_started")) {
            return Err(invalid("fork target history must be empty"));
        }
        let directory = history_path(self.root(), target_id)?;
        let staging = directory.join(format!(".fork-{}", layout::sha256_hex(request_id.as_bytes())));
        // This request owns the target lock; stale partial data from exactly
        // this request is safe to discard and can never be a published target.
        if staging.exists() { fs::remove_dir_all(&staging)?; }
        fs::create_dir_all(&staging)?;
        let result = (|| {
            let mut remap = Remap { source: source_id.into(), target: target_id.into(), ids: HashMap::new(), objects: HashMap::new() };
            for object in source_index.objects.values() {
                if indexed_kind(&object.kind, &object.value).is_some() {
                    if let Some(id) = object.value["id"].as_str() {
                        remap.ids.entry(id.into()).or_insert_with(|| format!("fork_{}", &layout::sha256_hex(format!("{target_id}\0{id}").as_bytes())[..32]));
                    }
                }
            }
            for (key, _) in source_index.aux_entries("pin\0") {
                let id = key.trim_start_matches("pin\0");
                remap.ids.entry(id.into()).or_insert_with(|| format!("fork_{}", &layout::sha256_hex(format!("{target_id}\0{id}").as_bytes())[..32]));
            }
            let path = staging.join(super::super::HISTORY_FILE);
            let mut output = BufWriter::with_capacity(256 * 1024, File::create(&path)?);
            let mut copied_bytes = 0_u64;
            let mut copied_records = 0_u64;
            let mut copy = |file: &File, end: u64| -> Result<(), HistoryError> {
                let mut offset = 0;
                while offset < end {
                    let (bytes, next) = frame_at(file, offset, end).map_err(convert_io)?.ok_or_else(|| invalid("fork source contains an incomplete committed frame"))?;
                    if let Some(record) = remap.record(serde_json::from_slice(&bytes).map_err(|_| invalid("invalid fork source record"))?)? {
                        write_record(&mut output, &record)?;
                        copied_records += 1;
                    }
                    copied_bytes += next - offset;
                    offset = next;
                }
                Ok(())
            };
            if let Some((file, end)) = &legacy { copy(file, *end)?; }
            copy(&file, length)?;
            let mut final_head = source_index.head.clone();
            final_head.session_id = target_id.into();
            final_head.object_id = final_head.object_id.map(|id| remap.objects.get(&id).cloned().ok_or_else(|| invalid("fork final head missing"))).transpose()?;
            write_record(&mut output, &Record::HistoryAux(AuxRecord::RebuildHead(final_head)))?;
            // Summary text can still cite an original content hash. These
            // local aliases resolve that exact original object after source
            // deletion, with no cross-session lookup or authority transfer.
            for (old, new) in &remap.objects {
                write_record(&mut output, &Record::HistoryAux(AuxRecord::Set(format!("fork\0object\0{old}"), Some(json!(new)))))?;
            }
            let current = source_index.aux_value("context\0current").cloned().map(|mut v| { remap.value(&mut v, ""); v });
            write_record(&mut output, &Record::HistoryAux(AuxRecord::Set("context\0current".into(), current)))?;
            write_record(&mut output, &Record::HistoryAux(AuxRecord::Set("context\0active".into(), None)))?;
            let metadata = value.get("sessionMetadata").cloned().unwrap_or(Value::Null);
            let mut transformed_metadata = metadata;
            remap.value(&mut transformed_metadata, "");
            let result = serialized(&json!({"revision":source_index.head.revision,"objectCount":source_index.objects.len(),
                "sourceRevision":source_index.head.revision,"copiedBytes":copied_bytes,"copiedRecords":copied_records,
                "sessionMetadata":transformed_metadata}))?;
            write_record(&mut output, &Record::HistoryReceipt(HistoryReceipt { key: receipt_key, identity, result: result.clone() }))?;
            write_record(&mut output, &Record::HistorySeal { c: source_index.head.revision })?;
            output.flush()?;
            output.get_ref().sync_all()?;
            drop(output);
            for resource in &resources { copy_resource(resource, &staging)?; }
            for name in ["blobs", "metadata"] {
                if staging.join(name).exists() {
                    // New fork target has no history resources. If a previous
                    // failed attempt left resources, this request owns them.
                    if directory.join(name).exists() { fs::remove_dir_all(directory.join(name))?; }
                    fs::rename(staging.join(name), directory.join(name))?;
                }
            }
            // Validate and build the target index once, before publication.
            let mut index = SessionIndex::empty(target_id);
            let committed = super::super::replay_into(&path, &mut index, false, 0).map_err(convert_io)?;
            if committed != fs::metadata(&path)?.len() { return Err(invalid("fork copy has an uncommitted tail")); }
            let destination = directory.join(super::super::HISTORY_FILE);
            let mut replacement = crate::storage::jsonl::file::AppendFile::open_committed(&path, committed).map_err(convert_io)?;
            replacement.relocate(destination.clone());
            #[cfg(test)] if value["testFailBeforePublish"] == true { return Err(HistoryError::FileIo("injected publish failure".into())); }
            fs::rename(&path, destination)?;
            guard.file = replacement;
            guard.index = index;
            guard.checkpoint_offset = 0;
            guard.checkpoint_generation += 1;
            guard.published.store(Arc::new(guard.index.clone()));
            target.published.store(Arc::new(guard.index.clone()));
            #[cfg(unix)] if let Err(error) = File::open(&directory).and_then(|file| file.sync_all()) {
                guard.failed = true;
                return Err(error.into());
            }
            Ok(result)
        })();
        let cleanup = fs::remove_dir_all(&staging);
        match result { Err(error) => Err(error), Ok(result) => { cleanup?; Ok(result) } }
    }
}

struct ResourceExtent { relative: PathBuf, pinned: PathBuf, length: u64 }
struct ResourcePins(PathBuf);
impl ResourcePins {
    fn new(path: PathBuf) -> Result<Self, HistoryError> { fs::create_dir_all(&path)?; Ok(Self(path)) }
}
impl Drop for ResourcePins {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            tracing::warn!(event="storage.fork_pin_cleanup_failed",error_kind=?error.kind(),"Temporary resource pins will be cleaned on reopen");
        }
    }
}

/// Capture hard links and lengths while the source writer is fenced. Pinning
/// inode names keeps descriptors bounded even for thousands of attachments.
/// No resource contents are read under the source writer lock.
fn capture_resources(source: &Path, relative: &Path, pins: &Path, captured: &mut Vec<ResourceExtent>) -> Result<(), HistoryError> {
    let entries = match fs::read_dir(source) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() { return Err(invalid("fork resources cannot contain symlinks")); }
        let target = relative.join(entry.file_name());
        if kind.is_dir() { capture_resources(&entry.path(), &target, pins, captured)?; }
        else if kind.is_file() {
            let pinned = pins.join(&target);
            fs::create_dir_all(pinned.parent().ok_or_else(|| invalid("invalid resource pin"))?)?;
            fs::hard_link(entry.path(), &pinned)?;
            captured.push(ResourceExtent { relative: target, length: fs::metadata(&pinned)?.len(), pinned });
        }
    }
    Ok(())
}

fn copy_resource(resource: &ResourceExtent, staging: &Path) -> Result<(), HistoryError> {
    let target = staging.join(&resource.relative);
    fs::create_dir_all(target.parent().ok_or_else(|| invalid("invalid fork resource path"))?)?;
    // Prefer platform copy/COW for immutable blobs. A changed append extent
    // uses the bounded copy below so later source growth is never copied.
    let source = File::open(&resource.pinned)?;
    if source.metadata()?.len() == resource.length && fs::copy(&resource.pinned, &target).is_ok() {
        let file = fs::OpenOptions::new().write(true).open(&target)?;
        if file.metadata()?.len() < resource.length { return Err(invalid("fork resource was truncated")); }
        file.set_len(resource.length)?;
        file.sync_all()?;
        return Ok(());
    }
    let mut output = BufWriter::with_capacity(256 * 1024, File::create(&target)?);
    let mut buffer = [0_u8; 64 * 1024];
    let mut offset = 0;
    while offset < resource.length {
        let length = (resource.length - offset).min(buffer.len() as u64) as usize;
        source.read_exact_at(&mut buffer[..length], offset)?;
        output.write_all(&buffer[..length])?;
        offset += length as u64;
    }
    output.flush()?;
    output.get_ref().sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resource_snapshot_ignores_later_appends_and_survives_unlink() {
        let root = std::env::temp_dir().join(format!("fork-resource-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("source")).unwrap();
        fs::write(root.join("source/a"), b"committed").unwrap();
        let mut captured = Vec::new();
        let pins = ResourcePins::new(root.join("pins")).unwrap();
        capture_resources(&root.join("source"), Path::new("blobs"), &pins.0, &mut captured).unwrap();
        fs::OpenOptions::new().append(true).open(root.join("source/a")).unwrap().write_all(b"later").unwrap();
        fs::remove_dir_all(root.join("source")).unwrap();
        copy_resource(&captured[0], &root.join("target")).unwrap();
        assert_eq!(fs::read(root.join("target/blobs/a")).unwrap(), b"committed");
        drop(pins);
        fs::remove_dir_all(root).unwrap();
    }
}
