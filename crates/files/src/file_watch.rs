use std::any::Any;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use indexmap::{IndexMap, IndexSet};
use notify::{EventKind, RecursiveMode, Watcher};
use ostia_base::path_guard::is_inside_path;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use crate::file_sources::Confine;
use crate::fs_text::{FileStamp, stamp_of};

const DARWIN_RECONCILE: Duration = Duration::from_secs(1);
const TREE_WATCH_MAX_DIRS: usize = 2000;
const TREE_WATCH_SKIPPED_DIRS: [&str; 4] = [".git", ".hg", ".svn", "node_modules"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeChangeKind {
    Created,
    Changed,
    Deleted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeChange {
    pub path: PathBuf,
    pub kind: TreeChangeKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub exists: bool,
    pub owners: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DirEvent {
    Touched(String),
    Failed,
}

pub type DirListener = Arc<dyn Fn(DirEvent) + Send + Sync>;
pub type WatchHandle = Box<dyn Any + Send>;
pub type WatchDir = Arc<dyn Fn(&Path, DirListener) -> io::Result<WatchHandle> + Send + Sync>;
pub type OnChange = Arc<dyn Fn(FileChange) + Send + Sync>;
pub type TreeListener = Arc<dyn Fn(&[TreeChange]) + Send + Sync>;
pub type Unwatch = Box<dyn FnOnce() + Send>;
pub type SaveFuture = BoxFuture<'static, io::Result<FileStamp>>;

fn default_reconcile() -> Duration {
    if cfg!(target_os = "macos") {
        DARWIN_RECONCILE
    } else {
        Duration::ZERO
    }
}

struct NotifyWatch {
    watcher: notify::RecommendedWatcher,
    dir: PathBuf,
}

impl Drop for NotifyWatch {
    fn drop(&mut self) {
        let _ = self.watcher.unwatch(&self.dir);
    }
}

pub fn notify_watch_dir() -> WatchDir {
    Arc::new(|dir: &Path, listener: DirListener| {
        let watched = dir.to_path_buf();
        let own = watched.clone();
        let mut watcher = notify::recommended_watcher(
            move |result: notify::Result<notify::Event>| match result {
                Ok(event) => {
                    if matches!(event.kind, EventKind::Access(_)) {
                        return;
                    }
                    for path in event.paths {
                        if path == own {
                            continue;
                        }
                        if let Some(name) = path.file_name() {
                            listener(DirEvent::Touched(name.to_string_lossy().into_owned()));
                        }
                    }
                }
                Err(_) => listener(DirEvent::Failed),
            },
        )
        .map_err(io::Error::other)?;
        watcher
            .watch(&watched, RecursiveMode::NonRecursive)
            .map_err(io::Error::other)?;
        Ok(Box::new(NotifyWatch {
            watcher,
            dir: watched,
        }) as WatchHandle)
    })
}

fn release(handles: Vec<WatchHandle>, defer: bool) {
    if handles.is_empty() {
        return;
    }
    if defer {
        std::thread::spawn(move || drop(handles));
    } else {
        drop(handles);
    }
}

fn split(path: &str) -> Option<(String, String)> {
    let path = Path::new(path);
    Some((
        path.parent()?.to_str()?.to_owned(),
        path.file_name()?.to_str()?.to_owned(),
    ))
}

fn eager<T: Clone + Send + Sync + 'static>(
    runtime: &Handle,
    future: impl Future<Output = T> + Send + 'static,
) -> Shared<BoxFuture<'static, Option<T>>> {
    let task = runtime.spawn(future);
    async move { task.await.ok() }.boxed().shared()
}

fn eager_option<T: Clone + Send + Sync + 'static>(
    runtime: &Handle,
    future: impl Future<Output = Option<T>> + Send + 'static,
) -> Shared<BoxFuture<'static, Option<T>>> {
    let task = runtime.spawn(future);
    async move { task.await.ok().flatten() }.boxed().shared()
}

#[derive(Clone, Debug)]
struct Fingerprint {
    stamp: FileStamp,
    hash: Option<Vec<u8>>,
}

type LastSeen = Shared<BoxFuture<'static, Option<Fingerprint>>>;

fn digest(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

fn same_content(a: &Option<Fingerprint>, b: &Option<Fingerprint>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.hash.is_some() && a.hash == b.hash,
        _ => false,
    }
}

fn fingerprint_after_blocking(path: &str, before: Option<Fingerprint>) -> Option<Fingerprint> {
    let info = fs::metadata(path).ok()?;
    if !info.is_file() {
        return None;
    }
    let stamp = stamp_of(&info);
    if let Some(known) = &before
        && known.hash.is_some()
        && known.stamp == stamp
    {
        return before;
    }
    let data = fs::read(path).ok()?;
    Some(Fingerprint {
        stamp,
        hash: Some(digest(&data)),
    })
}

async fn fingerprint_after(path: String, before: Option<Fingerprint>) -> Option<Fingerprint> {
    tokio::task::spawn_blocking(move || fingerprint_after_blocking(&path, before))
        .await
        .ok()
        .flatten()
}

fn hash_unchanged(path: &str, at: FileStamp) -> Option<Vec<u8>> {
    let data = fs::read(path).ok()?;
    let after = fs::metadata(path).ok()?;
    (stamp_of(&after) == at).then(|| digest(&data))
}

fn fingerprint_now(runtime: &Handle, path: &str) -> LastSeen {
    let at = fs::metadata(path)
        .ok()
        .filter(fs::Metadata::is_file)
        .map(|info| stamp_of(&info));
    let Some(at) = at else {
        return futures_util::future::ready(None).boxed().shared();
    };
    let path = path.to_owned();
    eager_option(runtime, async move {
        let hash = tokio::task::spawn_blocking(move || hash_unchanged(&path, at))
            .await
            .ok()
            .flatten();
        Some(Fingerprint { stamp: at, hash })
    })
}

pub struct FileWatchesDeps {
    pub confine: Confine,
    pub debounce: Duration,
    pub on_change: OnChange,
    pub reconcile: Option<Duration>,
    pub watch_dir: Option<WatchDir>,
}

struct DirWatch {
    handle: WatchHandle,
    files: IndexMap<String, IndexSet<String>>,
}

struct Timer {
    id: u64,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct FileState {
    dirs: IndexMap<String, DirWatch>,
    timers: HashMap<String, Timer>,
    last_seen: HashMap<String, LastSeen>,
    reconciler: Option<JoinHandle<()>>,
}

struct FileInner {
    confine: Confine,
    debounce: Duration,
    on_change: OnChange,
    reconcile: Duration,
    watch_dir: WatchDir,
    runtime: Handle,
    state: Mutex<FileState>,
    next_timer: AtomicU64,
}

pub struct FileWatches {
    inner: Arc<FileInner>,
}

impl FileWatches {
    pub fn new(deps: FileWatchesDeps) -> Self {
        Self {
            inner: Arc::new(FileInner {
                confine: deps.confine,
                debounce: deps.debounce,
                on_change: deps.on_change,
                reconcile: deps.reconcile.unwrap_or_else(default_reconcile),
                watch_dir: deps.watch_dir.unwrap_or_else(notify_watch_dir),
                runtime: Handle::current(),
                state: Mutex::new(FileState::default()),
                next_timer: AtomicU64::new(0),
            }),
        }
    }

    pub fn watch(&self, owner: &str, path: &str) -> bool {
        let inner = &self.inner;
        let Some(safe) = (inner.confine)(path) else {
            return false;
        };
        let Some((dir, name)) = split(&safe) else {
            return false;
        };
        let mut state = inner.state.lock();
        if !state.dirs.contains_key(&dir) {
            let weak = Arc::downgrade(inner);
            let watched = dir.clone();
            let listener: DirListener = Arc::new(move |event| {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                match event {
                    DirEvent::Touched(name) => inner.touched(&watched, &name),
                    DirEvent::Failed => inner.drop_dir(&watched, true),
                }
            });
            let Ok(handle) = (inner.watch_dir)(Path::new(&dir), listener) else {
                return false;
            };
            state.dirs.insert(
                dir.clone(),
                DirWatch {
                    handle,
                    files: IndexMap::new(),
                },
            );
            inner.start_reconciling(&mut state);
        }
        if let Some(entry) = state.dirs.get_mut(&dir) {
            entry
                .files
                .entry(name)
                .or_default()
                .insert(owner.to_owned());
        }
        state
            .last_seen
            .entry(safe.clone())
            .or_insert_with(|| fingerprint_now(&inner.runtime, &safe));
        true
    }

    pub async fn write(
        &self,
        writer: &str,
        path: &str,
        data: &[u8],
        save: impl FnOnce() -> SaveFuture + Send + 'static,
    ) -> io::Result<FileStamp> {
        let inner = &self.inner;
        let safe = (inner.confine)(path);
        let previous = safe
            .as_ref()
            .and_then(|safe| inner.state.lock().last_seen.get(safe).cloned());
        let (Some(safe), Some(previous)) = (safe, previous) else {
            return save().await;
        };
        let hash = digest(data);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let waiting = previous.clone();
        let saving = eager_option(&inner.runtime, async move {
            waiting.clone().await;
            match save().await {
                Ok(stamp) => {
                    let _ = sender.send(Ok(stamp));
                    Some(Fingerprint {
                        stamp,
                        hash: Some(hash),
                    })
                }
                Err(error) => {
                    let _ = sender.send(Err(error));
                    waiting.await
                }
            }
        });
        inner.state.lock().last_seen.insert(safe.clone(), saving);
        let stamp = receiver
            .await
            .map_err(|_| io::Error::other("save task ended"))??;
        let written = Some(Fingerprint {
            stamp,
            hash: Some(digest(data)),
        });
        if same_content(&previous.await, &written) {
            return Ok(stamp);
        }
        let others: Vec<String> = inner
            .owners_of(&safe)
            .into_iter()
            .filter(|owner| owner != writer)
            .collect();
        if !others.is_empty() {
            (inner.on_change)(FileChange {
                path: safe,
                exists: true,
                owners: others,
            });
        }
        Ok(stamp)
    }

    pub fn unwatch(&self, owner: &str, path: &str) {
        let inner = &self.inner;
        let Some(safe) = (inner.confine)(path) else {
            return;
        };
        let Some((dir, name)) = split(&safe) else {
            return;
        };
        let emptied = {
            let mut state = inner.state.lock();
            let Some(entry) = state.dirs.get_mut(&dir) else {
                return;
            };
            let Some(owners) = entry.files.get_mut(&name) else {
                return;
            };
            owners.shift_remove(owner);
            let unowned = owners.is_empty();
            if unowned {
                entry.files.shift_remove(&name);
            }
            let dir_empty = entry.files.is_empty();
            if unowned {
                state.last_seen.remove(&safe);
            }
            dir_empty
        };
        if emptied {
            inner.drop_dir(&dir, false);
        }
    }

    pub fn unwatch_owner(&self, owner: &str) {
        let targets: Vec<String> = {
            let state = self.inner.state.lock();
            state
                .dirs
                .iter()
                .flat_map(|(dir, entry)| {
                    entry.files.keys().map(move |name| format!("{dir}/{name}"))
                })
                .collect()
        };
        for target in targets {
            self.unwatch(owner, &target);
        }
    }

    pub fn watched_dirs(&self) -> Vec<String> {
        let mut dirs: Vec<String> = self.inner.state.lock().dirs.keys().cloned().collect();
        dirs.sort();
        dirs
    }

    pub fn close_all(&self) {
        let dirs: Vec<String> = self.inner.state.lock().dirs.keys().cloned().collect();
        for dir in dirs {
            self.inner.drop_dir(&dir, false);
        }
    }
}

impl FileInner {
    fn owners_of(&self, path: &str) -> Vec<String> {
        let Some((dir, name)) = split(path) else {
            return Vec::new();
        };
        self.state
            .lock()
            .dirs
            .get(&dir)
            .and_then(|entry| entry.files.get(&name))
            .map(|owners| owners.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn start_reconciling(self: &Arc<Self>, state: &mut FileState) {
        if state.reconciler.is_some() || self.reconcile.is_zero() {
            return;
        }
        let weak = Arc::downgrade(self);
        let every = self.reconcile;
        state.reconciler = Some(self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                inner.reconcile_files();
            }
        }));
    }

    fn reconcile_files(self: &Arc<Self>) {
        let missing: Vec<(String, String)> = {
            let state = self.state.lock();
            state
                .dirs
                .iter()
                .flat_map(|(dir, entry)| {
                    let gone = !Path::new(dir).exists();
                    entry
                        .files
                        .keys()
                        .filter(move |name| gone || !Path::new(&format!("{dir}/{name}")).exists())
                        .map(move |name| (dir.clone(), name.clone()))
                })
                .collect()
        };
        for (dir, name) in missing {
            self.touched(&dir, &name);
        }
    }

    fn drop_dir(&self, dir: &str, defer: bool) {
        let removed = {
            let mut state = self.state.lock();
            let Some(entry) = state.dirs.shift_remove(dir) else {
                return;
            };
            if state.dirs.is_empty()
                && let Some(reconciler) = state.reconciler.take()
            {
                reconciler.abort();
            }
            for name in entry.files.keys() {
                let path = format!("{dir}/{name}");
                if let Some(timer) = state.timers.remove(&path) {
                    timer.task.abort();
                }
                state.last_seen.remove(&path);
            }
            entry.handle
        };
        release(vec![removed], defer);
    }

    fn touched(self: &Arc<Self>, dir: &str, name: &str) {
        let mut state = self.state.lock();
        let owned = state
            .dirs
            .get(dir)
            .and_then(|entry| entry.files.get(name))
            .is_some_and(|owners| !owners.is_empty());
        if !owned {
            return;
        }
        let path = format!("{dir}/{name}");
        if let Some(previous) = state.timers.remove(&path) {
            previous.task.abort();
        }
        let id = self.next_timer.fetch_add(1, Ordering::SeqCst);
        let weak: Weak<Self> = Arc::downgrade(self);
        let debounce = self.debounce;
        let target = path.clone();
        let task = self.runtime.spawn(async move {
            tokio::time::sleep(debounce).await;
            let Some(inner) = weak.upgrade() else {
                return;
            };
            {
                let mut state = inner.state.lock();
                match state.timers.get(&target) {
                    Some(timer) if timer.id == id => {
                        state.timers.remove(&target);
                    }
                    _ => return,
                }
            }
            inner.check(target).await;
        });
        state.timers.insert(path, Timer { id, task });
    }

    async fn check(&self, path: String) {
        let step = {
            let mut state = self.state.lock();
            let Some(previous) = state.last_seen.get(&path).cloned() else {
                return;
            };
            let target = path.clone();
            let step = eager(&self.runtime, async move {
                let before = previous.await;
                let after = fingerprint_after(target, before.clone()).await;
                (before, after)
            });
            let last: LastSeen = step
                .clone()
                .map(|done| done.and_then(|(_, after)| after))
                .boxed()
                .shared();
            state.last_seen.insert(path.clone(), last);
            step
        };
        let Some((before, after)) = step.await else {
            return;
        };
        let owners = self.owners_of(&path);
        if owners.is_empty() || same_content(&before, &after) {
            return;
        }
        (self.on_change)(FileChange {
            path,
            exists: after.is_some(),
            owners,
        });
    }
}

pub struct TreeWatchesDeps {
    pub confine: Confine,
    pub debounce: Duration,
    pub max_dirs: Option<usize>,
    pub reconcile: Option<Duration>,
    pub watch_dir: Option<WatchDir>,
}

struct TreeDir {
    handle: WatchHandle,
    files: IndexSet<String>,
}

struct TreeWatch {
    id: u64,
    dirs: IndexMap<String, TreeDir>,
    listeners: Vec<(u64, TreeListener)>,
    pending: IndexSet<String>,
    timer: Option<JoinHandle<()>>,
    reconciler: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct TreeState {
    trees: HashMap<String, TreeWatch>,
}

struct TreeInner {
    confine: Confine,
    debounce: Duration,
    max_dirs: usize,
    reconcile: Duration,
    watch_dir: WatchDir,
    runtime: Handle,
    state: Mutex<TreeState>,
    next_id: AtomicU64,
}

pub struct TreeWatches {
    inner: Arc<TreeInner>,
}

fn skipped(name: &str) -> bool {
    TREE_WATCH_SKIPPED_DIRS.contains(&name)
}

fn entries_of(dir: &str) -> Option<Vec<(String, bool)>> {
    let read = fs::read_dir(dir).ok()?;
    Some(
        read.filter_map(|item| {
            let item = item.ok()?;
            let is_dir = item.file_type().ok()?.is_dir();
            Some((item.file_name().to_string_lossy().into_owned(), is_dir))
        })
        .collect(),
    )
}

fn is_directory(path: &str) -> bool {
    fs::symlink_metadata(path).is_ok_and(|info| info.is_dir())
}

fn change(path: String, kind: TreeChangeKind) -> TreeChange {
    TreeChange {
        path: PathBuf::from(path),
        kind,
    }
}

impl TreeWatches {
    pub fn new(deps: TreeWatchesDeps) -> Self {
        Self {
            inner: Arc::new(TreeInner {
                confine: deps.confine,
                debounce: deps.debounce,
                max_dirs: deps.max_dirs.unwrap_or(TREE_WATCH_MAX_DIRS),
                reconcile: deps.reconcile.unwrap_or_else(default_reconcile),
                watch_dir: deps.watch_dir.unwrap_or_else(notify_watch_dir),
                runtime: Handle::current(),
                state: Mutex::new(TreeState::default()),
                next_id: AtomicU64::new(0),
            }),
        }
    }

    pub fn watch(&self, root: &str, listener: TreeListener) -> Option<Unwatch> {
        let inner = &self.inner;
        let safe = (inner.confine)(root)?;
        let listener_id = inner.next_id.fetch_add(1, Ordering::SeqCst);
        let tree_id = {
            let mut state = inner.state.lock();
            if !state.trees.contains_key(&safe) {
                if !is_directory(&safe) {
                    return None;
                }
                let id = inner.next_id.fetch_add(1, Ordering::SeqCst);
                let mut tree = TreeWatch {
                    id,
                    dirs: IndexMap::new(),
                    listeners: Vec::new(),
                    pending: IndexSet::new(),
                    timer: None,
                    reconciler: None,
                };
                inner.scan(&safe, &mut tree, &safe, None);
                inner.start_reconciling(&safe, &mut tree);
                state.trees.insert(safe.clone(), tree);
                drop(state);
                inner.subscribe(&safe, listener_id, listener)
            } else {
                drop(state);
                inner.subscribe(&safe, listener_id, listener)
            }
        }?;
        let weak = Arc::downgrade(inner);
        Some(Box::new(move || {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let closed = {
                let mut state = inner.state.lock();
                let Some(tree) = state.trees.get_mut(&safe) else {
                    return;
                };
                if tree.id != tree_id {
                    return;
                }
                tree.listeners.retain(|(id, _)| *id != listener_id);
                if tree.listeners.is_empty() {
                    inner.close_locked(&mut state, &safe)
                } else {
                    Vec::new()
                }
            };
            release(closed, false);
        }))
    }

    pub fn watched_dirs(&self, root: &str) -> Vec<String> {
        let mut dirs: Vec<String> = self
            .inner
            .state
            .lock()
            .trees
            .get(root)
            .map(|tree| tree.dirs.keys().cloned().collect())
            .unwrap_or_default();
        dirs.sort();
        dirs
    }

    pub fn close_all(&self) {
        let released = {
            let mut state = self.inner.state.lock();
            let roots: Vec<String> = state.trees.keys().cloned().collect();
            let mut released = Vec::new();
            for root in roots {
                released.extend(self.inner.close_locked(&mut state, &root));
            }
            released
        };
        release(released, false);
    }
}

impl TreeInner {
    fn subscribe(&self, safe: &str, listener_id: u64, listener: TreeListener) -> Option<u64> {
        let mut state = self.state.lock();
        let tree = state.trees.get_mut(safe)?;
        tree.listeners.push((listener_id, listener));
        Some(tree.id)
    }

    fn close_locked(&self, state: &mut TreeState, root: &str) -> Vec<WatchHandle> {
        let Some(tree) = state.trees.remove(root) else {
            return Vec::new();
        };
        if let Some(timer) = tree.timer {
            timer.abort();
        }
        if let Some(reconciler) = tree.reconciler {
            reconciler.abort();
        }
        tree.dirs.into_values().map(|dir| dir.handle).collect()
    }

    fn start_reconciling(self: &Arc<Self>, root: &str, tree: &mut TreeWatch) {
        if self.reconcile.is_zero() {
            return;
        }
        let weak = Arc::downgrade(self);
        let every = self.reconcile;
        let root = root.to_owned();
        let id = tree.id;
        tree.reconciler = Some(self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                if !inner.reconcile_tree(&root, id) {
                    return;
                }
            }
        }));
    }

    fn scan(
        self: &Arc<Self>,
        root: &str,
        tree: &mut TreeWatch,
        start: &str,
        mut created: Option<&mut Vec<TreeChange>>,
    ) {
        let mut queue = VecDeque::from([start.to_owned()]);
        while let Some(dir) = queue.pop_front() {
            if tree.dirs.contains_key(&dir) || tree.dirs.len() >= self.max_dirs {
                continue;
            }
            let weak = Arc::downgrade(self);
            let watched = dir.clone();
            let owner = root.to_owned();
            let id = tree.id;
            let listener: DirListener = Arc::new(move |event| {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                match event {
                    DirEvent::Touched(name) => {
                        inner.touched(&owner, id, format!("{watched}/{name}"));
                    }
                    DirEvent::Failed => inner.dir_failed(&owner, id, &watched),
                }
            });
            let Ok(handle) = (self.watch_dir)(Path::new(&dir), listener) else {
                continue;
            };
            tree.dirs.insert(
                dir.clone(),
                TreeDir {
                    handle,
                    files: IndexSet::new(),
                },
            );
            for (name, is_dir) in entries_of(&dir).unwrap_or_default() {
                if is_dir {
                    if !skipped(&name) {
                        queue.push_back(format!("{dir}/{name}"));
                    }
                    continue;
                }
                if let Some(found) = created.as_deref_mut() {
                    found.push(change(format!("{dir}/{name}"), TreeChangeKind::Created));
                }
                if let Some(entry) = tree.dirs.get_mut(&dir) {
                    entry.files.insert(name);
                }
            }
        }
    }

    fn drop_tree_dir(
        tree: &mut TreeWatch,
        dir: &str,
        released: &mut Vec<WatchHandle>,
    ) -> Vec<TreeChange> {
        let inside: Vec<String> = tree
            .dirs
            .keys()
            .filter(|path| is_inside_path(Path::new(dir), Path::new(path.as_str())))
            .cloned()
            .collect();
        let mut deleted = Vec::new();
        for path in inside {
            let Some(entry) = tree.dirs.shift_remove(&path) else {
                continue;
            };
            released.push(entry.handle);
            for name in entry.files {
                deleted.push(change(format!("{path}/{name}"), TreeChangeKind::Deleted));
            }
        }
        deleted
    }

    fn dir_failed(&self, root: &str, id: u64, dir: &str) {
        let mut released = Vec::new();
        {
            let mut state = self.state.lock();
            let Some(tree) = state.trees.get_mut(root) else {
                return;
            };
            if tree.id != id {
                return;
            }
            Self::drop_tree_dir(tree, dir, &mut released);
        }
        release(released, true);
    }

    fn touched(self: &Arc<Self>, root: &str, id: u64, path: String) {
        let mut state = self.state.lock();
        let Some(tree) = state.trees.get_mut(root) else {
            return;
        };
        if tree.id != id {
            return;
        }
        tree.pending.insert(path);
        if tree.timer.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        let debounce = self.debounce;
        let owner = root.to_owned();
        tree.timer = Some(self.runtime.spawn(async move {
            tokio::time::sleep(debounce).await;
            if let Some(inner) = weak.upgrade() {
                inner.flush(&owner, id);
            }
        }));
    }

    fn deliver(listeners: &[(u64, TreeListener)], changes: &[TreeChange]) {
        if changes.is_empty() {
            return;
        }
        for (_, listener) in listeners {
            listener(changes);
        }
    }

    fn flush(self: &Arc<Self>, root: &str, id: u64) {
        let mut changes = Vec::new();
        let mut released = Vec::new();
        let listeners = {
            let mut state = self.state.lock();
            let Some(tree) = state.trees.get_mut(root) else {
                return;
            };
            if tree.id != id {
                return;
            }
            tree.timer = None;
            let pending = std::mem::take(&mut tree.pending);
            for path in pending {
                let Some((parent, name)) = split(&path) else {
                    continue;
                };
                if !tree.dirs.contains_key(&parent) {
                    continue;
                }
                match fs::symlink_metadata(&path) {
                    Err(_) => {
                        let removed = tree
                            .dirs
                            .get_mut(&parent)
                            .is_some_and(|entry| entry.files.shift_remove(&name));
                        if removed {
                            changes.push(change(path.clone(), TreeChangeKind::Deleted));
                        }
                        changes.extend(Self::drop_tree_dir(tree, &path, &mut released));
                    }
                    Ok(info) if info.is_dir() => {
                        if !skipped(&name) {
                            self.scan(root, tree, &path, Some(&mut changes));
                        }
                    }
                    Ok(_) => {
                        let Some(entry) = tree.dirs.get_mut(&parent) else {
                            continue;
                        };
                        let kind = if entry.files.contains(&name) {
                            TreeChangeKind::Changed
                        } else {
                            TreeChangeKind::Created
                        };
                        changes.push(change(path.clone(), kind));
                        entry.files.insert(name);
                    }
                }
            }
            tree.listeners.clone()
        };
        release(released, false);
        Self::deliver(&listeners, &changes);
    }

    fn reconcile_tree(self: &Arc<Self>, root: &str, id: u64) -> bool {
        let mut changes = Vec::new();
        let mut released = Vec::new();
        let listeners = {
            let mut state = self.state.lock();
            let Some(tree) = state.trees.get_mut(root) else {
                return false;
            };
            if tree.id != id {
                return false;
            }
            let dirs: Vec<String> = tree.dirs.keys().cloned().collect();
            for dir in dirs {
                if !tree.dirs.contains_key(&dir) {
                    continue;
                }
                if !is_directory(&dir) {
                    changes.extend(Self::drop_tree_dir(tree, &dir, &mut released));
                    continue;
                }
                let Some(entries) = entries_of(&dir) else {
                    continue;
                };
                let mut names = HashSet::new();
                for (name, is_dir) in entries {
                    let path = format!("{dir}/{name}");
                    if is_dir {
                        if !skipped(&name) {
                            self.scan(root, tree, &path, Some(&mut changes));
                        }
                        continue;
                    }
                    if let Some(known) = tree.dirs.get_mut(&dir)
                        && known.files.insert(name.clone())
                    {
                        changes.push(change(path, TreeChangeKind::Created));
                    }
                    names.insert(name);
                }
                if let Some(known) = tree.dirs.get_mut(&dir) {
                    let vanished: Vec<String> = known
                        .files
                        .iter()
                        .filter(|name| !names.contains(*name))
                        .cloned()
                        .collect();
                    for name in vanished {
                        known.files.shift_remove(&name);
                        changes.push(change(format!("{dir}/{name}"), TreeChangeKind::Deleted));
                    }
                }
            }
            tree.listeners.clone()
        };
        release(released, false);
        Self::deliver(&listeners, &changes);
        true
    }
}
