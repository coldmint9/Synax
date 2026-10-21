//! Where every file of the store lives.
//!
//! Paths are derived, never stored: recovery and the hot path agree on the
//! layout because both call these functions.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::error::{JsonlError, JsonlResult};

pub const LOCK_FILE: &str = "LOCK";
pub const LIST_INDEX_DIR: &str = "index";
pub const ASSETS_DIR: &str = "assets";
pub const LOOPS_DIR: &str = "loops";
pub const SESSIONS_DIR: &str = "sessions";

/// Kept as a public compatibility constant; each segment now owns its own
/// numbered directory so a roll cannot reopen the previous segment files.
pub const SEGMENTS_PER_DIRECTORY: u64 = 1;

/// Directory shard: the first two hex characters of the id's digest.
pub fn shard(session_id: &str) -> String {
    hex(&Sha256::digest(session_id.as_bytes()))[..2].to_owned()
}

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit((byte >> 4) as u32, 16).expect("nibble"));
        out.push(char::from_digit((byte & 0xf) as u32, 16).expect("nibble"));
    }
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Session ids become directory names; anything that could escape the tree or
/// break a shell/JSON consumer is rejected up front.
pub fn validate_session_id(id: &str) -> JsonlResult<()> {
    let valid = !id.is_empty()
        && id.len() <= 200
        && !matches!(id, "." | "..")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'));

    if valid {
        Ok(())
    } else {
        Err(JsonlError::BadId(id.to_owned()))
    }
}

pub fn validate_loop_id(id: &str) -> JsonlResult<()> {
    let valid = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'));

    if valid {
        Ok(())
    } else {
        Err(JsonlError::BadId(format!("loop {id}")))
    }
}

pub fn session_dir(root: &Path, session_id: &str) -> JsonlResult<PathBuf> {
    validate_session_id(session_id)?;
    Ok(root
        .join(SESSIONS_DIR)
        .join(shard(session_id))
        .join(session_id))
}

/// `000001`: the directory that holds a segment number's segment files.
pub fn segment_dir(session_dir: &Path, segment: u64) -> PathBuf {
    session_dir.join(format!("{segment:06}"))
}

pub fn snapshot_path(session_dir: &Path, generation: u64) -> PathBuf {
    session_dir
        .join("snapshots")
        .join(format!("{generation:012}.snap"))
}

pub fn history_dir(session_dir: &Path) -> PathBuf {
    session_dir.join("history")
}

pub fn list_index_path(root: &Path) -> PathBuf {
    root.join(LIST_INDEX_DIR).join("list.000000")
}

pub fn asset_path(root: &Path, digest: &str) -> PathBuf {
    root.join(ASSETS_DIR).join(&digest[..2]).join(&digest[2..])
}

pub fn loop_journal_path(root: &Path, loop_id: &str) -> JsonlResult<PathBuf> {
    validate_loop_id(loop_id)?;
    Ok(root.join(LOOPS_DIR).join(format!("{loop_id}.jsonl")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_cannot_escape_their_directory() {
        for bad in ["", ".", "..", "a/b", "a\\b", "a\0b", "a b"] {
            assert!(validate_session_id(bad).is_err(), "{bad:?}");
        }
        assert!(validate_session_id("ars_0123-abcd.ef:01").is_ok());
    }

    #[test]
    fn segment_numbers_roll_into_numbered_directories() {
        let base = Path::new("/sessions/ab/ars_x");
        assert!(segment_dir(base, 0).ends_with("000000"));
        assert!(segment_dir(base, 1).ends_with("000001"));
        assert!(segment_dir(base, 9).ends_with("000009"));
    }

    #[test]
    fn assets_shard_on_the_first_two_hex_characters() {
        let digest = sha256_hex(b"hello");
        let path = asset_path(Path::new("/root"), &digest);
        assert_eq!(path.parent().unwrap().file_name().unwrap(), &digest[..2]);
    }
}
