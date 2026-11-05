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

type DirListeners = HashMap<PathBuf, Vec<(u64, DirListener)>>;

struct SharedNotify {
    watcher: Mutex<notify::RecommendedWatcher>,
    listeners: Arc<Mutex<DirListeners>>,
    next_id: AtomicU64,
}

struct NotifyWatch {
    shared: Arc<SharedNotify>,
    dir: PathBuf,
    id: u64,
}

fn route(listeners: &Mutex<DirListeners>, result: notify::Result<notify::Event>) {
    match result {
        Ok(event) => {
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            for path in event.paths {
                let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
                    continue;
                };
                let targets: Vec<DirListener> = listeners
                    .lock()
                    .get(parent)
                    .map(|entries| entries.iter().map(|(_, l)| Arc::clone(l)).collect())
                    .unwrap_or_default();
                for listener in targets {
                    listener(DirEvent::Touched(name.to_string_lossy().into_owned()));
                }
            }
        }
        Err(_) => {
            let targets: Vec<DirListener> = listeners
                .lock()
                .values()
                .flat_map(|entries| entries.iter().map(|(_, l)| Arc::clone(l)))
                .collect();
            for listener in targets {
                listener(DirEvent::Failed);
            }
        }
    }
}

impl SharedNotify {
    fn start() -> io::Result<Arc<Self>> {
        let listeners = Arc::new(Mutex::new(DirListeners::new()));
        let routed = Arc::clone(&listeners);
        let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            route(&routed, result);
        })
        .map_err(io::Error::other)?;
        Ok(Arc::new(Self {
            watcher: Mutex::new(watcher),
            listeners,
            next_id: AtomicU64::new(0),
        }))
    }

    fn add(self: &Arc<Self>, dir: &Path, listener: DirListener) -> io::Result<WatchHandle> {
        let mut watcher = self.watcher.lock();
        let known = self.listeners.lock().contains_key(dir);
        if !known {
            watcher
                .watch(dir, RecursiveMode::NonRecursive)
                .map_err(io::Error::other)?;
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.listeners
            .lock()
            .entry(dir.to_path_buf())
            .or_default()
            .push((id, listener));
        Ok(Box::new(NotifyWatch {
            shared: Arc::clone(self),
            dir: dir.to_path_buf(),
            id,
        }))
    }
}

impl Drop for NotifyWatch {
    fn drop(&mut self) {
        let mut watcher = self.shared.watcher.lock();
        let emptied = {
            let mut listeners = self.shared.listeners.lock();
            let Some(entries) = listeners.get_mut(&self.dir) else {
                return;
            };
            entries.retain(|(id, _)| *id != self.id);
            let emptied = entries.is_empty();
            if emptied {
                listeners.remove(&self.dir);
            }
            emptied
        };
        if emptied {
            let _ = watcher.unwatch(&self.dir);
        }
    }
}

pub fn notify_watch_dir() -> WatchDir {
    let shared: Mutex<Option<Arc<SharedNotify>>> = Mutex::new(None);
    Arc::new(move |dir: &Path, listener: DirListener| {
        let started = {
            let mut slot = shared.lock();
            match slot.as_ref() {
                Some(started) => Arc::clone(started),
                None => {
                    let started = SharedNotify::start()?;
                    *slot = Some(Arc::clone(&started));
                    started
                }
            }
        };
        started.add(dir, listener)
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
        if inner.register(&dir, &name, owner, &safe) {
            return true;
        }
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
        let spare = inner.register_with(&dir, &name, owner, &safe, handle);
        drop(spare);
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
        let Some(safe) = (inner.confine)(path) else {
            return save().await;
        };
        let hash = digest(data);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let mut save = Some(save);
        let chained = {
            let mut state = inner.state.lock();
            let known = state.last_seen.get(&safe).cloned();
            known.inspect(|previous| {
                let Some(save) = save.take() else {
                    return;
                };
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
                state.last_seen.insert(safe.clone(), saving);
            })
        };
        let Some(previous) = chained else {
            return match save.take() {
                Some(save) => save().await,
                None => Err(io::Error::other("save task ended")),
            };
        };
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
    fn register(self: &Arc<Self>, dir: &str, name: &str, owner: &str, safe: &str) -> bool {
        let mut state = self.state.lock();
        if !state.dirs.contains_key(dir) {
            return false;
        }
        self.add_owner(&mut state, dir, name, owner, safe);
        true
    }

    fn register_with(
        self: &Arc<Self>,
        dir: &str,
        name: &str,
        owner: &str,
        safe: &str,
        handle: WatchHandle,
    ) -> Option<WatchHandle> {
        let mut state = self.state.lock();
        let spare = if state.dirs.contains_key(dir) {
            Some(handle)
        } else {
            state.dirs.insert(
                dir.to_owned(),
                DirWatch {
                    handle,
                    files: IndexMap::new(),
                },
            );
            self.start_reconciling(&mut state);
            None
        };
        self.add_owner(&mut state, dir, name, owner, safe);
        spare
    }

    fn add_owner(&self, state: &mut FileState, dir: &str, name: &str, owner: &str, safe: &str) {
        if let Some(entry) = state.dirs.get_mut(dir) {
            entry
                .files
                .entry(name.to_owned())
                .or_default()
                .insert(owner.to_owned());
        }
        state
            .last_seen
            .entry(safe.to_owned())
            .or_insert_with(|| fingerprint_now(&self.runtime, safe));
    }

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

    async fn check(self: Arc<Self>, path: String) {
        let step = {
            let mut state = self.state.lock();
            let Some(previous) = state.last_seen.get(&path).cloned() else {
                return;
            };
            let target = path.clone();
            let inner = Arc::clone(&self);
            let step = eager_option(&self.runtime, async move {
                let before = previous.await;
                let after = fingerprint_after(target.clone(), before.clone()).await;
                let owners = inner.owners_of(&target);
                if !owners.is_empty() && !same_content(&before, &after) {
                    (inner.on_change)(FileChange {
                        path: target,
                        exists: after.is_some(),
                        owners,
                    });
                }
                after
            });
            state.last_seen.insert(path, step.clone());
            step
        };
        step.await;
    }
}

pub struct TreeWatchesDeps {
    pub confine: Confine,
    pub debounce: Duration,
    pub max_dirs: Option<usize>,
    pub reconcile: Option<Duration>,
    pub watch_dir: Option<WatchDir>,
}

struct ScannedDir {
    dir: String,
    handle: WatchHandle,
    files: Vec<String>,
}

enum Seen {
    Gone,
    File,
    Dir(Vec<ScannedDir>),
}

enum Scanned {
    File(String),
    Subtree(Vec<ScannedDir>),
}

enum Listing {
    NotDir,
    Unreadable,
    Entries(Vec<Scanned>),
}

fn discard(plans: Vec<ScannedDir>, released: &mut Vec<WatchHandle>) {
    released.extend(plans.into_iter().map(|plan| plan.handle));
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
    delivery: Mutex<()>,
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
                delivery: Mutex::new(()),
                next_id: AtomicU64::new(0),
            }),
        }
    }

    pub fn watch(&self, root: &str, listener: TreeListener) -> Option<Unwatch> {
        let inner = &self.inner;
        let safe = (inner.confine)(root)?;
        let listener_id = inner.next_id.fetch_add(1, Ordering::SeqCst);
        let tree_id = match inner.subscribe(&safe, listener_id, &listener) {
            Some(tree_id) => tree_id,
            None => {
                if !is_directory(&safe) {
                    return None;
                }
                inner.open_tree(&safe, listener_id, listener)
            }
        };
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
    fn subscribe(&self, safe: &str, listener_id: u64, listener: &TreeListener) -> Option<u64> {
        let mut state = self.state.lock();
        let tree = state.trees.get_mut(safe)?;
        tree.listeners.push((listener_id, Arc::clone(listener)));
        Some(tree.id)
    }

    fn open_tree(self: &Arc<Self>, safe: &str, listener_id: u64, listener: TreeListener) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut known = HashSet::new();
        let plans = self.scan(safe, id, safe, &mut known);
        let mut released = Vec::new();
        let tree_id = {
            let mut state = self.state.lock();
            if let Some(tree) = state.trees.get_mut(safe) {
                tree.listeners.push((listener_id, listener));
                discard(plans, &mut released);
                tree.id
            } else {
                let mut tree = TreeWatch {
                    id,
                    dirs: IndexMap::new(),
                    listeners: vec![(listener_id, listener)],
                    pending: IndexSet::new(),
                    timer: None,
                    reconciler: None,
                };
                self.adopt(&mut tree, plans, None, &mut released);
                self.start_reconciling(safe, &mut tree);
                state.trees.insert(safe.to_owned(), tree);
                id
            }
        };
        release(released, false);
        tree_id
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
                let owner = root.clone();
                let alive = tokio::task::spawn_blocking(move || inner.reconcile_tree(&owner, id))
                    .await
                    .unwrap_or(false);
                if !alive {
                    return;
                }
            }
        }));
    }

    fn scan(
        self: &Arc<Self>,
        root: &str,
        id: u64,
        start: &str,
        known: &mut HashSet<String>,
    ) -> Vec<ScannedDir> {
        let mut found = Vec::new();
        let mut queue = VecDeque::from([start.to_owned()]);
        while let Some(dir) = queue.pop_front() {
            if known.contains(&dir) || known.len() >= self.max_dirs {
                continue;
            }
            let weak = Arc::downgrade(self);
            let watched = dir.clone();
            let owner = root.to_owned();
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
            known.insert(dir.clone());
            let mut files = Vec::new();
            for (name, is_dir) in entries_of(&dir).unwrap_or_default() {
                if !is_dir {
                    files.push(name);
                } else if !skipped(&name) {
                    queue.push_back(format!("{dir}/{name}"));
                }
            }
            found.push(ScannedDir { dir, handle, files });
        }
        found
    }

    fn adopt(
        &self,
        tree: &mut TreeWatch,
        plans: Vec<ScannedDir>,
        mut created: Option<&mut Vec<TreeChange>>,
        released: &mut Vec<WatchHandle>,
    ) {
        for plan in plans {
            if tree.dirs.contains_key(&plan.dir) || tree.dirs.len() >= self.max_dirs {
                released.push(plan.handle);
                continue;
            }
            if let Some(found) = created.as_deref_mut() {
                for name in &plan.files {
                    found.push(change(
                        format!("{}/{name}", plan.dir),
                        TreeChangeKind::Created,
                    ));
                }
            }
            tree.dirs.insert(
                plan.dir,
                TreeDir {
                    handle: plan.handle,
                    files: plan.files.into_iter().collect(),
                },
            );
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
                let _ = tokio::task::spawn_blocking(move || inner.flush(&owner, id)).await;
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
        let _delivery = self.delivery.lock();
        let (pending, mut known) = {
            let mut state = self.state.lock();
            let Some(tree) = state.trees.get_mut(root) else {
                return;
            };
            if tree.id != id {
                return;
            }
            tree.timer = None;
            (
                std::mem::take(&mut tree.pending),
                tree.dirs.keys().cloned().collect::<HashSet<String>>(),
            )
        };
        let mut seen = Vec::new();
        for path in pending {
            let Some((parent, name)) = split(&path) else {
                continue;
            };
            if !known.contains(&parent) {
                continue;
            }
            let found = match fs::symlink_metadata(&path) {
                Err(_) => Seen::Gone,
                Ok(info) if info.is_dir() => Seen::Dir(if skipped(&name) {
                    Vec::new()
                } else {
                    self.scan(root, id, &path, &mut known)
                }),
                Ok(_) => Seen::File,
            };
            seen.push((path, parent, name, found));
        }
        let mut changes = Vec::new();
        let mut released = Vec::new();
        let listeners = {
            let mut state = self.state.lock();
            match state.trees.get_mut(root).filter(|tree| tree.id == id) {
                None => {
                    for (.., found) in seen {
                        if let Seen::Dir(plans) = found {
                            discard(plans, &mut released);
                        }
                    }
                    Vec::new()
                }
                Some(tree) => {
                    for (path, parent, name, found) in seen {
                        if !tree.dirs.contains_key(&parent) {
                            if let Seen::Dir(plans) = found {
                                discard(plans, &mut released);
                            }
                            continue;
                        }
                        match found {
                            Seen::Gone => {
                                let removed = tree
                                    .dirs
                                    .get_mut(&parent)
                                    .is_some_and(|entry| entry.files.shift_remove(&name));
                                if removed {
                                    changes.push(change(path.clone(), TreeChangeKind::Deleted));
                                }
                                changes.extend(Self::drop_tree_dir(tree, &path, &mut released));
                            }
                            Seen::Dir(plans) => {
                                self.adopt(tree, plans, Some(&mut changes), &mut released);
                            }
                            Seen::File => {
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
                }
            }
        };
        release(released, false);
        Self::deliver(&listeners, &changes);
    }

    fn reconcile_tree(self: &Arc<Self>, root: &str, id: u64) -> bool {
        let _delivery = self.delivery.lock();
        let dirs: Vec<String> = {
            let state = self.state.lock();
            let Some(tree) = state.trees.get(root) else {
                return false;
            };
            if tree.id != id {
                return false;
            }
            tree.dirs.keys().cloned().collect()
        };
        let mut known: HashSet<String> = dirs.iter().cloned().collect();
        let mut listed = Vec::new();
        for dir in dirs {
            let listing = if !is_directory(&dir) {
                Listing::NotDir
            } else if let Some(entries) = entries_of(&dir) {
                Listing::Entries(
                    entries
                        .into_iter()
                        .filter_map(|(name, is_dir)| {
                            if !is_dir {
                                return Some(Scanned::File(name));
                            }
                            if skipped(&name) {
                                return None;
                            }
                            let path = format!("{dir}/{name}");
                            Some(Scanned::Subtree(self.scan(root, id, &path, &mut known)))
                        })
                        .collect(),
                )
            } else {
                Listing::Unreadable
            };
            listed.push((dir, listing));
        }
        let mut changes = Vec::new();
        let mut released = Vec::new();
        let listeners = {
            let mut state = self.state.lock();
            let Some(tree) = state.trees.get_mut(root).filter(|tree| tree.id == id) else {
                for (_, listing) in listed {
                    if let Listing::Entries(entries) = listing {
                        for entry in entries {
                            if let Scanned::Subtree(plans) = entry {
                                discard(plans, &mut released);
                            }
                        }
                    }
                }
                drop(state);
                release(released, false);
                return false;
            };
            for (dir, listing) in listed {
                let entries = match listing {
                    Listing::Entries(entries) => entries,
                    Listing::NotDir if tree.dirs.contains_key(&dir) => {
                        changes.extend(Self::drop_tree_dir(tree, &dir, &mut released));
                        continue;
                    }
                    Listing::NotDir | Listing::Unreadable => continue,
                };
                if !tree.dirs.contains_key(&dir) {
                    for entry in entries {
                        if let Scanned::Subtree(plans) = entry {
                            discard(plans, &mut released);
                        }
                    }
                    continue;
                }
                let mut names = HashSet::new();
                for entry in entries {
                    match entry {
                        Scanned::Subtree(plans) => {
                            self.adopt(tree, plans, Some(&mut changes), &mut released);
                        }
                        Scanned::File(name) => {
                            if let Some(entry) = tree.dirs.get_mut(&dir)
                                && entry.files.insert(name.clone())
                            {
                                changes
                                    .push(change(format!("{dir}/{name}"), TreeChangeKind::Created));
                            }
                            names.insert(name);
                        }
                    }
                }
                if let Some(entry) = tree.dirs.get_mut(&dir) {
                    let vanished: Vec<String> = entry
                        .files
                        .iter()
                        .filter(|name| !names.contains(*name))
                        .cloned()
                        .collect();
                    for name in vanished {
                        entry.files.shift_remove(&name);
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
