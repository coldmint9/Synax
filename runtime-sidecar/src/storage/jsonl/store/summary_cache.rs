//! Disposable list rows, fenced by the source files they were derived from.
//! Missing rows are repaired from committed header fields, without an actor.

use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};

use crate::storage::jsonl::{
    error::JsonlResult,
    layout,
    record::ListRecord,
    session::{SessionActor, list_row, load::segment_directories},
};

const FILE_NAME: &str = "list-summary.json";
const SCHEMA: u8 = 3;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct SourceFile {
    bytes: u64,
    modified_seconds: u64,
    modified_nanos: u32,
}

#[derive(Serialize, Deserialize)]
struct Summary {
    schema: u8,
    segment: u64,
    files: [SourceFile; 3],
    row: ListRecord,
}

/// Captured under the actor lock, after the normal durability barrier.
pub(super) struct Prepared {
    directory: PathBuf,
    pub(super) commit: u64,
    summary: Summary,
}

pub(super) struct Staged {
    temporary: PathBuf,
    destination: PathBuf,
    segment: u64,
    files: [SourceFile; 3],
}

impl Prepared {
    /// No actor lock is held during encoding and temporary-file I/O.
    pub(super) fn stage(self) -> JsonlResult<Staged> {
        stage(&self.directory, self.summary)
    }
}

impl Staged {
    /// A staged row can lose the race to a newer source prefix. Do not replace
    /// a useful cache with that now-stale row; its owner will retry dirty work.
    pub(super) fn publish(self) -> JsonlResult<bool> {
        let directory = self.destination.parent().expect("summary parent");
        let files = source_files(directory, self.segment).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "summary source files are unavailable before publication",
            )
        })?;
        if segment_directories(&directory.join("events-v2"))?.last() != Some(&self.segment)
            || files != self.files
        {
            return Ok(false);
        }
        fs::rename(&self.temporary, &self.destination)?;
        Ok(true)
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        // This task owns a unique name. Never remove another writer's temp file.
        let _ = fs::remove_file(&self.temporary);
    }
}

fn source_files(directory: &Path, segment: u64) -> Option<[SourceFile; 3]> {
    let directory = layout::segment_dir(&directory.join("events-v2"), segment);
    let stat = |name: &str| {
        let metadata = fs::metadata(directory.join(name)).ok()?;
        let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        Some(SourceFile {
            bytes: metadata.len(),
            modified_seconds: modified.as_secs(),
            modified_nanos: modified.subsec_nanos(),
        })
    };
    Some([
        stat("ctls.000000")?,
        stat("evts.000000")?,
        stat("clse.000000")?,
    ])
}

#[cfg(test)]
pub(super) fn read(root: &Path, id: &str) -> Option<ListRecord> {
    read_with(root, id, |_| Ok(false))
}

pub(super) fn read_with(root: &Path, id: &str, publish: impl FnOnce(Staged) -> JsonlResult<bool>) -> Option<ListRecord> {
    let directory = layout::session_dir(root, id).ok()?;
    let mut summary: Summary =
        serde_json::from_slice(&fs::read(directory.join(FILE_NAME)).ok()?).ok()?;
    if !(1..=SCHEMA).contains(&summary.schema) || summary.row.s != id || summary.row.h["id"] != id {
        return None;
    }
    // Rolls can leave the old segment unchanged. Check the newest directory as
    // well as file lengths/mtimes so an interrupted write or an older runtime's
    // subsequent commits cannot make a stale title/status look authoritative.
    let newest = segment_directories(&directory.join("events-v2"))
        .ok()?
        .last()
        .copied()?;
    if newest != summary.segment || source_files(&directory, newest)? != summary.files {
        return None;
    }
    let old_schema = summary.schema != SCHEMA;
    summary.row.h = super::list_projection::summary(&summary.row.h);
    if old_schema {
        summary.schema = SCHEMA;
        // Upgrade the disposable cache directly: no historical log replay.
        let row = summary.row.clone();
        let _ = stage(&directory, summary).and_then(publish);
        return Some(row);
    }
    Some(summary.row)
}

/// Capture the complete row while the actor lock is held. The resulting value
/// owns all data needed for encoding and replacement after the lock is released.
pub(super) fn capture(root: &Path, actor: &SessionActor) -> JsonlResult<Option<Prepared>> {
    if !actor.header.is_object() {
        return Ok(None);
    }
    let directory = layout::session_dir(root, &actor.id)?;
    let Some(files) = source_files(&directory, actor.files.segment) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "summary source files are unavailable",
        )
        .into());
    };
    let mut row = list_row(actor);
    if let Some(metadata) = row
        .h
        .get_mut("sessionMetadata")
        .and_then(serde_json::Value::as_object_mut)
    {
        metadata.remove("latestSystemPrompt");
    }
    Ok(Some(Prepared {
        directory,
        commit: actor.commit,
        summary: Summary {
            schema: SCHEMA,
            segment: actor.files.segment,
            files,
            row,
        },
    }))
}

pub(super) fn rebuild(
    root: &Path,
    id: &str,
    publish: impl FnOnce(Staged) -> JsonlResult<bool>,
) -> JsonlResult<ListRecord> {
    let directory = layout::session_dir(root, id)?;
    let newest = segment_directories(&directory.join("events-v2"))?
        .last()
        .copied();
    let before = newest.and_then(|segment| source_files(&directory, segment));
    let row = super::summary_replay::read(root, id)?;
    if let (Some(segment), Some(files)) = (newest, before) {
        if row.h.is_object()
            && segment_directories(&directory.join("events-v2"))?.last() == Some(&segment)
            && source_files(&directory, segment).as_ref() == Some(&files)
        {
            // A concurrent actor may commit just after this check. The saved
            // source fingerprint then fails validation; no stale row is trusted.
            if let Err(error) = stage(
                &directory,
                Summary {
                    schema: SCHEMA,
                    segment,
                    files,
                    row: row.clone(),
                },
            )
            .and_then(publish)
            {
                tracing::warn!(event = "storage.summary_cache_failed", error = %error, "Summary cache repair could not be saved");
            }
        }
    }
    Ok(row)
}

fn stage(directory: &Path, summary: Summary) -> JsonlResult<Staged> {
    let bytes = serde_json::to_vec(&summary)?;
    let staged = Staged {
        temporary: directory.join(format!("list-summary-{}.tmp", uuid::Uuid::new_v4())),
        destination: directory.join(FILE_NAME),
        segment: summary.segment,
        files: summary.files,
    };
    // Never create the session directory: deletion owns its lifecycle.
    fs::write(&staged.temporary, bytes)?;
    Ok(staged)
}
