//! Segment files: length-prefixed frames over an append-only file.
//!
//! A frame is `u32` little-endian payload length followed by the payload.
//! Length framing makes a torn tail exact (a half-written length or a payload
//! shorter than its prefix fails the bounds check) and lets a JSON string
//! contain newlines or braces without splitting a record.

use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};

use super::error::{JsonlError, JsonlResult};

/// Largest accepted frame payload.
pub const MAX_FRAME: usize = 4 * 1024 * 1024;

pub const HEADER_BYTES: usize = 4;

/// A frame as found while scanning a file.
#[derive(Debug, Clone, Copy)]
pub struct FrameMeta {
    pub offset: u64,
    pub length: u32,
}

/// Result of scanning a file from an offset.
pub struct Tail {
    /// Frames from `offset` to the last complete frame.
    pub frames: Vec<FrameMeta>,
    /// Byte offset just past the last complete frame.
    pub end: u64,
    /// True when a complete frame at `end` cannot be parsed or a later frame
    /// follows a gap; the caller decides whether that is corruption.
    pub torn: bool,
}

/// Read one frame at `offset`; `None` when the frame is incomplete.
pub fn frame_at(file: &File, offset: u64, file_len: u64) -> JsonlResult<Option<(Vec<u8>, u64)>> {
    if offset + HEADER_BYTES as u64 > file_len {
        return Ok(None);
    }
    let mut header = [0u8; HEADER_BYTES];
    file.read_exact_at(&mut header, offset)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Ok(None);
    }
    let start = offset + HEADER_BYTES as u64;
    if start + length as u64 > file_len {
        return Ok(None);
    }
    let mut payload = vec![0u8; length];
    file.read_exact_at(&mut payload, start)?;
    Ok(Some((payload, start + length as u64)))
}

/// Scan frames from `offset` up to the end of file.
pub fn scan(path: &Path, offset: u64) -> JsonlResult<Tail> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Tail {
                frames: Vec::new(),
                end: offset,
                torn: false,
            });
        }
        Err(error) => return Err(JsonlError::io(error)),
    };
    let len = file.metadata()?.len();
    let mut cursor = offset;
    let mut frames = Vec::new();
    while let Some((_, next)) = frame_at(&file, cursor, len)? {
        frames.push(FrameMeta {
            offset: cursor,
            length: (next - cursor - HEADER_BYTES as u64) as u32,
        });
        cursor = next;
    }
    Ok(Tail {
        frames,
        end: cursor,
        torn: cursor != len,
    })
}

/// Visit committed frames without retaining an entire segment in memory.
pub fn visit(path: &Path, start: u64, end: u64, mut consume: impl FnMut(u64, &[u8]) -> JsonlResult<()>) -> JsonlResult<()> {
    if start == end { return Ok(()); }
    let file = File::open(path).map_err(JsonlError::io)?;
    if end > file.metadata()?.len() || start > end {
        return Err(JsonlError::corrupt(path, start, "committed extent exceeds file"));
    }
    let mut offset = start;
    while offset < end {
        let (payload, next) = frame_at(&file, offset, end)?
            .ok_or_else(|| JsonlError::corrupt(path, offset, "incomplete committed frame"))?;
        consume(offset, &payload)?;
        offset = next;
    }
    Ok(())
}

/// Scan a possibly torn append tail; complete records are visited one at a time.
pub fn visit_complete(path: &Path, mut consume: impl FnMut(u64, &[u8]) -> JsonlResult<()>) -> JsonlResult<u64> {
    visit_complete_from(path, 0, &mut consume)
}

pub fn visit_complete_from(path: &Path, start: u64, mut consume: impl FnMut(u64, &[u8]) -> JsonlResult<()>) -> JsonlResult<u64> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(JsonlError::io(error)),
    };
    let end = file.metadata()?.len();
    if start > end { return Err(JsonlError::corrupt(path, start, "cursor exceeds log")); }
    let mut offset = start;
    while let Some((payload, next)) = frame_at(&file, offset, end)? {
        consume(offset, &payload)?;
        offset = next;
    }
    Ok(offset)
}

/// Every frame of a file, in order, decoded by the caller.
pub fn read_all(path: &Path) -> JsonlResult<Vec<(u64, Vec<u8>)>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(JsonlError::io(error)),
    };
    let len = file.metadata()?.len();
    let mut frames = Vec::new();
    let mut cursor = 0;
    while let Some((payload, next)) = frame_at(&file, cursor, len)? {
        frames.push((cursor, payload));
        cursor = next;
    }
    Ok(frames)
}

/// An append handle for one segment file.
pub struct SegLog {
    path: PathBuf,
    file: std::sync::Arc<File>,
    len: u64,
    frames: u64,
    dirty: bool,
}

impl SegLog {
    /// Open (creating) `path` for append, truncating any torn tail first.
    pub fn open(path: &Path) -> JsonlResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(JsonlError::io)?;
        }
        let tail = scan(path, 0)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)
            .map_err(JsonlError::io)?;
        if tail.torn {
            file.set_len(tail.end).map_err(JsonlError::io)?;
        }
        Ok(Self {
            path: path.to_path_buf(),
            file: std::sync::Arc::new(file),
            len: tail.end,
            frames: tail.frames.len() as u64,
            dirty: false,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Append encoded frames in one vectorized write.
    pub fn append(&mut self, payloads: &[&[u8]]) -> JsonlResult<()> {
        let mut buf = Vec::with_capacity(payloads.iter().map(|p| p.len() + HEADER_BYTES).sum());
        for payload in payloads {
            if payload.len() > MAX_FRAME {
                return Err(JsonlError::corrupt(
                    &self.path,
                    self.len,
                    "frame exceeds MAX_FRAME",
                ));
            }
            buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            buf.extend_from_slice(payload);
        }
        if let Err(error) = self.file.write_all(&buf) {
            // Leave the file at the last complete frame so the next reader
            // never sees a partial record from a failed batch.
            let _ = self.file.set_len(self.len);
            return Err(JsonlError::io(error));
        }
        self.len += buf.len() as u64;
        self.frames += payloads.len() as u64;
        self.dirty = true;
        Ok(())
    }

    /// A handle that fsync can run on another thread.
    pub fn shared(&self) -> std::sync::Arc<File> {
        self.file.clone()
    }

    pub fn clear_dirty(&mut self) {
        self.dirty = false;
    }

    /// Flush file data to stable media.
    pub fn sync(&mut self) -> JsonlResult<()> {
        if self.dirty {
            self.file.sync_data().map_err(JsonlError::io)?;
            self.dirty = false;
        }
        Ok(())
    }

    /// Drop everything past `offset`; `frames` is the frame count kept.
    pub fn truncate(&mut self, offset: u64, frames: u64) -> JsonlResult<()> {
        self.file.set_len(offset).map_err(JsonlError::io)?;
        self.len = offset;
        self.frames = frames;
        self.dirty = true;
        Ok(())
    }

    /// Rewrite the file from scratch with `payloads` (compaction).
    pub fn rewrite(&mut self, payloads: &[&[u8]]) -> JsonlResult<()> {
        let mut buf = Vec::new();
        for payload in payloads {
            buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            buf.extend_from_slice(payload);
        }
        let mut fresh = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.path)
            .map_err(JsonlError::io)?;
        fresh.write_all(&buf).map_err(JsonlError::io)?;
        self.file = std::sync::Arc::new(fresh);
        self.len = buf.len() as u64;
        self.frames = payloads.len() as u64;
        self.dirty = true;
        self.file
            .seek(SeekFrom::Start(self.len))
            .map_err(JsonlError::io)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("synax-seglog-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn frames_round_trip_and_report_their_offsets() {
        let dir = dir("roundtrip");
        let path = dir.join("f.log");
        let mut log = SegLog::open(&path).unwrap();
        log.append(&[b"{\"a\":1}", b"{\"b\":2}"]).unwrap();
        assert_eq!(log.frames(), 2);
        let frames = read_all(&path).unwrap();
        assert_eq!(frames[0].1, b"{\"a\":1}");
        assert_eq!(frames[1].0, 7 + 4);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_torn_tail_is_dropped_at_every_byte_boundary() {
        let dir = dir("torn");
        let path = dir.join("f.log");
        let mut log = SegLog::open(&path).unwrap();
        log.append(&[
            b"{\"first\":true}",
            b"{\"second\":\"payload with \\\" and \\n\"}",
        ])
        .unwrap();
        log.sync().unwrap();
        let complete = fs::read(&path).unwrap();
        let boundary = 4 + b"{\"first\":true}".len();

        for cut in boundary + 1..complete.len() {
            let torn = dir.join(format!("torn-{cut}.log"));
            fs::write(&torn, &complete[..cut]).unwrap();
            let mut reopened = SegLog::open(&torn).unwrap();
            assert_eq!(reopened.len(), boundary as u64, "cut at {cut}");
            assert_eq!(reopened.frames(), 1);
            reopened.append(&[b"{}"]).unwrap();
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_payload_with_newlines_stays_one_frame() {
        let dir = dir("newline");
        let path = dir.join("f.log");
        let mut log = SegLog::open(&path).unwrap();
        log.append(&[b"{\"text\":\"a\\nb\\nc\"}"]).unwrap();
        let frames = read_all(&path).unwrap();
        assert_eq!(frames.len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_append_leaves_the_previous_frames_intact() {
        let dir = dir("fail");
        let path = dir.join("f.log");
        let mut log = SegLog::open(&path).unwrap();
        log.append(&[b"{\"ok\":true}"]).unwrap();
        let huge = vec![b'x'; MAX_FRAME + 1];
        assert!(log.append(&[&huge]).is_err());
        assert_eq!(read_all(&path).unwrap().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
}
