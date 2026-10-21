//! The single-writer lock for a store root.

use std::fs::{self, File, OpenOptions};
use std::path::Path;

use super::error::{JsonlError, JsonlResult};

/// An exclusive store lock, released when dropped.
pub struct StoreLock {
    _file: File,
}

impl StoreLock {
    pub fn acquire(root: &Path) -> JsonlResult<Self> {
        fs::create_dir_all(root).map_err(JsonlError::io)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(root.join(super::layout::LOCK_FILE))
            .map_err(JsonlError::io)?;
        if !flock_exclusive(&file)? {
            return Err(JsonlError::Busy(root.to_path_buf()));
        }
        Ok(Self { _file: file })
    }
}

#[cfg(unix)]
fn flock_exclusive(file: &File) -> JsonlResult<bool> {
    use std::os::unix::io::AsRawFd;
    unsafe extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }
    const LOCK_EX: i32 = 2;
    const LOCK_NB: i32 = 4;
    // SAFETY: the descriptor is owned by `file` for the whole call.
    let result = unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::WouldBlock {
        return Ok(false);
    }
    Err(JsonlError::io(error))
}

#[cfg(not(unix))]
fn flock_exclusive(_file: &File) -> JsonlResult<bool> {
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_second_writer_is_refused_until_the_first_releases() {
        let root = std::env::temp_dir().join(format!("synax-lock-{}", uuid::Uuid::new_v4()));
        let first = StoreLock::acquire(&root).unwrap();
        assert!(StoreLock::acquire(&root).is_err());
        drop(first);
        assert!(StoreLock::acquire(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
