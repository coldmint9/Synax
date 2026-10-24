//! Rebuildable snapshots anchored to an already committed log prefix.
use super::{JsonlResult, layout};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Position {
    pub offset: u64,
    digest: String,
}

impl Position {
    pub fn capture(path: &Path, offset: u64) -> JsonlResult<Self> {
        let mut file = fs::File::open(path)?;
        if file.metadata()?.len() < offset {
            return Err(super::JsonlError::corrupt(
                path,
                offset,
                "checkpoint exceeds source",
            ));
        }
        let start = offset.saturating_sub(4096);
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; (offset - start) as usize];
        file.read_exact(&mut bytes)?;
        Ok(Self {
            offset,
            digest: layout::sha256_hex(&bytes),
        })
    }

    pub fn valid(&self, path: &Path) -> bool {
        Self::capture(path, self.offset).is_ok_and(|current| current.digest == self.digest)
    }
}

// V1: version + SHA-256 hex + JSON. V2: version + SHA-256 hex +
// decoded length (LE u64) + Zstd frame. V2 hashes the length and frame together.
// Old readers ignore V2 and rebuild from authoritative, unchanged logs.
const HEADER: usize = 65;
const WINDOW_LOG: u32 = 23; // At most 8 MiB of decoder history, independent of session size.
const BUFFER: usize = 64 * 1024;

pub fn read<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let mut file = fs::File::open(path).ok()?;
    let mut header = [0; HEADER];
    file.read_exact(&mut header).ok()?;
    if !matches!(header[0], 1 | 2) {
        return None;
    }
    // Validate before parsing, without retaining a second full encoded copy.
    let mut digest = Sha256::new();
    let mut buffer = [0; BUFFER];
    let mut stored = 0u64;
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        stored = stored.checked_add(count as u64)?;
    }
    if layout::hex(&digest.finalize()).as_bytes() != &header[1..] {
        return None;
    }
    file.seek(SeekFrom::Start(HEADER as u64)).ok()?;
    if header[0] == 1 {
        return decode_json(file, stored);
    }
    let mut size = [0; 8];
    file.read_exact(&mut size).ok()?;
    let length = u64::from_le_bytes(size);
    let mut input = BufReader::with_capacity(BUFFER, file);
    // The independently encoded frame size must agree with our checksummed
    // header before reserving space. Writers always pledge their source size.
    if zstd::zstd_safe::get_frame_content_size(input.fill_buf().ok()?).ok()? != Some(length) {
        return None;
    }
    let mut decoder = zstd::stream::read::Decoder::with_buffer(input).ok()?;
    decoder.window_log_max(WINDOW_LOG).ok()?;
    decode_json(decoder, length)
}

fn decode_json<T: DeserializeOwned>(mut reader: impl Read, length: u64) -> Option<T> {
    // Keep the slice parser at every size: switching large histories to the
    // byte-at-a-time reader parser causes a cold-load latency cliff. As in V1,
    // retain one decoded JSON buffer; compressed input and codec windows are
    // bounded, and fallible exact reservation avoids geometric Vec overgrowth.
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(usize::try_from(length).ok()?)
        .ok()?;
    let count = reader.by_ref().take(length).read_to_end(&mut bytes).ok()?;
    if count as u64 != length || reader.read(&mut [0]).ok()? != 0 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// Capture/serialize while the caller owns its consistent view, then release
/// the session lock before compression and disk I/O. Callers bound concurrency
/// with one checkpoint gate per session; there is no background work queue.
pub struct Pending {
    path: PathBuf,
    payload: Vec<u8>,
}

impl Pending {
    pub fn new(path: PathBuf, value: &impl Serialize) -> JsonlResult<Self> {
        Ok(Self {
            path,
            payload: serde_json::to_vec(value)?,
        })
    }

    pub fn stage(self) -> JsonlResult<Staged> {
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let staged = Staged {
            path: self.path,
            temporary,
        };
        file.write_all(&[2])?;
        file.write_all(&[0; 64])?;
        let mut output = HashWriter {
            inner: BufWriter::with_capacity(BUFFER, file),
            digest: Sha256::new(),
        };
        output.write_all(&(self.payload.len() as u64).to_le_bytes())?;
        // Single-threaded, low fixed level. No per-session worker threads or
        // growing compression dictionaries, even for long-lived sessions.
        let mut encoder = zstd::stream::write::Encoder::new(output, 1)?;
        encoder.window_log(WINDOW_LOG)?;
        encoder.set_pledged_src_size(Some(self.payload.len() as u64))?;
        encoder.write_all(&self.payload)?;
        let mut output = encoder.finish()?;
        output.inner.flush()?;
        let digest = layout::hex(&output.digest.finalize());
        let mut file = output
            .inner
            .into_inner()
            .map_err(|error| error.into_error())?;
        file.seek(SeekFrom::Start(1))?;
        file.write_all(digest.as_bytes())?;
        file.sync_all()?;
        Ok(staged)
    }
}

struct HashWriter<W> {
    inner: W,
    digest: Sha256,
}
impl<W: Write> Write for HashWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let count = self.inner.write(bytes)?;
        self.digest.update(&bytes[..count]);
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// An unpublished, fully synced file. Failed/discarded stages remove only
/// their own temporary file and leave the previous checkpoint intact.
pub struct Staged {
    path: PathBuf,
    temporary: PathBuf,
}
impl Staged {
    pub fn publish(self) -> JsonlResult<()> {
        fs::rename(&self.temporary, &self.path)?;
        #[cfg(unix)]
        fs::File::open(self.path.parent().expect("checkpoint directory"))?.sync_all()?;
        Ok(())
    }
}
impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.temporary);
    }
}

/// Exclusive owners (e.g. history eviction) need no separate capture/publish.
#[cfg(test)]
pub fn write(path: &Path, value: &impl Serialize) -> JsonlResult<()> {
    Pending::new(path.to_path_buf(), value)?.stage()?.publish()
}

pub mod bytes {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(value))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        STANDARD
            .decode(String::deserialize(deserializer)?)
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests;
