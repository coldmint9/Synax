//! Content-addressed values too large for a frame.
//!
//! A blob is stored under the SHA-256 of its bytes and referenced by
//! `{"$blob":"sha256:<hex>","bytes":N}`. Writing is temp-file + rename, so a
//! reader never sees a partial blob.

use std::fs;
use std::io::Write;
use std::path::Path;

use super::error::JsonlResult;
use super::layout::{asset_path, sha256_hex};

pub fn put(root: &Path, bytes: &[u8]) -> JsonlResult<String> {
    let digest = sha256_hex(bytes);
    let path = asset_path(root, &digest);
    if path.exists() {
        return Ok(digest);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(super::error::JsonlError::io)?;
    }
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::File::create(&temp).map_err(super::error::JsonlError::io)?;
    file.write_all(bytes)
        .map_err(super::error::JsonlError::io)?;
    file.sync_data().map_err(super::error::JsonlError::io)?;
    drop(file);
    fs::rename(&temp, &path).map_err(super::error::JsonlError::io)?;
    #[cfg(unix)]
    fs::File::open(path.parent().unwrap())?
        .sync_all()
        .map_err(super::error::JsonlError::io)?;
    Ok(digest)
}

pub fn get(root: &Path, digest: &str) -> JsonlResult<Option<Vec<u8>>> {
    match fs::read(asset_path(root, digest)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(super::error::JsonlError::io(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blobs_round_trip_and_deduplicate() {
        let root = std::env::temp_dir().join(format!("synax-assets-{}", uuid::Uuid::new_v4()));
        let first = put(&root, b"hello").unwrap();
        let second = put(&root, b"hello").unwrap();
        assert_eq!(first, second);
        assert_eq!(get(&root, &first).unwrap().unwrap(), b"hello");
        assert!(get(&root, &sha256_hex(b"absent")).unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
