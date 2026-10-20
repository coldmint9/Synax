//! One error type for the whole storage core.
//!
//! Every failure is classified where it is constructed — a full disk is
//! `DiskFull` the moment `write` reports `ENOSPC`, never re-interpreted by a
//! caller. Each variant carries the wire code the transport must answer with,
//! so `transport.rs` never invents error strings.

use std::io;
use std::path::PathBuf;

use crate::actor::RuntimeError;

pub type JsonlResult<T> = Result<T, JsonlError>;

#[derive(Debug, thiserror::Error)]
pub enum JsonlError {
    #[error("store {0} is already open by another process")]
    Busy(PathBuf),
    #[error("storage i/o: {0}")]
    Io(#[from] io::Error),
    #[error("{path}: corrupt record at byte {offset}: {reason}")]
    Corrupt {
        path: PathBuf,
        offset: u64,
        reason: String,
    },
    #[error("disk full")]
    DiskFull,
    #[error("invalid session id: {0}")]
    BadId(String),
    #[error("serialization: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
}

impl JsonlError {
    /// The `(code, message)` pair the wire answers with.
    pub fn wire(&self) -> (&'static str, String) {
        match self {
            JsonlError::DiskFull => ("DISK_FULL", "storage disk full".to_owned()),
            JsonlError::Busy(path) => (
                "STORAGE_UNAVAILABLE",
                format!("store {} is already open", path.display()),
            ),
            JsonlError::BadId(_) => ("INVALID_COMMAND", self.to_string()),
            JsonlError::Runtime(_) | JsonlError::Io(_) | JsonlError::Corrupt { .. } | JsonlError::Serialization(_) => {
                ("STORAGE_UNAVAILABLE", self.to_string())
            }
        }
    }

    /// Classify an I/O error at the point it happened.
    pub fn io(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::StorageFull || error.raw_os_error() == Some(28) {
            JsonlError::DiskFull
        } else {
            JsonlError::Io(error)
        }
    }

    pub fn corrupt(path: impl Into<PathBuf>, offset: u64, reason: impl Into<String>) -> Self {
        JsonlError::Corrupt {
            path: path.into(),
            offset,
            reason: reason.into(),
        }
    }
}

impl From<JsonlError> for RuntimeError {
    fn from(error: JsonlError) -> Self {
        match error {
            JsonlError::Runtime(error) => error,
            JsonlError::DiskFull => RuntimeError::DiskFull,
            other => RuntimeError::StorageUnavailable(other.to_string()),
        }
    }
}
