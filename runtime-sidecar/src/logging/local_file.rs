//! Calendar-day rotation in the same local timezone used by the log formatter.
//! This writer only runs on tracing-appender's dedicated file worker.
use chrono::{Local, NaiveDate};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
};

const RETAIN_FILES: usize = 7;

pub(super) struct LocalDailyWriter {
    directory: PathBuf,
    day: NaiveDate,
    file: BufWriter<File>,
}

fn open_file(directory: &Path, day: NaiveDate) -> io::Result<BufWriter<File>> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(directory.join(format!("runtime.{day}.jsonl")))
        .map(|file| BufWriter::with_capacity(64 * 1024, file))
}

impl LocalDailyWriter {
    pub(super) fn new(directory: PathBuf) -> io::Result<Self> {
        Self::for_day(directory, Local::now().date_naive())
    }

    fn for_day(directory: PathBuf, day: NaiveDate) -> io::Result<Self> {
        fs::create_dir_all(&directory)?;
        let file = open_file(&directory, day)?;
        let writer = Self {
            directory,
            day,
            file,
        };
        writer.prune()?;
        Ok(writer)
    }

    fn prune(&self) -> io::Result<()> {
        let mut files = Vec::new();
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(day) = name
                .to_str()
                .and_then(|name| name.strip_prefix("runtime."))
                .and_then(|name| name.strip_suffix(".jsonl"))
            else {
                continue;
            };
            let Ok(date) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else {
                continue;
            };
            if day != date.to_string() {
                continue;
            }
            files.push((date, entry.path()));
        }
        files.sort_by_key(|(day, _)| *day);
        let remove = files.len().saturating_sub(RETAIN_FILES);
        // Include today's open file in the retention budget. Reopening it must
        // not remove another day, including after a clock/timezone change.
        for (_, path) in files
            .iter()
            .filter(|(day, _)| *day != self.day)
            .take(remove)
        {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn write_on_day(&mut self, bytes: &[u8], day: NaiveDate) -> io::Result<usize> {
        if day != self.day {
            self.file.flush()?;
            let file = open_file(&self.directory, day)?;
            self.file = file;
            self.day = day;
            self.prune()?;
        }
        self.file.write(bytes)
    }
}

impl Write for LocalDailyWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.write_on_day(bytes, Local::now().date_naive())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_midnight_rotates_and_restarts_preserve_the_retention_window() {
        let directory =
            std::env::temp_dir().join(format!("synax-local-log-{}", uuid::Uuid::new_v4()));
        let first = NaiveDate::from_ymd_opt(2026, 10, 20).unwrap();
        let mut writer = LocalDailyWriter::for_day(directory.clone(), first).unwrap();
        for offset in 0..9 {
            let day = first + chrono::Days::new(offset);
            writer
                .write_on_day(format!("day {day}\n").as_bytes(), day)
                .unwrap();
        }
        writer.flush().unwrap();
        drop(writer);
        fs::write(directory.join("runtime.unrelated.jsonl"), "keep").unwrap();
        let last = first + chrono::Days::new(8);
        for _ in 0..3 {
            drop(LocalDailyWriter::for_day(directory.clone(), last).unwrap());
        }
        assert!(!directory.join(format!("runtime.{first}.jsonl")).exists());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 8); // Seven days + unrelated file.
        assert_eq!(
            fs::read_to_string(directory.join(format!("runtime.{last}.jsonl"))).unwrap(),
            format!("day {last}\n")
        );
        assert_eq!(
            fs::read_to_string(directory.join("runtime.unrelated.jsonl")).unwrap(),
            "keep"
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
