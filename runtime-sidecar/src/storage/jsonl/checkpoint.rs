//! Rebuildable snapshots anchored to an already committed log prefix.
use super::{JsonlResult, layout};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
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

pub fn read<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() < 65 || bytes[0] != 1 {
        return None;
    }
    if layout::sha256_hex(&bytes[65..]).as_bytes() != &bytes[1..65] {
        return None;
    }
    serde_json::from_slice(&bytes[65..]).ok()
}

/// Source logs are already synced. Publish the complete, durable snapshot only
/// after its bytes reach disk; incomplete snapshots fall back to the log.
pub fn write(path: &Path, value: &impl Serialize) -> JsonlResult<()> {
    let payload = serde_json::to_vec(value)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&[1])?;
        file.write_all(layout::sha256_hex(&payload).as_bytes())?;
        file.write_all(&payload)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        fs::File::open(path.parent().expect("checkpoint directory"))?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
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
