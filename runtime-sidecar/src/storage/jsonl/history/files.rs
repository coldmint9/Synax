//! Native file before-images and mutation ownership. No SQL or Node snapshot
//! store: claims, counters, pending mutations and restore plans are history
//! records (`file` namespaced aux keys) and images are history blob chunks.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::json::{array, convert_value, number, object, text};
use super::wire::HistoryError;
use super::{HistoryObject, SessionIndex, encode_hex, now_iso, required_string, required_u64};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileVersion {
    kind: String,
    hash: String,
    mode: u32,
    size: u64,
    blob_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct FileChange {
    root: String,
    path: String,
    before: Option<FileVersion>,
    after: Option<FileVersion>,
    #[serde(default)]
    git: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mutation {
    id: String,
    session_id: String,
    source_session_id: String,
    sequence: u64,
    owner_pid: u32,
    state: String,
    untracked: bool,
    created_at: String,
    #[serde(default)]
    warning: Option<String>,
    roots: Vec<String>,
    changes: Vec<FileChange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Restore {
    session_id: String,
    request_id: String,
    checkpoint_id: String,
    target: String,
    expected_revision: u64,
    files: Vec<FileChange>,
    metadata: serde_json::Value,
    state: String,
}

const STREAM_CHUNK: usize = 256 * 1024;
const MAX_CAPTURE_BYTES: u64 = 256 * 1024 * 1024;
/// Images are read back through the same blob-chunk format.
const MAX_BLOB_CHUNKS: u64 = 1024;

fn same(a: &Option<FileVersion>, b: &Option<FileVersion>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.kind == b.kind && a.hash == b.hash && a.mode == b.mode,
        _ => false,
    }
}

fn invalid(message: &str) -> HistoryError {
    HistoryError::InvalidCommand(message.into())
}

fn busy(message: impl Into<String>) -> HistoryError {
    HistoryError::FileBusy(message.into())
}

fn io(error: std::io::Error) -> HistoryError {
    HistoryError::FileIo(error.to_string())
}

fn serialized<T: Serialize>(value: &T) -> Result<Vec<u8>, HistoryError> {
    serde_json::to_vec(value).map_err(|error| invalid(&format!("serialization: {error}")))
}

fn parse_mutation(value: &serde_json::Value) -> Result<Mutation, HistoryError> {
    serde_json::from_value(value.clone())
        .map_err(|error| invalid(&format!("serialization: {error}")))
}

/// The workspace-relative target, refusing anything that escapes the
/// (canonical) root.
fn target(root: &str, relative: &str) -> Result<PathBuf, HistoryError> {
    let root_path = Path::new(root);
    let canonical = root_path.canonicalize().map_err(io)?;
    if !root_path.is_absolute()
        || canonical != root_path
        || relative.is_empty()
        || Path::new(relative)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(invalid("file target is not workspace-relative"));
    }
    let file = root_path.join(relative);
    let mut parent = file.parent();
    while let Some(dir) = parent {
        if dir == root_path {
            break;
        }
        match fs::symlink_metadata(dir) {
            Ok(stat) if !stat.is_dir() || stat.file_type().is_symlink() => {
                return Err(invalid("file ancestor is not an ordinary directory"));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(io(error)),
            _ => {}
        }
        parent = dir.parent();
    }
    Ok(file)
}

fn mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        u32::from(metadata.permissions().readonly())
    }
}

fn claim_key(file: &Path) -> String {
    format!(
        "file\0claim\0{}",
        encode_hex(file.to_string_lossy().as_bytes())
    )
}

fn mutation_key(id: &str) -> String {
    format!("file\0mutation\0{id}")
}

fn counter_key(session: &str) -> String {
    format!("file\0counter\0{}", encode_hex(session.as_bytes()))
}

fn restore_key(session: &str) -> String {
    format!("file\0restore\0{}", encode_hex(session.as_bytes()))
}

/// Everything one file command needs to read.
#[allow(dead_code)]
pub struct FileContext<'a> {
    pub root: &'a Path,
    pub history_root: PathBuf,
    pub session_dir: &'a Path,
    pub session_id: &'a str,
    pub request_id: &'a str,
    pub index: &'a SessionIndex,
}

/// File state lives in the history index (committed by the caller together
/// with the command receipt) and in the history blob directory or the
/// workspace (images).
pub struct FileStore {
    history_root: PathBuf,
    staged: Vec<(String, Option<serde_json::Value>)>,
    /// A restored head to commit after the staged plan.
    head_switch: Option<String>,
    /// The `file_change` entity to append once changes are materialized.
    appended: Option<serde_json::Value>,
}

impl FileStore {
    pub fn new(history_root: PathBuf) -> Self {
        Self {
            history_root,
            staged: Vec::new(),
            head_switch: None,
            appended: None,
        }
    }

    pub fn take_staged(&mut self) -> Vec<(String, Option<serde_json::Value>)> {
        std::mem::take(&mut self.staged)
    }

    pub fn take_head_switch(&mut self) -> Option<String> {
        self.head_switch.take()
    }

    pub fn take_appended(&mut self) -> Option<serde_json::Value> {
        self.appended.take()
    }

    fn set(&mut self, key: String, value: Option<serde_json::Value>) -> Result<(), HistoryError> {
        self.staged.push((key, value));
        Ok(())
    }

    // ------------------------------------------------------------ images

    fn blob_dir(&self, blob_id: &str) -> PathBuf {
        self.history_root
            .join("blobs")
            .join(crate::storage::jsonl::layout::sha256_hex(
                blob_id.as_bytes(),
            ))
    }

    fn blob_chunk(&self, blob_id: &str, index: u64) -> Result<Vec<u8>, HistoryError> {
        fs::read(self.blob_dir(blob_id).join(format!("{index:08}.chunk"))).map_err(|error| {
            HistoryError::ObjectMissing(format!("blob {blob_id}/{index}: {error}"))
        })
    }

    fn write_chunk(&self, blob_id: &str, index: u64, bytes: &[u8]) -> Result<(), HistoryError> {
        let path = self.blob_dir(blob_id).join(format!("{index:08}.chunk"));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        fs::write(&path, bytes).map_err(io)
    }

    fn write_manifest(
        &self,
        blob_id: &str,
        manifest: &serde_json::Value,
    ) -> Result<(), HistoryError> {
        fs::write(
            self.blob_dir(blob_id).join("manifest.json"),
            serialized(manifest)?,
        )
        .map_err(io)
    }

    fn blob_manifest(&self, blob_id: &str) -> Result<Option<serde_json::Value>, HistoryError> {
        match fs::read(self.blob_dir(blob_id).join("manifest.json")) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io(error)),
        }
    }

    /// Capture a file (or symlink target) as a content-addressed image.
    fn file_snapshot(
        &self,
        file: &Path,
        persist: bool,
    ) -> Result<Option<FileVersion>, HistoryError> {
        let before = match fs::symlink_metadata(file) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io(error)),
        };
        let link = before.file_type().is_symlink();
        if before.len() > MAX_CAPTURE_BYTES {
            return Err(invalid("file image exceeds the 256 MiB capture limit"));
        }
        if !link && !before.is_file() {
            return Err(invalid(
                "only ordinary files and symlinks can be checkpointed",
            ));
        }
        let mut reader: Box<dyn Read> = if link {
            Box::new(std::io::Cursor::new(
                fs::read_link(file)?.to_string_lossy().as_bytes().to_vec(),
            ))
        } else {
            Box::new(File::open(file).map_err(io)?)
        };
        let blob_id = if persist {
            format!("file-{}", uuid::Uuid::new_v4())
        } else {
            String::new()
        };
        let mut digest = Sha256::new();
        let mut size = 0u64;
        let mut chunks = 0u64;
        let mut buffer = vec![0; STREAM_CHUNK];
        loop {
            let length = reader.read(&mut buffer).map_err(io)?;
            if length == 0 && chunks > 0 {
                break;
            }
            if chunks >= MAX_BLOB_CHUNKS {
                return Err(invalid("file image exceeds the chunk limit"));
            }
            digest.update(&buffer[..length]);
            size += length as u64;
            if !link && size > before.len() {
                return Err(busy("file grew during image capture"));
            }
            if persist {
                self.write_chunk(&blob_id, chunks, &buffer[..length])?;
            }
            chunks += 1;
            if length == 0 {
                break;
            }
        }
        let after = fs::symlink_metadata(file).map_err(io)?;
        #[cfg(unix)]
        let same_inode = {
            use std::os::unix::fs::MetadataExt;
            before.dev() == after.dev()
                && before.ino() == after.ino()
                && before.ctime() == after.ctime()
                && before.ctime_nsec() == after.ctime_nsec()
        };
        #[cfg(not(unix))]
        let same_inode = true;
        if !same_inode
            || before.len() != after.len()
            || before.modified().map_err(io)? != after.modified().map_err(io)?
            || before.file_type() != after.file_type()
            || mode(&before) != mode(&after)
        {
            return Err(busy("file changed while its image was being captured"));
        }
        let hash = format!("{:x}", digest.finalize());
        if persist {
            self.write_manifest(
                &blob_id,
                &object(&[
                    ("blobId", text(&blob_id)),
                    ("total", number(chunks)),
                    ("size", number(size)),
                    ("sha256", text(&hash)),
                ]),
            )?;
        }
        Ok(Some(FileVersion {
            kind: if link { "symlink" } else { "file" }.into(),
            hash,
            mode: mode(&before),
            size,
            blob_id,
        }))
    }

    fn write_file_version(&self, change: &FileChange) -> Result<(), HistoryError> {
        let file = target(&change.root, &change.path)?;
        let Some(version) = &change.before else {
            match fs::remove_file(&file) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(io(error)),
            }
            #[cfg(unix)]
            if let Some(parent) = file.parent() {
                File::open(parent).map_err(io)?.sync_all().map_err(io)?;
            }
            return Ok(());
        };
        let manifest = self
            .blob_manifest(&version.blob_id)?
            .ok_or_else(|| HistoryError::ObjectMissing(version.blob_id.clone()))?;
        let count = required_u64(&manifest, "total")?;
        let parent = file.parent().unwrap_or(&file).to_path_buf();
        fs::create_dir_all(&parent).map_err(io)?;
        let temporary = parent.join(format!(".synax-restore-{}", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), HistoryError> {
            let mut digest = Sha256::new();
            let mut link = Vec::new();
            let mut output = if version.kind == "file" {
                Some(
                    fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&temporary)
                        .map_err(io)?,
                )
            } else {
                None
            };
            for index in 0..count {
                let bytes = self.blob_chunk(&version.blob_id, index)?;
                digest.update(&bytes);
                if let Some(file) = &mut output {
                    file.write_all(&bytes).map_err(io)?;
                } else {
                    link.extend(bytes);
                }
            }
            if format!("{:x}", digest.finalize()) != version.hash {
                return Err(invalid("file image checksum mismatch"));
            }
            if let Some(output) = output {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    output
                        .set_permissions(fs::Permissions::from_mode(version.mode))
                        .map_err(io)?;
                }
                #[cfg(not(unix))]
                {
                    let mut permissions = output.metadata().map_err(io)?.permissions();
                    permissions.set_readonly(version.mode != 0);
                    output.set_permissions(permissions).map_err(io)?;
                }
                output.sync_all().map_err(io)?;
            } else {
                let destination =
                    String::from_utf8(link).map_err(|_| invalid("invalid symlink image"))?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(destination, &temporary).map_err(io)?;
                #[cfg(windows)]
                std::os::windows::fs::symlink_file(destination, &temporary).map_err(io)?;
            }
            fs::rename(&temporary, &file).map_err(io)?;
            #[cfg(unix)]
            File::open(&parent).map_err(io)?.sync_all().map_err(io)?;
            Ok(())
        })();
        if fs::symlink_metadata(&temporary).is_ok() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    // ------------------------------------------------------------- state

    fn pending(&self, ctx: &FileContext) -> Result<Vec<Mutation>, HistoryError> {
        let mut items = Vec::new();
        for (_, value) in ctx.index.aux_entries("file\0mutation\0") {
            if let Ok(mutation) = parse_mutation(value) {
                if mutation.state == "open" {
                    items.push(mutation);
                }
            }
        }
        Ok(items)
    }

    fn mutation(&self, ctx: &FileContext, id: &str) -> Option<Mutation> {
        ctx.index
            .aux_value(&mutation_key(id))
            .and_then(|value| parse_mutation(value).ok())
    }

    fn pending_restores(&self, ctx: &FileContext) -> Vec<Restore> {
        ctx.index
            .aux_entries("file\0restore\0")
            .filter_map(|(_, value)| serde_json::from_value::<Restore>(value.clone()).ok())
            .collect()
    }

    fn saved_restore(&self, ctx: &FileContext) -> Option<Restore> {
        ctx.index
            .aux_value(&restore_key(ctx.session_id))
            .and_then(|value| serde_json::from_value::<Restore>(value.clone()).ok())
    }

    fn counter(&self, ctx: &FileContext) -> u64 {
        ctx.index
            .aux_value(&counter_key(ctx.session_id))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    }

    fn session_has_writer(&self, ctx: &FileContext) -> Result<bool, HistoryError> {
        Ok(self
            .pending(ctx)?
            .iter()
            .any(|mutation| mutation.session_id == ctx.session_id))
    }

    /// The checkpoint pin saved by `checkpoint` / `file_checkpoint`.
    fn checkpoint_data(
        &self,
        ctx: &FileContext,
        id: &str,
    ) -> Result<serde_json::Value, HistoryError> {
        let value = ctx
            .index
            .aux_value(&format!("pin\0{id}"))
            .cloned()
            .ok_or_else(|| HistoryError::ObjectMissing(format!("checkpoint {id}")))?;
        required_string(&value, "objectId")?;
        Ok(value)
    }

    /// Fold every mutation recorded after the checkpoint's file cursor.
    fn restore_plan(
        &self,
        ctx: &FileContext,
        cursor: u64,
    ) -> Result<(Vec<FileChange>, Vec<serde_json::Value>, Vec<String>), HistoryError> {
        let mut files: BTreeMap<String, FileChange> = BTreeMap::new();
        let mut blocked = BTreeSet::new();
        let mut preserved = Vec::<serde_json::Value>::new();
        let mut warnings = Vec::<String>::new();
        for (_, source) in ctx.index.entity_keys("file_change") {
            let Ok(item) = parse_mutation(&source.value) else {
                continue;
            };
            if item.sequence <= cursor {
                continue;
            }
            if item.untracked {
                warnings.push(
                    item.warning
                        .clone()
                        .unwrap_or_else(|| {
                            format!(
                                "Untracked effects from operation {} are preserved.",
                                item.id
                            )
                        })
                        .into(),
                );
                for change in &item.changes {
                    let key = format!("{}\0{}", change.root, change.path);
                    blocked.insert(key.clone());
                    if !files.contains_key(&key) {
                        preserved.push(object(&[
                            ("root", text(&change.root)),
                            ("path", text(&change.path)),
                            ("reason", text("Manual or untracked changes are preserved.")),
                        ]));
                    }
                }
                continue;
            }
            for change in item.changes {
                let key = format!("{}\0{}", change.root, change.path);
                if blocked.contains(&key) {
                    continue;
                }
                if let Some(existing) = files.get_mut(&key) {
                    existing.before = change.before;
                    existing.git = change.git;
                } else {
                    files.insert(key, change);
                }
            }
        }
        Ok((
            files
                .into_values()
                .filter(|change| !same(&change.before, &change.after))
                .collect(),
            preserved,
            warnings,
        ))
    }

    fn same_root(a: &str, b: &str) -> bool {
        Path::new(a).starts_with(b) || Path::new(b).starts_with(a)
    }

    // ---------------------------------------------------------- commands

    pub fn preview(
        &mut self,
        ctx: &FileContext,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, HistoryError> {
        let checkpoint = self.checkpoint_data(ctx, required_string(value, "checkpointId")?)?;
        let cursor = required_u64(&checkpoint["metadata"], "fileCursor")?;
        let (files, preserved, warnings) = self.restore_plan(ctx, cursor)?;
        let mut conflicts = Vec::new();
        for change in &files {
            let actual = target(&change.root, &change.path)
                .and_then(|file| self.file_snapshot(&file, false));
            match actual {
                Ok(version) if same(&version, &change.after) => {}
                Ok(_) => conflicts.push(object(&[
                    ("root", text(&change.root)),
                    ("path", text(&change.path)),
                    ("reason", text("File has independent changes.")),
                ])),
                Err(error) => conflicts.push(object(&[
                    ("root", text(&change.root)),
                    ("path", text(&change.path)),
                    ("reason", serde_json::Value::String(error.to_string())),
                ])),
            }
        }
        Ok(object(&[
            ("files", convert_value(files)?),
            ("conflicts", array(conflicts)),
            ("preservedFiles", array(preserved)),
            (
                "warnings",
                array(warnings.into_iter().map(|item| text(&item)).collect()),
            ),
        ]))
    }

    pub fn pending_view(&self, ctx: &FileContext) -> Result<serde_json::Value, HistoryError> {
        let items: Vec<_> = self
            .pending(ctx)?
            .into_iter()
            .map(|mutation| {
                object(&[
                    ("id", text(&mutation.id)),
                    ("sessionId", text(&mutation.session_id)),
                    ("ownerPid", number(u64::from(mutation.owner_pid))),
                ])
            })
            .collect();
        let restores: Vec<_> = self
            .pending_restores(ctx)
            .into_iter()
            .map(|restore| {
                object(&[
                    ("sessionId", text(&restore.session_id)),
                    ("requestId", text(&restore.request_id)),
                    ("state", text(&restore.state)),
                ])
            })
            .collect();
        Ok(object(&[
            ("items", array(items)),
            ("restores", array(restores)),
        ]))
    }

    pub fn cursor_view(&self, ctx: &FileContext) -> Result<serde_json::Value, HistoryError> {
        if self.session_has_writer(ctx)? || self.saved_restore(ctx).is_some() {
            return Err(busy("session has an unfinished file operation"));
        }
        Ok(object(&[("cursor", number(self.counter(ctx)))]))
    }

    /// Pin the head with the current file cursor. Returns `None` when the pin
    /// already existed; the caller then needs no history write.
    pub fn checkpoint(
        &mut self,
        ctx: &FileContext,
        value: &serde_json::Value,
    ) -> Option<serde_json::Value> {
        (|| -> Result<serde_json::Value, HistoryError> {
            let pin = required_string(value, "pinId")?;
            if let Some(existing) = ctx.index.aux_value(&format!("pin\0{pin}")) {
                return Ok(existing.clone());
            }
            if self.session_has_writer(ctx)? || self.saved_restore(ctx).is_some() {
                return Err(busy("session has an unfinished file operation"));
            }
            let root = ctx
                .index
                .head
                .object_id
                .clone()
                .ok_or_else(|| invalid("checkpoint requires a history head"))?;
            let mut metadata = value["metadata"].clone();
            if !metadata.is_object() {
                metadata = serde_json::Value::Object(serde_json::Map::new());
            }
            metadata["fileCursor"] = number(self.counter(ctx));
            self.set(
                format!("pin\0{pin}"),
                Some(object(&[
                    ("objectId", text(&root)),
                    ("metadata", metadata.clone()),
                ])),
            )?;
            Ok(object(&[
                ("pinId", text(pin)),
                ("objectId", text(&root)),
                ("metadata", metadata),
            ]))
        })()
        .ok()
    }

    pub fn begin(
        &mut self,
        ctx: &FileContext,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, HistoryError> {
        let targets = value["targets"]
            .as_array()
            .ok_or_else(|| invalid("file targets are required"))?;
        if targets.len() > 256 {
            return Err(invalid("a file mutation supports at most 256 paths"));
        }
        let roots: Vec<String> = serde_json::from_value(value["roots"].clone())
            .map_err(|error| invalid(&format!("serialization: {error}")))?;
        let paths = targets
            .iter()
            .map(|entry| {
                target(
                    required_string(entry, "root")?,
                    required_string(entry, "path")?,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        for file in &paths {
            if ctx.index.aux_value(&claim_key(file)).is_some() {
                return Err(busy(file.display().to_string()));
            }
        }
        for restore in self.pending_restores(ctx) {
            if restore.session_id == ctx.session_id
                || restore
                    .files
                    .iter()
                    .any(|change| roots.iter().any(|root| Self::same_root(&change.root, root)))
            {
                return Err(busy("workspace has a pending history restore"));
            }
        }
        let untracked = value["external"].as_bool().unwrap_or(false) || targets.is_empty();
        if !untracked {
            let mut total = 0u64;
            for path in &paths {
                match fs::symlink_metadata(path) {
                    Ok(stat) => total = total.saturating_add(stat.len()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(io(error)),
                }
            }
            if total > MAX_CAPTURE_BYTES {
                return Err(invalid("file mutation images exceed 256 MiB"));
            }
        }
        let mut others = self.pending(ctx)?;
        let overlaps = |other: &Mutation| {
            other
                .roots
                .iter()
                .any(|root| roots.iter().any(|mine| Self::same_root(root, mine)))
        };
        let uncertain = untracked || others.iter().any(|m| m.untracked && overlaps(m));
        if untracked {
            for other in &mut others {
                if overlaps(other) && !other.untracked {
                    other.untracked = true;
                    self.set(mutation_key(&other.id), Some(convert_value(other)?))?;
                }
            }
        }
        let sequence = self.counter(ctx).saturating_add(1);
        let mut changes = Vec::new();
        for (entry, file) in targets.iter().zip(&paths) {
            changes.push(FileChange {
                root: required_string(entry, "root")?.to_owned(),
                path: required_string(entry, "path")?.to_owned(),
                before: if untracked {
                    None
                } else {
                    self.file_snapshot(file, true)?
                },
                after: None,
                git: entry.get("git").cloned(),
            });
        }
        let item = Mutation {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: ctx.session_id.to_owned(),
            source_session_id: required_string(value, "sourceSessionId")?.to_owned(),
            sequence,
            owner_pid: required_u64(value, "ownerPid")? as u32,
            state: "open".into(),
            untracked: uncertain,
            created_at: now_iso(),
            warning: value["warning"].as_str().map(str::to_owned),
            roots,
            changes,
        };
        for file in &paths {
            self.set(claim_key(file), Some(text(&item.id)))?;
        }
        self.set(counter_key(ctx.session_id), Some(number(sequence)))?;
        self.set(mutation_key(&item.id), Some(convert_value(&item)?))?;
        Ok(object(&[
            ("id", text(&item.id)),
            ("sequence", number(sequence)),
        ]))
    }

    pub fn finish(
        &mut self,
        ctx: &FileContext,
        operation: &str,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, HistoryError> {
        let id = required_string(value, "id")?;
        let mut item = self
            .mutation(ctx, id)
            .ok_or_else(|| HistoryError::ObjectMissing(id.into()))?;
        if item.session_id != ctx.session_id {
            return Err(invalid("file mutation belongs to another session"));
        }
        if item.state != "open" {
            return Ok(convert_value(&item)?);
        }
        item.untracked |= operation == "file_abandon";
        if !item.untracked {
            for change in &mut item.changes {
                change.after = self.file_snapshot(&target(&change.root, &change.path)?, true)?;
            }
        }
        for change in &item.changes {
            self.set(claim_key(&target(&change.root, &change.path)?), None)?;
        }
        item.state = "closed".into();
        if !item.untracked {
            item.changes
                .retain(|change| !same(&change.before, &change.after));
        }
        self.set(mutation_key(&item.id), Some(convert_value(&item)?))?;
        let mut entry = serde_json::Value::Object(serde_json::Map::new());
        entry["kind"] = text("runtime.file_change");
        entry["value"] = super::json::convert_value(&item)?;
        let mut appended = serde_json::Value::Object(serde_json::Map::new());
        appended["objects"] = serde_json::Value::Array(vec![entry]);
        self.appended = Some(appended);
        Ok(convert_value(&item)?)
    }

    /// Register closed mutations (whose images already exist as blobs) and
    /// advance the cursor floor. The caller appends the file_change entities.
    pub fn import(
        &mut self,
        ctx: &FileContext,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, HistoryError> {
        let records: Vec<Mutation> = serde_json::from_value(value["records"].clone())
            .map_err(|error| invalid(&format!("serialization: {error}")))?;
        if records.len() > 256 {
            return Err(invalid("file import requires at most 256 records"));
        }
        let mut floor = required_u64(value, "cursorFloor")?;
        for item in &records {
            if item.session_id != ctx.session_id || item.state != "closed" {
                return Err(invalid("file import scope or state mismatch"));
            }
            floor = floor.max(item.sequence);
            for change in &item.changes {
                for version in [&change.before, &change.after].into_iter().flatten() {
                    let manifest = self
                        .blob_manifest(&version.blob_id)?
                        .ok_or_else(|| HistoryError::ObjectMissing(version.blob_id.clone()))?;
                    if manifest["sha256"] != version.hash
                        || manifest["size"].as_u64() != Some(version.size)
                    {
                        return Err(invalid("imported file image differs from its manifest"));
                    }
                }
            }
        }
        for item in &records {
            self.set(mutation_key(&item.id), Some(convert_value(item)?))?;
        }
        let floor = floor.max(self.counter(ctx)).saturating_add(1);
        self.set(counter_key(ctx.session_id), Some(number(floor)))?;
        Ok(object(&[
            ("imported", number(records.len() as u64)),
            ("cursor", number(floor)),
        ]))
    }

    /// Apply the saved plan, then move the head. The plan is persisted before
    /// any file is touched so a retry resumes a partially applied restore.
    fn resume_restore(
        &mut self,
        ctx: &FileContext,
        restore: &mut Restore,
    ) -> Result<(), HistoryError> {
        if restore.state == "head_committed" {
            return Ok(());
        }
        let head = ctx.index.head.clone();
        if head.revision != restore.expected_revision {
            return Err(HistoryError::RevisionConflict {
                expected: restore.expected_revision,
                actual: head.revision,
            });
        }
        for change in &restore.files {
            let actual = self.file_snapshot(&target(&change.root, &change.path)?, false)?;
            if !same(&actual, &change.before) && !same(&actual, &change.after) {
                return Err(busy(format!(
                    "independent change at {}/{}",
                    change.root, change.path
                )));
            }
        }
        for change in &restore.files {
            let actual = self.file_snapshot(&target(&change.root, &change.path)?, false)?;
            if !same(&actual, &change.before) {
                self.write_file_version(change)?;
            }
        }
        restore.state = "head_committed".into();
        self.set(restore_key(ctx.session_id), Some(convert_value(&restore)?))?;
        self.head_switch = Some(restore.target.clone());
        Ok(())
    }

    pub fn restore_checkpoint(
        &mut self,
        ctx: &FileContext,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, HistoryError> {
        let id = required_string(value, "checkpointId")?;
        let mut restore = if let Some(existing) = self.saved_restore(ctx) {
            if existing.request_id != ctx.request_id || existing.checkpoint_id != id {
                return Err(busy("another restore is pending"));
            }
            existing
        } else {
            let checkpoint = self.checkpoint_data(ctx, id)?;
            let revision = required_u64(value, "expectedRevision")?;
            let head = ctx.index.head.revision;
            if head != revision {
                return Err(HistoryError::RevisionConflict {
                    expected: revision,
                    actual: head,
                });
            }
            if self.session_has_writer(ctx)? {
                return Err(busy("session has an active file writer"));
            }
            let include = value["includeFiles"].as_bool().unwrap_or(true);
            let mut files = if include {
                self.restore_plan(ctx, required_u64(&checkpoint["metadata"], "fileCursor")?)?
                    .0
            } else {
                Vec::new()
            };
            let preserved: BTreeSet<String> = value
                .get("preservePaths")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(|error| invalid(&format!("serialization: {error}")))?
                .unwrap_or_default();
            files
                .retain(|change| !preserved.contains(&format!("{}\0{}", change.root, change.path)));
            if self.pending(ctx)?.iter().any(|mutation| {
                mutation.roots.iter().any(|root| {
                    files.iter().any(|change| {
                        Path::new(root).starts_with(&change.root)
                            || Path::new(&change.root).starts_with(root)
                    })
                })
            }) {
                return Err(busy("another workspace operation is still writing"));
            }
            for change in &files {
                let file = target(&change.root, &change.path)?;
                if ctx.index.aux_value(&claim_key(&file)).is_some() {
                    return Err(busy("a file has an active writer"));
                }
                if !same(&self.file_snapshot(&file, false)?, &change.after) {
                    return Err(busy(format!("independent change at {}", file.display())));
                }
            }
            let restore = Restore {
                session_id: ctx.session_id.into(),
                request_id: ctx.request_id.into(),
                checkpoint_id: id.into(),
                target: required_string(&checkpoint, "objectId")?.into(),
                expected_revision: revision,
                files,
                metadata: checkpoint["metadata"].clone(),
                state: "prepared".into(),
            };
            self.set(restore_key(ctx.session_id), Some(convert_value(&restore)?))?;
            restore
        };
        self.resume_restore(ctx, &mut restore)?;
        Ok(object(&[
            ("revision", number(restore.expected_revision + 1)),
            ("metadata", restore.metadata),
            ("requestId", text(&restore.request_id)),
        ]))
    }

    pub fn recover(&mut self, ctx: &FileContext) -> Result<serde_json::Value, HistoryError> {
        let Some(mut restore) = self.saved_restore(ctx) else {
            return Ok(object(&[("recovered", serde_json::Value::Bool(false))]));
        };
        self.resume_restore(ctx, &mut restore)?;
        Ok(object(&[
            ("recovered", serde_json::Value::Bool(true)),
            ("revision", number(restore.expected_revision + 1)),
            ("metadata", restore.metadata),
            ("requestId", text(&restore.request_id)),
        ]))
    }

    pub fn restore_ack(
        &mut self,
        ctx: &FileContext,
        value: &serde_json::Value,
    ) -> Result<(), HistoryError> {
        if let Some(restore) = self.saved_restore(ctx) {
            if restore.request_id != required_string(value, "requestId")?
                || restore.state != "head_committed"
            {
                return Err(busy("restore acknowledgement does not match"));
            }
            self.set(restore_key(ctx.session_id), None)?;
        }
        Ok(())
    }
}

/// The file_change objects a session recorded, for tests and tooling.
#[allow(dead_code)]
fn file_changes(index: &SessionIndex) -> Vec<&HistoryObject> {
    index
        .entity_keys("file_change")
        .map(|(_, object)| &**object)
        .collect()
}
