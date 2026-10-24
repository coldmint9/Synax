use super::*;
use serde_json::{Value, json};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("synax-checkpoint-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self) -> PathBuf {
        self.0.join("checkpoint.bin")
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn legacy(path: &Path, payload: &[u8]) {
    let mut file = fs::File::create(path).unwrap();
    file.write_all(&[1]).unwrap();
    file.write_all(layout::sha256_hex(payload).as_bytes())
        .unwrap();
    file.write_all(payload).unwrap();
    file.sync_all().unwrap();
}

fn reseal(bytes: &mut [u8]) {
    let digest = layout::sha256_hex(&bytes[HEADER..]);
    bytes[1..HEADER].copy_from_slice(digest.as_bytes());
}

#[test]
fn legacy_and_compressed_snapshots_preserve_values_and_bytes() {
    let directory = Directory::new();
    let value = json!({"text":"中文与 emoji 🦀\n".repeat(5000), "empty":null,
        "integer":u64::MAX, "decimal":0.12345678901234568, "array":[true, false, [], {}]});
    let payload = serde_json::to_vec(&value).unwrap();
    legacy(&directory.file(), &payload);
    assert_eq!(read::<Value>(&directory.file()), Some(value.clone()));
    write(&directory.file(), &value).unwrap();
    let encoded = fs::read(directory.file()).unwrap();
    assert_eq!(encoded[0], 2);
    assert!(encoded.len() < payload.len() / 4);
    assert_eq!(
        zstd::stream::decode_all(&encoded[HEADER + 8..]).unwrap(),
        payload
    );
    assert_eq!(read::<Value>(&directory.file()), Some(value));
}

#[test]
fn malformed_snapshots_are_rejected_even_with_a_valid_outer_checksum() {
    let directory = Directory::new();
    write(&directory.file(), &json!({"body":"abc".repeat(1000)})).unwrap();
    let valid = fs::read(directory.file()).unwrap();
    let mut cases = vec![vec![], valid[..30].to_vec(), valid[..HEADER + 4].to_vec()];
    let mut unsupported = valid.clone();
    unsupported[0] = 3;
    cases.push(unsupported);
    let mut checksum = valid.clone();
    checksum[5] ^= 1;
    cases.push(checksum);
    let mut truncated = valid[..valid.len() - 1].to_vec();
    reseal(&mut truncated);
    cases.push(truncated);
    for length in [0, 1, 3000, u64::MAX] {
        let mut size = valid.clone();
        size[HEADER..HEADER + 8].copy_from_slice(&length.to_le_bytes());
        reseal(&mut size);
        cases.push(size);
    }
    let mut invalid_zstd = valid.clone();
    invalid_zstd[HEADER + 8] ^= 0xff;
    reseal(&mut invalid_zstd);
    cases.push(invalid_zstd);
    let mut extra = valid.clone();
    extra.extend_from_slice(b"junk");
    reseal(&mut extra);
    cases.push(extra);
    for bytes in cases {
        fs::write(directory.file(), bytes).unwrap();
        assert!(read::<Value>(&directory.file()).is_none());
    }
    legacy(&directory.file(), b"{invalid");
    assert!(read::<Value>(&directory.file()).is_none());
}

#[test]
fn decoder_checks_exact_length_and_trailing_data() {
    let payload = br#"{"number":123,"body":"hello"}"#;
    assert_eq!(
        decode_json::<Value>(&payload[..], payload.len() as u64),
        Some(json!({"number":123,"body":"hello"}))
    );
    for length in [payload.len() as u64 - 1, payload.len() as u64 + 1, u64::MAX] {
        assert!(decode_json::<Value>(&payload[..], length).is_none());
    }
    let mut extra = payload.to_vec();
    extra.extend_from_slice(b"false");
    assert!(decode_json::<Value>(&extra[..], extra.len() as u64).is_none());
}

#[test]
fn abandoning_or_failing_a_stage_keeps_the_previous_snapshot_and_cleans_temps() {
    let directory = Directory::new();
    write(&directory.file(), &json!({"revision":1})).unwrap();
    let staged = Pending::new(directory.file(), &json!({"revision":2}))
        .unwrap()
        .stage()
        .unwrap();
    assert_eq!(
        read::<Value>(&directory.file()),
        Some(json!({"revision":1}))
    );
    drop(staged);
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    assert_eq!(
        read::<Value>(&directory.file()),
        Some(json!({"revision":1}))
    );
    let blocked = directory.0.join("blocked");
    fs::create_dir(&blocked).unwrap();
    assert!(
        Pending::new(blocked, &json!({"revision":2}))
            .unwrap()
            .stage()
            .unwrap()
            .publish()
            .is_err()
    );
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
    assert_eq!(
        read::<Value>(&directory.file()),
        Some(json!({"revision":1}))
    );
}

// Explicit opt-in: reads user-selected samples and writes only in a fresh temp
// directory. Useful for repeatable release-mode storage/latency comparisons.
#[test]
#[ignore = "set SYNAX_CHECKPOINT_BENCH_DIR to a session directory; run in release mode"]
fn benchmark_checkpoint_codec() {
    use std::time::Instant;
    let source =
        PathBuf::from(std::env::var("SYNAX_CHECKPOINT_BENCH_DIR").expect("sample directory"));
    let directory = Directory::new();
    for name in ["runtime-checkpoint.bin", "history/history-index.bin"] {
        let source_path = source.join(name);
        let value: Value = read(&source_path).expect("valid source snapshot");
        let payload = serde_json::to_vec(&value).unwrap();
        let mut old_write = Vec::new();
        let mut new_write = Vec::new();
        let mut old_read = Vec::new();
        let mut new_read = Vec::new();
        let mut encoded_size = 0;
        for _ in 0..5 {
            let start = Instant::now();
            legacy(&directory.file(), &payload);
            // The old writer also syncs the containing directory after rename.
            fs::File::open(&directory.0).unwrap().sync_all().unwrap();
            old_write.push(start.elapsed().as_micros());
            let start = Instant::now();
            let bytes = fs::read(directory.file()).unwrap();
            assert_eq!(
                layout::sha256_hex(&bytes[HEADER..]).as_bytes(),
                &bytes[1..HEADER]
            );
            let restored: Value = serde_json::from_slice(&bytes[HEADER..]).unwrap();
            old_read.push(start.elapsed().as_micros());
            assert_eq!(restored, value);
            drop(restored);
            drop(bytes);
            let pending = Pending {
                path: directory.file(),
                payload: payload.clone(),
            };
            let start = Instant::now();
            pending.stage().unwrap().publish().unwrap();
            new_write.push(start.elapsed().as_micros());
            encoded_size = fs::metadata(directory.file()).unwrap().len();
            let start = Instant::now();
            let restored: Value = read(&directory.file()).unwrap();
            new_read.push(start.elapsed().as_micros());
            assert_eq!(restored, value);
        }
        for times in [&mut old_write, &mut new_write, &mut old_read, &mut new_read] {
            times.sort();
        }
        println!(
            "{}",
            json!({"file":name,"raw_bytes":payload.len()+HEADER,"compressed_bytes":encoded_size,
            "median_legacy_write_us":old_write[2],"median_compressed_write_us":new_write[2],
            "median_legacy_read_us":old_read[2],"median_compressed_read_us":new_read[2]})
        );
    }
}

#[test]
#[ignore = "large snapshot scaling benchmark; run in release mode"]
fn benchmark_large_checkpoint_codec() {
    use std::time::Instant;
    let source =
        PathBuf::from(std::env::var("SYNAX_CHECKPOINT_BENCH_DIR").expect("sample directory"));
    let value: Value = read(&source.join("runtime-checkpoint.bin")).unwrap();
    let source_bytes = serde_json::to_vec(&value).unwrap();
    drop(value);
    let directory = Directory::new();
    for copies in [2, 4] {
        let mut payload = vec![b'['];
        for index in 0..copies {
            if index > 0 {
                payload.push(b',');
            }
            payload.extend_from_slice(&source_bytes);
        }
        payload.push(b']');
        let raw_bytes = payload.len();
        legacy(&directory.file(), &payload);
        let start = Instant::now();
        let bytes = fs::read(directory.file()).unwrap();
        assert_eq!(
            layout::sha256_hex(&bytes[HEADER..]).as_bytes(),
            &bytes[1..HEADER]
        );
        let expected: Value = serde_json::from_slice(&bytes[HEADER..]).unwrap();
        let legacy_read_ms = start.elapsed().as_millis();
        drop(bytes);
        Pending {
            path: directory.file(),
            payload,
        }
        .stage()
        .unwrap()
        .publish()
        .unwrap();
        let start = Instant::now();
        let restored: Value = read(&directory.file()).unwrap();
        let compressed_read_ms = start.elapsed().as_millis();
        assert_eq!(restored, expected);
        println!(
            "{}",
            json!({"copies":copies,"raw_bytes":raw_bytes,"compressed_bytes":fs::metadata(directory.file()).unwrap().len(),
            "legacy_read_ms":legacy_read_ms,"compressed_read_ms":compressed_read_ms})
        );
    }
}
