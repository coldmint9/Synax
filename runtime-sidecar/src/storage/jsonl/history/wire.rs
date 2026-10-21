//! The history error type and its wire codes.

use crate::runtime::actor::RuntimeError;

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("Conversation changed. Refresh history.")]
    StaleCursor,
    #[error("file operation: {0}")]
    FileIo(String),
    #[error("file operation conflicts: {0}")]
    FileBusy(String),
    #[error("history object not found: {0}")]
    ObjectMissing(String),
    #[error("history request was reused with different input")]
    RequestConflict,
    #[error("history revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("history command is invalid: {0}")]
    InvalidCommand(String),
    }

impl HistoryError {
    /// The `(code, message)` pair the wire answers with.
    pub fn wire(&self) -> (&'static str, String) {
        match self {
            HistoryError::StaleCursor => (
                "HISTORY_STALE",
                "Conversation changed. Refresh history.".to_owned(),
            ),
            HistoryError::FileBusy(message) => ("FILE_BUSY", message.clone()),
            HistoryError::ObjectMissing(message) => ("OBJECT_MISSING", message.clone()),
            HistoryError::RequestConflict => (
                "REQUEST_CONFLICT",
                "history request was reused with different input".to_owned(),
            ),
            HistoryError::RevisionConflict { expected, actual } => (
                "REVISION_CONFLICT",
                format!("history revision conflict: expected {expected}, actual {actual}"),
            ),
            HistoryError::InvalidCommand(_) => ("INVALID_COMMAND", self.to_string()),
            HistoryError::FileIo(_) => ("FILE_IO_ERROR", self.to_string()),
        }
    }
}

impl From<std::io::Error> for HistoryError {
    fn from(error: std::io::Error) -> Self {
        HistoryError::FileIo(error.to_string())
    }
}

impl From<HistoryError> for RuntimeError {
    fn from(error: HistoryError) -> Self {
        match error {
            HistoryError::RevisionConflict { expected, actual } => {
                RuntimeError::RevisionConflict { expected, actual }
            }
            HistoryError::RequestConflict => RuntimeError::RequestConflict,
            other => RuntimeError::StorageUnavailable(other.to_string()),
        }
    }
}
