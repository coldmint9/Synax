//! A bounded WAL writer. Acknowledgements are sent only after the group's WAL sync.
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use rocksdb::{DB, WriteBatch, WriteOptions};

const MAX_PENDING: usize = 1024;
const MAX_GROUP: usize = 64;
const GROUP_DELAY: Duration = Duration::from_millis(2);

type CommitResult = Result<(), String>;
struct Request {
    batch: WriteBatch,
    immediate: bool,
    reply: mpsc::SyncSender<CommitResult>,
}

trait Wal: Send + 'static {
    fn write(&mut self, batch: WriteBatch) -> CommitResult;
    fn sync(&mut self) -> CommitResult;
}
struct RocksWal(Arc<DB>);
impl Wal for RocksWal {
    fn write(&mut self, batch: WriteBatch) -> CommitResult {
        let mut options = WriteOptions::default();
        options.set_sync(false);
        self.0
            .write_opt(batch, &options)
            .map_err(|error| error.to_string())
    }
    fn sync(&mut self) -> CommitResult {
        self.0.flush_wal(true).map_err(|error| error.to_string())
    }
}

pub struct Committer {
    sender: Option<mpsc::SyncSender<Request>>,
    worker: Option<JoinHandle<()>>,
}
impl Committer {
    pub fn new(db: Arc<DB>) -> Self {
        Self::with_wal(RocksWal(db))
    }
    fn with_wal(wal: impl Wal) -> Self {
        let (sender, receiver) = mpsc::sync_channel(MAX_PENDING);
        let worker = thread::Builder::new()
            .name("runtime-wal".into())
            .spawn(move || run(wal, receiver))
            .expect("start WAL writer");
        Self {
            sender: Some(sender),
            worker: Some(worker),
        }
    }
    /// Called from storage's blocking executor, never a Tokio networking worker.
    pub fn commit(&self, batch: WriteBatch, immediate: bool) -> CommitResult {
        let (reply, result) = mpsc::sync_channel(1);
        self.sender
            .as_ref()
            .ok_or("WAL writer stopped")?
            .send(Request {
                batch,
                immediate,
                reply,
            })
            .map_err(|_| "WAL writer stopped")?;
        result
            .recv()
            .map_err(|_| "DURABILITY_UNKNOWN: WAL writer stopped before acknowledgement")?
    }
}
impl Drop for Committer {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn run(mut wal: impl Wal, receiver: mpsc::Receiver<Request>) {
    while let Ok(first) = receiver.recv() {
        let immediate = first.immediate;
        let mut group = vec![first];
        let deadline = Instant::now() + GROUP_DELAY;
        if !immediate {
            while group.len() < MAX_GROUP {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                match receiver.recv_timeout(remaining) {
                    Ok(next) => {
                        let immediate = next.immediate;
                        group.push(next);
                        if immediate {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        let mut replies = Vec::with_capacity(group.len());
        for request in group {
            replies.push((request.reply, wal.write(request.batch)));
        }
        // A failed sync leaves even successful writes with unknown durability.
        let barrier = wal
            .sync()
            .map_err(|error| format!("DURABILITY_UNKNOWN: {error}"));
        for (reply, write) in replies {
            let _ = reply.send(write.and(barrier.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ControlledWal {
        entered: mpsc::SyncSender<()>,
        release: mpsc::Receiver<CommitResult>,
    }
    impl Wal for ControlledWal {
        fn write(&mut self, _: WriteBatch) -> CommitResult {
            Ok(())
        }
        fn sync(&mut self) -> CommitResult {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap()
        }
    }

    #[test]
    fn acknowledgement_waits_for_sync_and_propagates_failure() {
        for outcome in [Ok(()), Err("injected fsync failure".into())] {
            let (entered, waiting) = mpsc::sync_channel(1);
            let (release, blocked) = mpsc::sync_channel(1);
            let writer = Arc::new(Committer::with_wal(ControlledWal {
                entered,
                release: blocked,
            }));
            let clone = writer.clone();
            let (finished, result) = mpsc::sync_channel(1);
            let task = thread::spawn(move || {
                finished
                    .send(clone.commit(WriteBatch::default(), false))
                    .unwrap();
            });
            waiting.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
            release.send(outcome.clone()).unwrap();
            let actual = result.recv_timeout(Duration::from_secs(2)).unwrap();
            match outcome {
                Ok(()) => assert!(actual.is_ok()),
                Err(_) => assert!(actual.unwrap_err().starts_with("DURABILITY_UNKNOWN:")),
            }
            task.join().unwrap();
        }
    }

    #[test]
    fn queued_group_members_share_one_barrier() {
        struct CountingWal(Arc<std::sync::atomic::AtomicUsize>);
        impl Wal for CountingWal {
            fn write(&mut self, _: WriteBatch) -> CommitResult {
                Ok(())
            }
            fn sync(&mut self) -> CommitResult {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }
        }
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (sender, receiver) = mpsc::sync_channel(MAX_PENDING);
        let mut results = Vec::new();
        for _ in 0..8 {
            let (reply, result) = mpsc::sync_channel(1);
            sender
                .send(Request {
                    batch: WriteBatch::default(),
                    immediate: false,
                    reply,
                })
                .unwrap();
            results.push(result);
        }
        drop(sender);
        run(CountingWal(count.clone()), receiver);
        for result in results {
            assert!(result.recv().unwrap().is_ok());
        }
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
