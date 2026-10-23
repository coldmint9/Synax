//! One append-only file with a shared handle.
//!
//! The writer appends under its own lock; a single background thread per root
//! takes the shared handle and runs `fsync`/`F_FULLFSYNC` on its own thread, so
//! a slow disk never stalls the writer's critical section.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::error::{JsonlError, JsonlResult};
use super::seglog::{MAX_FRAME, frame_at};

pub struct AppendFile {
    path: PathBuf,
    file: Arc<File>,
    len: u64,
}

impl AppendFile {
    /// Open (creating) `path`, dropping any torn tail first.
    pub fn open(path: &Path) -> JsonlResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(JsonlError::io)?;
        }
        let (len, torn) = match File::open(path) {
            Ok(probe) => {
                let total = probe.metadata()?.len();
                let mut cursor = 0;
                while let Some((_, next)) = frame_at(&probe, cursor, total)? {
                    cursor = next;
                }
                (cursor, cursor != total)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (0, false),
            Err(error) => return Err(JsonlError::io(error)),
        };
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)
            .map_err(JsonlError::io)?;
        if torn {
            file.set_len(len).map_err(JsonlError::io)?;
            tracing::warn!(
                event = "storage.tail_recovered",
                retained_bytes = len,
                "Recovered incomplete storage tail"
            );
        }
        Ok(Self {
            path: path.to_path_buf(),
            file: Arc::new(file),
            len,
        })
    }

    /// Open only the committed extent of a v2 file. Legacy files never use this writer.
    pub fn open_committed(path: &Path, length: u64) -> JsonlResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(JsonlError::io)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)
            .map_err(JsonlError::io)?;
        let actual = file.metadata()?.len();
        if actual < length {
            return Err(JsonlError::corrupt(path, actual, "missing committed bytes"));
        }
        if actual != length {
            file.set_len(length).map_err(JsonlError::io)?;
        }
        Ok(Self {
            path: path.to_owned(),
            file: Arc::new(file),
            len: length,
        })
    }

    pub fn truncate(&mut self, length: u64) -> JsonlResult<()> {
        self.file.set_len(length).map_err(JsonlError::io)?;
        self.len = length;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
    /// A staged file already has its validated open handle before atomic rename.
    pub(crate) fn relocate(&mut self, path: PathBuf) { self.path = path; }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn handle(&self) -> Arc<File> {
        self.file.clone()
    }

    /// Flush this file's appended bytes to stable media.
    pub fn sync(&self) -> JsonlResult<()> {
        self.file.sync_data().map_err(JsonlError::io)
    }

    /// Every frame appended past byte `offset`.
    pub fn read_tail(&self, offset: u64) -> JsonlResult<Vec<Vec<u8>>> {
        let tail = super::seglog::scan(&self.path, offset)?;
        let total = self.file.metadata().map_err(JsonlError::io)?.len();
        let mut out = Vec::new();
        for meta in tail.frames {
            if let Some((payload, _)) = super::seglog::frame_at(&self.file, meta.offset, total)? {
                out.push(payload);
            }
        }
        Ok(out)
    }

    /// Append one framed record.
    pub fn append(&mut self, payload: &[u8]) -> JsonlResult<()> {
        if payload.len() > MAX_FRAME {
            return Err(JsonlError::corrupt(
                &self.path,
                self.len,
                "frame exceeds MAX_FRAME",
            ));
        }
        let mut buf = Vec::with_capacity(payload.len() + 4);
        buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        buf.extend_from_slice(payload);
        if let Err(error) = (&*self.file).write_all(&buf) {
            tracing::error!(
                event = "storage.append_failed",
                error_kind = crate::logging::error_kind(&error),
                offset = self.len,
                bytes = buf.len(),
                "Storage append failed"
            );
            let _ = self.file.set_len(self.len);
            return Err(JsonlError::io(error));
        }
        self.len += buf.len() as u64;
        Ok(())
    }
}

/// Make the given files durable. Used by the fsync thread.
pub fn sync_files(files: &[Arc<File>]) -> JsonlResult<()> {
    for file in files {
        file.sync_data().map_err(|error| {
            tracing::error!(
                event = "storage.sync_failed",
                error_kind = crate::logging::error_kind(&error),
                "Storage sync failed"
            );
            JsonlError::io(error)
        })?;
    }
    Ok(())
}

/// Every complete frame of a file, in order.
pub fn read_frames(path: &Path) -> JsonlResult<Vec<Vec<u8>>> {
    Ok(super::seglog::read_all(path)?
        .into_iter()
        .map(|(_, payload)| payload)
        .collect())
}

/// Encode one framed record into `out`, for callers that batch writes.
pub fn frame(payload: &[u8], out: &mut Vec<u8>) {
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
}
