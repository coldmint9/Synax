//! Disposable list rows, fenced by the source files they were derived from.
//! Missing rows are repaired from committed header fields, without an actor.

use std::{fs, path::Path, time::UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::storage::jsonl::{
    error::JsonlResult,
    layout,
    record::ListRecord,
    session::{SessionActor, list_row, load::segment_directories},
};

const FILE_NAME: &str = "list-summary.json";
const SCHEMA: u8 = 2;

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

pub(super) fn read(root: &Path, id: &str) -> Option<ListRecord> {
    let directory = layout::session_dir(root, id).ok()?;
    let summary: Summary =
        serde_json::from_slice(&fs::read(directory.join(FILE_NAME)).ok()?).ok()?;
    if summary.schema != SCHEMA || summary.row.s != id || summary.row.h["id"] != id {
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
    Some(summary.row)
}

/// Called under the actor lock, after its source files have been synced. This
/// cache needs no additional fsync: a torn/missing cache is always rebuildable.
pub(super) fn write(root: &Path, actor: &SessionActor) -> JsonlResult<()> {
    if !actor.header.is_object() {
        return Ok(());
    }
    let directory = layout::session_dir(root, &actor.id)?;
    let Some(files) = source_files(&directory, actor.files.segment) else {
        return Ok(());
    };
    let mut row = list_row(actor);
    if let Some(metadata) = row
        .h
        .get_mut("sessionMetadata")
        .and_then(serde_json::Value::as_object_mut)
    {
        metadata.remove("latestSystemPrompt");
    }
    persist(
        &directory,
        Summary {
            schema: SCHEMA,
            segment: actor.files.segment,
            files,
            row,
        },
    )
}

pub(super) fn rebuild(root: &Path, id: &str) -> JsonlResult<ListRecord> {
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
            if let Err(error) = persist(
                &directory,
                Summary {
                    schema: SCHEMA,
                    segment,
                    files,
                    row: row.clone(),
                },
            ) {
                tracing::warn!(event = "storage.summary_cache_failed", error = %error, "Summary cache repair could not be saved");
            }
        }
    }
    Ok(row)
}

fn persist(directory: &Path, summary: Summary) -> JsonlResult<()> {
    let bytes = serde_json::to_vec(&summary)?;
    let temporary = directory.join(format!("list-summary-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::write(&temporary, bytes)?;
        fs::rename(&temporary, directory.join(FILE_NAME))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
