//! File metadata belongs to Rust. Background walks are bounded, interruptible,
//! ignore-aware and deliberately stop at wide directories; UI queries page them.
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::{Semaphore, mpsc};

const EAGER_LIMIT: usize = 100;
const PAGE_LIMIT: usize = 100;
const MAX_ROOTS: usize = 128;
const MAX_QUEUE: usize = 512;
const CACHE_BYTES: usize = 64 * 1024 * 1024;
const MAX_ROOT_PAGES: usize = 2048;
const MAX_WATCHES: usize = 4096;
const MAX_RESPONSE_BYTES: usize = 768 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("{0}")]
    Invalid(String),
    #[error("workspace path is outside its root or traverses a symbolic link")]
    Outside,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("workspace index budget exhausted; retry later")]
    Busy,
    #[error("directory changed; restart from the first page")]
    Stale,
}
impl IndexError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Outside | Self::Invalid(_) => "INVALID_PATH",
            Self::Busy => "BACKPRESSURE",
            Self::Stale => "INDEX_CURSOR_STALE",
            Self::Io(e) if e.kind() == std::io::ErrorKind::NotFound => "INDEX_NOT_FOUND",
            Self::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied => "INDEX_FORBIDDEN",
            Self::Io(_) => "INDEX_IO_ERROR",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub host_path: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub show_hidden: bool,
    #[serde(default)]
    pub show_ignored: bool,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    kind: String,
    has_children: bool,
    ignored: bool,
}
impl Entry {
    fn key(&self) -> (u8, String) {
        (u8::from(self.kind != "directory"), self.name.clone())
    }
    fn bytes(&self) -> usize {
        self.name.len() + self.path.len() + 96
    }
}

#[derive(Clone)]
struct Page {
    entries: Arc<Vec<Entry>>,
    at: Instant,
    modified: Option<std::time::SystemTime>,
    bytes: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    root: String,
    path: String,
    revision: u64,
    modified_ns: Option<u64>,
    show_hidden: bool,
    show_ignored: bool,
    after: (u8, String),
}
struct Budget {
    cache: AtomicUsize,
    watches: AtomicUsize,
}
struct Root {
    path: PathBuf,
    pages: Mutex<HashMap<String, Page>>,
    rules: Mutex<HashMap<PathBuf, Arc<Gitignore>>>,
    pending: Mutex<HashSet<String>>,
    deferred: AtomicUsize,
    revision: AtomicU64,
    failures: AtomicUsize,
    cancelled: AtomicBool,
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched: Mutex<HashSet<PathBuf>>,
    budget: Arc<Budget>,
}
impl Root {
    fn invalidate(&self, event: notify::Result<Event>) {
        // Merely reading a directory can emit access events on Linux.
        if matches!(&event, Ok(e) if matches!(e.kind, EventKind::Access(_))) {
            return;
        }
        self.revision.fetch_add(1, Ordering::SeqCst);
        let mut pages = self.pages.lock().unwrap();
        let reset = match &event {
            Err(_) => true,
            Ok(e) => {
                e.need_rescan()
                    || e.paths.is_empty()
                    || e.paths
                        .iter()
                        .any(|p| p.file_name().is_some_and(|n| n == ".gitignore"))
            }
        };
        if reset {
            self.rules.lock().unwrap().clear();
        }
        pages.retain(|relative, page| {
            let full = self.path.join(relative);
            let changed = reset
                || event.as_ref().is_ok_and(|e| {
                    e.paths.iter().any(|p| {
                        full == *p || p.parent() == Some(full.as_path()) || full.starts_with(p)
                    })
                });
            if changed {
                self.budget.cache.fetch_sub(page.bytes, Ordering::Relaxed);
            }
            !changed
        });
    }
    fn watch(self: &Arc<Self>, directory: &Path) {
        let mut watched = self.watched.lock().unwrap();
        if watched.contains(directory) {
            return;
        }
        if self
            .budget
            .watches
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                (n < MAX_WATCHES).then_some(n + 1)
            })
            .is_err()
        {
            return;
        }
        let ok = self
            .watcher
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(|w| w.watch(directory, RecursiveMode::NonRecursive).is_ok());
        if ok {
            watched.insert(directory.to_owned());
        } else {
            self.budget.watches.fetch_sub(1, Ordering::Relaxed);
        }
    }
    fn store(
        &self,
        relative: &str,
        entries: Vec<Entry>,
        revision: u64,
        modified: Option<std::time::SystemTime>,
    ) {
        let bytes = entries.iter().map(Entry::bytes).sum::<usize>() + relative.len() + 128;
        let mut pages = self.pages.lock().unwrap();
        if self.cancelled.load(Ordering::Relaxed)
            || self.revision.load(Ordering::SeqCst) != revision
        {
            return;
        }
        if let Some(old) = pages.remove(relative) {
            self.budget.cache.fetch_sub(old.bytes, Ordering::Relaxed);
        }
        if pages.len() >= MAX_ROOT_PAGES {
            if let Some(key) = pages
                .iter()
                .min_by_key(|(_, p)| p.at)
                .map(|(k, _)| k.clone())
            {
                let old = pages.remove(&key).unwrap();
                self.budget.cache.fetch_sub(old.bytes, Ordering::Relaxed);
            }
        }
        if self
            .budget
            .cache
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                n.checked_add(bytes).filter(|n| *n <= CACHE_BYTES)
            })
            .is_err()
        {
            return;
        }
        pages.insert(
            relative.to_owned(),
            Page {
                entries: Arc::new(entries),
                at: Instant::now(),
                modified,
                bytes,
            },
        );
    }
    fn cached(&self, relative: &str, directory: &Path) -> Option<Arc<Vec<Entry>>> {
        let page = self.pages.lock().unwrap().get(relative).cloned()?;
        let watched = self.watched.lock().unwrap().contains(directory);
        let ttl = if watched {
            Duration::from_secs(30)
        } else {
            Duration::from_secs(2)
        };
        if page.at.elapsed() > ttl || fs::metadata(directory).ok()?.modified().ok() != page.modified
        {
            return None;
        }
        Some(page.entries)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        for page in self.pages.get_mut().unwrap().values() {
            self.budget.cache.fetch_sub(page.bytes, Ordering::Relaxed);
        }
        self.budget
            .watches
            .fetch_sub(self.watched.get_mut().unwrap().len(), Ordering::Relaxed);
    }
}

struct Job {
    root: Arc<Root>,
    relative: String,
}
pub struct WorkspaceIndex {
    roots: Mutex<HashMap<PathBuf, Arc<Root>>>,
    queue: mpsc::Sender<Job>,
    queries: Arc<Semaphore>,
    budget: Arc<Budget>,
    stopped: AtomicBool,
}
impl WorkspaceIndex {
    pub fn new() -> Arc<Self> {
        let (queue, receiver) = mpsc::channel::<Job>(MAX_QUEUE);
        let service = Arc::new(Self {
            roots: Mutex::new(HashMap::new()),
            queue,
            queries: Arc::new(Semaphore::new(4)),
            budget: Arc::new(Budget {
                cache: AtomicUsize::new(0),
                watches: AtomicUsize::new(0),
            }),
            stopped: AtomicBool::new(false),
        });
        let receiver = Arc::new(tokio::sync::Mutex::new(receiver));
        // Two background workers across ALL roots, independent of session actors
        // and the four reserved interactive read slots.
        for _ in 0..2 {
            let weak = Arc::downgrade(&service);
            let receiver = receiver.clone();
            tokio::spawn(async move {
                loop {
                    let job = receiver.lock().await.recv().await;
                    let Some(job) = job else {
                        break;
                    };
                    let Some(index) = weak.upgrade() else {
                        break;
                    };
                    if index.stopped.load(Ordering::Relaxed) {
                        break;
                    }
                    let root = job.root.clone();
                    let relative = job.relative.clone();
                    let children =
                        tokio::task::spawn_blocking(move || probe(&job.root, &job.relative)).await;
                    if let Ok(Ok(children)) = children {
                        for child in children {
                            index.enqueue(root.clone(), child);
                        }
                    } else {
                        root.failures.fetch_add(1, Ordering::Relaxed);
                    }
                    root.pending.lock().unwrap().remove(&relative);
                    tokio::task::yield_now().await;
                }
            });
        }
        service
    }
    fn enqueue(&self, root: Arc<Root>, relative: String) {
        if self.stopped.load(Ordering::Relaxed) || root.cancelled.load(Ordering::Relaxed) {
            return;
        }
        if !root.pending.lock().unwrap().insert(relative.clone()) {
            return;
        }
        if self
            .queue
            .try_send(Job {
                root: root.clone(),
                relative: relative.clone(),
            })
            .is_err()
        {
            root.pending.lock().unwrap().remove(&relative);
            root.deferred.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn root(self: &Arc<Self>, host_path: &str) -> Result<Arc<Root>, IndexError> {
        if !Path::new(host_path).is_absolute() {
            return Err(IndexError::Outside);
        }
        let path = fs::canonicalize(host_path)?;
        if !path.is_dir() {
            return Err(IndexError::Invalid(
                "workspace root is not a directory".into(),
            ));
        }
        let mut roots = self.roots.lock().unwrap();
        if let Some(root) = roots.get(&path) {
            return Ok(root.clone());
        }
        if roots.len() >= MAX_ROOTS {
            return Err(IndexError::Busy);
        }
        let root = Arc::new(Root {
            path: path.clone(),
            pages: Mutex::new(HashMap::new()),
            rules: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashSet::new()),
            deferred: AtomicUsize::new(0),
            failures: AtomicUsize::new(0),
            revision: AtomicU64::new(1),
            cancelled: AtomicBool::new(false),
            watcher: Mutex::new(None),
            watched: Mutex::new(HashSet::new()),
            budget: self.budget.clone(),
        });
        let weak = Arc::downgrade(&root);
        let weak_index = Arc::downgrade(self);
        *root.watcher.lock().unwrap() =
            notify::recommended_watcher(move |event: notify::Result<Event>| {
                if matches!(&event, Ok(e) if matches!(e.kind, EventKind::Access(_))) {
                    return;
                }
                if let Some(root) = weak.upgrade() {
                    let reset = match &event {
                        Err(_) => true,
                        Ok(e) => {
                            e.need_rescan()
                                || e.paths.is_empty()
                                || e.paths
                                    .iter()
                                    .any(|p| p.file_name().is_some_and(|n| n == ".gitignore"))
                        }
                    };
                    let mut directories = HashSet::new();
                    if reset {
                        directories.insert(String::new());
                    } else if let Ok(e) = &event {
                        for file in &e.paths {
                            if let Some(parent) =
                                file.parent().and_then(|p| p.strip_prefix(&root.path).ok())
                            {
                                if let Some(relative) = parent.to_str() {
                                    directories
                                        .insert(relative.replace(std::path::MAIN_SEPARATOR, "/"));
                                }
                            }
                        }
                    }
                    root.invalidate(event);
                    if let Some(index) = weak_index.upgrade() {
                        for directory in directories {
                            index.enqueue(root.clone(), directory);
                        }
                    }
                }
            })
            .ok();
        root.watch(&path);
        roots.insert(path, root.clone());
        self.enqueue(root.clone(), String::new());
        Ok(root)
    }
    pub async fn command(
        self: &Arc<Self>,
        operation: String,
        payload: Vec<u8>,
    ) -> Result<Vec<u8>, IndexError> {
        let input: Input =
            serde_json::from_slice(&payload).map_err(|e| IndexError::Invalid(e.to_string()))?;
        let permit = self
            .queries
            .clone()
            .try_acquire_owned()
            .map_err(|_| IndexError::Busy)?;
        let index = self.clone();
        let span = tracing::Span::current();
        tokio::task::spawn_blocking(move || {
            let _entered = span.enter();
            let _permit = permit;
            let root = index.root(&input.host_path)?;
            let value = match operation.as_str() {
                "register" | "status" => index.status(&root),
                "list" => list(&root, &input)?,
                _ => {
                    return Err(IndexError::Invalid(
                        "unsupported workspace index operation".into(),
                    ));
                }
            };
            serde_json::to_vec(&value).map_err(|e| IndexError::Invalid(e.to_string()))
        })
        .await
        .map_err(|e| IndexError::Invalid(e.to_string()))?
    }
    fn status(&self, root: &Root) -> Value {
        json!({"indexing": !root.pending.lock().unwrap().is_empty(), "revision": root.revision.load(Ordering::SeqCst),
            "cachedDirectories": root.pages.lock().unwrap().len(), "deferredDirectories": root.deferred.load(Ordering::Relaxed),
            "errors": root.failures.load(Ordering::Relaxed), "watching": root.watched.lock().unwrap().len()})
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        for root in self.roots.lock().unwrap().values() {
            root.cancelled.store(true, Ordering::Relaxed);
            root.watcher.lock().unwrap().take();
        }
    }
}

fn safe_directory(root: &Root, relative: &str) -> Result<PathBuf, IndexError> {
    // No trimming or separator rewriting: spaces and backslashes are valid Unix names.
    if relative.contains('\0') || relative.len() > 16384 {
        return Err(IndexError::Outside);
    }
    let mut directory = root.path.clone();
    for part in Path::new(relative).components() {
        match part {
            Component::Normal(name) => {
                directory.push(name);
                if fs::symlink_metadata(&directory)?.file_type().is_symlink() {
                    return Err(IndexError::Outside);
                }
            }
            Component::CurDir => {}
            _ => return Err(IndexError::Outside),
        }
    }
    let canonical = fs::canonicalize(&directory)?;
    if !canonical.starts_with(&root.path) {
        return Err(IndexError::Outside);
    }
    Ok(directory)
}

fn rules_for(root: &Root, directory: &Path) -> Vec<Arc<Gitignore>> {
    // Nested .gitignore files override parent rules, including negations. A fresh
    // chain is cheap after the first lookup and shared between background/query reads.
    let mut ancestors: Vec<_> = directory
        .ancestors()
        .take_while(|p| p.starts_with(&root.path))
        .collect();
    ancestors.reverse();
    ancestors
        .into_iter()
        .map(|dir| {
            let mut rules = root.rules.lock().unwrap();
            if let Some(rule) = rules.get(dir) {
                return rule.clone();
            }
            let mut builder = GitignoreBuilder::new(dir);
            if dir == root.path {
                builder.add(root.path.join(".git/info/exclude"));
            }
            builder.add(dir.join(".gitignore"));
            let matcher = Arc::new(builder.build().unwrap_or_else(|_| Gitignore::empty()));
            if rules.len() >= MAX_ROOT_PAGES {
                rules.clear();
            }
            rules.insert(dir.to_path_buf(), matcher.clone());
            matcher
        })
        .collect()
}
fn ignored(rules: &[Arc<Gitignore>], full: &Path, is_dir: bool) -> bool {
    let mut ignored = false;
    for rule in rules {
        let found = rule.matched_path_or_any_parents(full, is_dir);
        if found.is_ignore() {
            ignored = true;
        } else if found.is_whitelist() {
            ignored = false;
        }
    }
    ignored
}
fn entry(
    root: &Root,
    item: fs::DirEntry,
    rules: &[Arc<Gitignore>],
) -> Result<Option<Entry>, IndexError> {
    let ty = item.file_type()?;
    // Never recurse through symlinks or open special files. Git internals aren't
    // useful source nodes and must not create recursive watcher churn.
    let name = item.file_name().into_string().map_err(|_| {
        IndexError::Invalid("non-UTF8 filename cannot be represented by the UI".into())
    })?;
    if name == ".git" || name == ".DS_Store" || (!ty.is_dir() && !ty.is_file()) {
        return Ok(None);
    }
    let full = item.path();
    let relative = full
        .strip_prefix(&root.path)
        .map_err(|_| IndexError::Outside)?;
    let path = relative
        .components()
        .map(|p| p.as_os_str().to_str().unwrap())
        .collect::<Vec<_>>()
        .join("/");
    Ok(Some(Entry {
        name,
        path,
        kind: if ty.is_dir() { "directory" } else { "file" }.into(),
        has_children: ty.is_dir(),
        ignored: ignored(rules, &full, ty.is_dir()),
    }))
}
fn probe(root: &Arc<Root>, relative: &str) -> Result<Vec<String>, IndexError> {
    if root.cancelled.load(Ordering::Relaxed) {
        return Ok(vec![]);
    }
    let directory = safe_directory(root, relative)?;
    if !relative.is_empty()
        && ignored(
            &rules_for(root, directory.parent().unwrap_or(&root.path)),
            &directory,
            true,
        )
    {
        return Ok(vec![]);
    }
    root.watch(&directory);
    let revision = root.revision.load(Ordering::SeqCst);
    let modified = fs::metadata(&directory)?.modified().ok();
    let rules = rules_for(root, &directory);
    let mut entries = Vec::new();
    for (seen, item) in fs::read_dir(&directory)?.enumerate() {
        if root.cancelled.load(Ordering::Relaxed) {
            return Ok(vec![]);
        }
        // Stop enumeration itself after the 101st entry. Never materialize/sort
        // a million-item directory during startup just to discover it is wide.
        if seen >= EAGER_LIMIT {
            root.deferred.fetch_add(1, Ordering::Relaxed);
            return Ok(vec![]);
        }
        if let Some(item) = entry(root, item?, &rules)? {
            entries.push(item);
        }
    }
    entries.sort_by_key(Entry::key);
    let children = entries
        .iter()
        .filter(|e| e.kind == "directory" && !e.ignored)
        .map(|e| e.path.clone())
        .collect();
    root.store(relative, entries, revision, modified);
    Ok(children)
}
fn list(root: &Arc<Root>, input: &Input) -> Result<Value, IndexError> {
    let directory = safe_directory(root, &input.path)?;
    root.watch(&directory);
    let revision = root.revision.load(Ordering::SeqCst);
    let modified = fs::metadata(&directory)?.modified().ok();
    let modified_ns = modified
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64);
    let cursor: Option<Cursor> = input
        .cursor
        .as_ref()
        .map(|s| {
            serde_json::from_str(s)
                .map_err(|_| IndexError::Invalid("invalid directory cursor".into()))
        })
        .transpose()?;
    if let Some(c) = &cursor {
        if c.root != root.path.to_string_lossy()
            || c.path != input.path
            || c.show_hidden != input.show_hidden
            || c.show_ignored != input.show_ignored
        {
            return Err(IndexError::Invalid(
                "directory cursor scope mismatch".into(),
            ));
        }
        if c.revision != revision || c.modified_ns != modified_ns {
            return Err(IndexError::Stale);
        }
    }
    let limit = input.limit.unwrap_or(PAGE_LIMIT).clamp(1, PAGE_LIMIT);
    let mut selected = BTreeMap::new();
    let mut all = Vec::new();
    let cached = root.cached(&input.path, &directory);
    let mut consider = |item: Entry| {
        if (!input.show_hidden && item.name.starts_with('.'))
            || (!input.show_ignored && item.ignored)
        {
            return;
        }
        let key = item.key();
        if cursor.as_ref().is_some_and(|c| key <= c.after) {
            return;
        }
        selected.insert(key, item);
        if selected.len() > limit + 1 {
            selected.pop_last();
        }
    };
    if let Some(cached) = cached {
        for item in cached.iter().cloned() {
            consider(item);
        }
    } else {
        let rules = rules_for(root, &directory);
        for item in fs::read_dir(&directory)? {
            if root.cancelled.load(Ordering::Relaxed) {
                return Err(IndexError::Busy);
            }
            if let Some(item) = entry(root, item?, &rules)? {
                if all.len() <= EAGER_LIMIT {
                    all.push(item.clone());
                }
                consider(item);
            }
        }
        if all.len() <= EAGER_LIMIT {
            all.sort_by_key(Entry::key);
            root.store(&input.path, all, revision, modified);
        }
    }
    // A watcher event racing enumeration invalidates the cursor instead of
    // publishing an apparently consistent but mixed directory page.
    if root.revision.load(Ordering::SeqCst) != revision
        || fs::metadata(&directory)?.modified().ok() != modified
    {
        return Err(IndexError::Stale);
    }
    let mut truncated = selected.len() > limit;
    let mut entries = Vec::new();
    let mut bytes = 0;
    for (_, item) in selected {
        let cost = serde_json::to_vec(&item).unwrap().len();
        if entries.len() == limit || bytes + cost > MAX_RESPONSE_BYTES {
            truncated = true;
            break;
        }
        bytes += cost;
        entries.push(item);
    }
    let next_cursor = if truncated {
        entries.last().map(|e| {
            serde_json::to_string(&Cursor {
                root: root.path.to_string_lossy().into_owned(),
                path: input.path.clone(),
                revision,
                modified_ns,
                show_hidden: input.show_hidden,
                show_ignored: input.show_ignored,
                after: e.key(),
            })
            .unwrap()
        })
    } else {
        None
    };
    Ok(
        json!({"path": input.path, "entries": entries, "truncated": truncated, "nextCursor": next_cursor,
        "revision": revision, "indexing": !root.pending.lock().unwrap().is_empty()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("synax-index-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn write(&self, name: &str) {
            let file = self.0.join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, b"test\n").unwrap();
        }
        fn input(&self, path: &str) -> Input {
            Input {
                host_path: self.0.to_string_lossy().into_owned(),
                path: path.into(),
                show_hidden: true,
                show_ignored: true,
                cursor: None,
                limit: Some(100),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    async fn settled(root: &Root) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !root.pending.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    async fn stable_list(root: &Arc<Root>, input: &Input) -> Value {
        for _ in 0..30 {
            match list(root, input) {
                Ok(page) => return page,
                Err(IndexError::Stale) => tokio::time::sleep(Duration::from_millis(20)).await,
                Err(error) => panic!("{error}"),
            }
        }
        panic!("directory did not settle");
    }
    #[tokio::test]
    async fn background_walk_skips_ignored_subtrees_and_respects_nested_negation() {
        let f = Fixture::new();
        f.write("src/app.ts");
        f.write("src/drop.log");
        f.write("src/keep.log");
        f.write("generated/deep/file");
        fs::write(f.0.join(".gitignore"), b"generated/\n*.log\n").unwrap();
        fs::write(f.0.join("src/.gitignore"), b"!keep.log\n").unwrap();
        let service = WorkspaceIndex::new();
        let root = service.root(&f.input("").host_path).unwrap();
        settled(&root).await;
        assert!(root.pages.lock().unwrap().contains_key("src"));
        assert!(!root.pages.lock().unwrap().contains_key("generated"));
        let page = stable_list(&root, &f.input("src")).await;
        let entries = page["entries"].as_array().unwrap();
        assert_eq!(
            entries.iter().find(|e| e["name"] == "drop.log").unwrap()["ignored"],
            true
        );
        assert_eq!(
            entries.iter().find(|e| e["name"] == "keep.log").unwrap()["ignored"],
            false
        );
        assert!(
            !stable_list(&root, &f.input("generated")).await["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        service.stop();
    }
    #[tokio::test]
    async fn wide_directories_defer_background_work_and_page_without_loss() {
        let f = Fixture::new();
        for i in 0..205 {
            f.write(&format!("wide/{i:04}.txt"));
        }
        f.write("wide/nested/deeper/file");
        f.write("small/file");
        let service = WorkspaceIndex::new();
        let root = service.root(&f.input("").host_path).unwrap();
        settled(&root).await;
        assert!(root.pages.lock().unwrap().contains_key("small"));
        assert!(!root.pages.lock().unwrap().contains_key("wide"));
        assert!(!root.pages.lock().unwrap().contains_key("wide/nested"));
        assert!(root.deferred.load(Ordering::Relaxed) >= 1);
        let mut input = f.input("wide");
        let mut paths = HashSet::new();
        loop {
            let page = stable_list(&root, &input).await;
            let entries = page["entries"].as_array().unwrap();
            assert!(entries.len() <= 100);
            for e in entries {
                assert!(paths.insert(e["path"].as_str().unwrap().to_owned()));
            }
            input.cursor = page["nextCursor"].as_str().map(str::to_owned);
            if input.cursor.is_none() {
                break;
            }
        }
        assert_eq!(paths.len(), 206);
        assert!(!root.pages.lock().unwrap().contains_key("wide"));
        service.stop();
    }
    #[tokio::test]
    async fn exactly_one_hundred_entries_are_eager_and_roots_are_shared() {
        let f = Fixture::new();
        for i in 0..100 {
            f.write(&format!("{i:03}"));
        }
        let service = WorkspaceIndex::new();
        let first = service.root(&f.input("").host_path).unwrap();
        let second = service.root(&f.input("").host_path).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        settled(&first).await;
        assert_eq!(
            first.pages.lock().unwrap().get("").unwrap().entries.len(),
            100
        );
        service.stop();
    }
    #[tokio::test]
    async fn rejects_traversal_and_stale_or_cross_directory_cursors() {
        let f = Fixture::new();
        f.write("a");
        f.write("b");
        f.write("sub/c");
        let service = WorkspaceIndex::new();
        let root = service.root(&f.input("").host_path).unwrap();
        settled(&root).await;
        assert!(matches!(
            list(&root, &f.input("../")),
            Err(IndexError::Outside)
        ));
        assert!(matches!(
            list(&root, &f.input("/tmp")),
            Err(IndexError::Outside)
        ));
        let mut input = f.input("");
        input.limit = Some(1);
        let page = stable_list(&root, &input).await;
        input.cursor = page["nextCursor"].as_str().map(str::to_owned);
        input.path = "sub".into();
        assert!(matches!(list(&root, &input), Err(IndexError::Invalid(_))));
        input.path.clear();
        root.invalidate(Ok(Event::new(EventKind::Any)));
        assert!(matches!(list(&root, &input), Err(IndexError::Stale)));
        service.stop();
    }
    #[tokio::test]
    async fn watcher_invalidates_cached_names_after_create_rename_and_delete() {
        let f = Fixture::new();
        f.write("initial");
        let service = WorkspaceIndex::new();
        let root = service.root(&f.input("").host_path).unwrap();
        settled(&root).await;
        let revision = root.revision.load(Ordering::SeqCst);
        f.write("created");
        fs::rename(f.0.join("initial"), f.0.join("renamed")).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while root.revision.load(Ordering::SeqCst) == revision {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let page = stable_list(&root, &f.input("")).await;
        assert!(
            page["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["name"] == "renamed")
        );
        fs::remove_file(f.0.join("created")).unwrap();
        let page = stable_list(&root, &f.input("")).await;
        assert!(
            !page["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["name"] == "created")
        );
        service.stop();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_cannot_escape_and_unusual_names_are_preserved() {
        let f = Fixture::new();
        let outside = Fixture::new();
        outside.write("secret");
        std::os::unix::fs::symlink(&outside.0, f.0.join("link")).unwrap();
        f.write(" space /new\nline\\name");
        let service = WorkspaceIndex::new();
        let root = service.root(&f.input("").host_path).unwrap();
        settled(&root).await;
        assert!(matches!(
            list(&root, &f.input("link")),
            Err(IndexError::Outside)
        ));
        let page = stable_list(&root, &f.input(" space ")).await;
        assert_eq!(page["entries"][0]["path"], " space /new\nline\\name");
        service.stop();
    }
}
