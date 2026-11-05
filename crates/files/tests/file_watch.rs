#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use futures_util::future::FutureExt;
use notify::{RecursiveMode, Watcher};
use ostia_base::host::Host;
use ostia_base::path_guard::resolve_safe;
use ostia_files::file_watch::{
    DirEvent, DirListener, FileChange, FileWatches, FileWatchesDeps, TreeChange, TreeChangeKind,
    TreeListener, TreeWatches, TreeWatchesDeps, WatchDir, WatchHandle,
};
use ostia_files::fs_text::write_text;
use parking_lot::Mutex;
use tempfile::TempDir;

const POLL: Duration = Duration::from_secs(3);

type Confine = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

fn real(dir: &TempDir) -> String {
    dir.path()
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned()
}

fn confine_in(roots: Vec<String>) -> Confine {
    let host = Host::current();
    Arc::new(move |path: &str| {
        let refs: Vec<&str> = roots.iter().map(String::as_str).collect();
        resolve_safe(path, &refs, &host).map(|p| p.to_str().unwrap().to_owned())
    })
}

async fn pause(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

async fn settle() {
    if cfg!(target_os = "macos") {
        pause(600).await;
    }
}

async fn wait_for<T>(find: impl Fn() -> Option<T>, limit: Duration) -> T {
    let started = Instant::now();
    loop {
        if let Some(found) = find() {
            return found;
        }
        assert!(started.elapsed() < limit, "timed out after {limit:?}");
        pause(20).await;
    }
}

fn kernel_watches_on(dirs: &[&Path]) -> usize {
    let inodes: Vec<u64> = dirs
        .iter()
        .map(|dir| fs::metadata(dir).unwrap().ino())
        .collect();
    let mut count = 0;
    for fd in fs::read_dir("/proc/self/fdinfo").unwrap().flatten() {
        let Ok(info) = fs::read_to_string(fd.path()) else {
            continue;
        };
        for line in info.lines() {
            let Some(rest) = line.strip_prefix("inotify wd:") else {
                continue;
            };
            let Some(hex) = rest
                .split_whitespace()
                .nth(1)
                .and_then(|part| part.strip_prefix("ino:"))
            else {
                continue;
            };
            if u64::from_str_radix(hex, 16).is_ok_and(|ino| inodes.contains(&ino)) {
                count += 1;
            }
        }
    }
    count
}

fn silent_watch() -> WatchDir {
    Arc::new(|path: &Path, _listener: DirListener| {
        let mut watcher = notify::recommended_watcher(|_event: notify::Result<notify::Event>| {})
            .map_err(io::Error::other)?;
        watcher
            .watch(path, RecursiveMode::NonRecursive)
            .map_err(io::Error::other)?;
        Ok(Box::new(watcher) as WatchHandle)
    })
}

type Emitters = Arc<Mutex<Vec<DirListener>>>;

fn driven_watch() -> (WatchDir, Emitters) {
    let emitters: Emitters = Arc::new(Mutex::new(Vec::new()));
    let seen = emitters.clone();
    let watch: WatchDir = Arc::new(move |_path: &Path, listener: DirListener| {
        seen.lock().push(listener);
        Ok(Box::new(()) as WatchHandle)
    });
    (watch, emitters)
}

struct FileSetup {
    _dir: TempDir,
    root: String,
    changes: Arc<Mutex<Vec<FileChange>>>,
    watches: FileWatches,
}

impl FileSetup {
    fn paths(&self) -> Vec<String> {
        self.changes.lock().iter().map(|c| c.path.clone()).collect()
    }

    fn seen(&self, path: &str) -> Option<FileChange> {
        self.changes.lock().iter().find(|c| c.path == path).cloned()
    }

    fn all(&self) -> Vec<FileChange> {
        self.changes.lock().clone()
    }
}

impl Drop for FileSetup {
    fn drop(&mut self) {
        self.watches.close_all();
    }
}

fn file_setup_with(
    debounce_ms: u64,
    reconcile_ms: Option<u64>,
    watch_dir: Option<WatchDir>,
) -> FileSetup {
    let dir = TempDir::new().unwrap();
    let root = real(&dir);
    let changes: Arc<Mutex<Vec<FileChange>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = changes.clone();
    let watches = FileWatches::new(FileWatchesDeps {
        confine: confine_in(vec![root.clone()]),
        debounce: Duration::from_millis(debounce_ms),
        on_change: Arc::new(move |change| sink.lock().push(change)),
        reconcile: reconcile_ms.map(Duration::from_millis),
        watch_dir,
    });
    FileSetup {
        _dir: dir,
        root,
        changes,
        watches,
    }
}

fn file_setup() -> FileSetup {
    file_setup_with(30, None, None)
}

fn change(path: &str, exists: bool, owners: &[&str]) -> FileChange {
    FileChange {
        path: path.to_owned(),
        exists,
        owners: owners.iter().map(|o| (*o).to_owned()).collect(),
    }
}

fn save_text(
    path: &str,
    text: &'static str,
) -> impl FnOnce()
    -> futures_util::future::BoxFuture<'static, io::Result<ostia_files::fs_text::FileStamp>>
+ Send
+ 'static {
    let path = path.to_owned();
    move || async move { write_text(Path::new(&path), text) }.boxed()
}

fn rename_over(root: &str, temp: &str, target: &str, text: &str) {
    fs::write(format!("{root}/{temp}"), text).unwrap();
    fs::rename(format!("{root}/{temp}"), target).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn erl_c1_notices_a_write_then_rename_save_within_a_second() {
    let s = file_setup();
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "one").unwrap();
    assert!(s.watches.watch("win-1", &file));
    settle().await;
    let started = Instant::now();
    rename_over(&s.root, ".a.txt.tmp", &file, "two");
    let found = wait_for(|| s.seen(&file), POLL).await;
    assert_eq!(found, change(&file, true, &["win-1"]));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test(flavor = "multi_thread")]
async fn erl_c2_refuses_to_watch_a_file_outside_the_folders_ostia_may_read() {
    let s = file_setup();
    assert!(!s.watches.watch("win-1", "/etc/hostname"));
    assert_eq!(s.watches.watched_dirs(), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn erl_c3_keeps_a_folder_watched_while_any_window_has_a_file_open_in_it() {
    let s = file_setup();
    fs::create_dir(format!("{}/sub", s.root)).unwrap();
    let file = format!("{}/sub/b.txt", s.root);
    fs::write(&file, "x").unwrap();
    s.watches.watch("win-1", &file);
    s.watches.watch("win-2", &file);
    s.watches.unwatch("win-1", &file);
    assert_eq!(s.watches.watched_dirs(), vec![format!("{}/sub", s.root)]);
    s.watches.unwatch("win-2", &file);
    assert_eq!(s.watches.watched_dirs(), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn stays_silent_when_a_watched_file_is_rewritten_with_the_same_content() {
    let s = file_setup();
    let same = format!("{}/same.txt", s.root);
    let other = format!("{}/other.txt", s.root);
    fs::write(&same, "one").unwrap();
    fs::write(&other, "one").unwrap();
    s.watches.watch("win-1", &same);
    s.watches.watch("win-1", &other);
    settle().await;
    pause(120).await;
    fs::write(&same, "one").unwrap();
    rename_over(&s.root, ".same.txt.tmp", &same, "one");
    pause(120).await;
    fs::write(&other, "two").unwrap();
    wait_for(|| s.seen(&other), POLL).await;
    pause(120).await;
    assert_eq!(s.paths(), vec![other]);
}

#[tokio::test(flavor = "multi_thread")]
async fn tells_only_the_other_windows_about_a_save_ostia_wrote_and_still_reports_a_later_outside_change()
 {
    let s = file_setup();
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "one").unwrap();
    s.watches.watch("win-1", &file);
    s.watches.watch("win-2", &file);
    settle().await;
    pause(120).await;
    s.watches
        .write("win-1", &file, b"two", save_text(&file, "two"))
        .await
        .unwrap();
    pause(200).await;
    assert_eq!(s.all(), vec![change(&file, true, &["win-2"])]);

    rename_over(&s.root, ".a.txt.tmp", &file, "three");
    wait_for(|| (s.all().len() == 2).then_some(()), POLL).await;
    assert_eq!(s.all()[1], change(&file, true, &["win-1", "win-2"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_nothing_for_a_save_ostia_wrote_when_only_the_writer_has_the_file_open() {
    let s = file_setup();
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "one").unwrap();
    s.watches.watch("win-1", &file);
    settle().await;
    s.watches
        .write("win-1", &file, b"two", save_text(&file, "two"))
        .await
        .unwrap();
    pause(200).await;
    assert_eq!(s.all(), Vec::<FileChange>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_nothing_to_the_writer_when_its_save_takes_longer_than_the_debounce() {
    let s = file_setup();
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "one").unwrap();
    s.watches.watch("win-1", &file);
    settle().await;
    let slow = file.clone();
    s.watches
        .write("win-1", &file, b"two", move || {
            async move {
                fs::write(&slow, "").unwrap();
                pause(120).await;
                write_text(Path::new(&slow), "two")
            }
            .boxed()
        })
        .await
        .unwrap();
    pause(200).await;
    assert_eq!(s.all(), Vec::<FileChange>::new());
    assert_eq!(fs::read_to_string(&file).unwrap(), "two");
}

#[tokio::test(flavor = "multi_thread")]
async fn passes_a_failed_save_on_and_still_reports_what_it_left_on_disk() {
    let s = file_setup();
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "one").unwrap();
    s.watches.watch("win-1", &file);
    settle().await;
    let failing = file.clone();
    let failed = s
        .watches
        .write("win-1", &file, b"two", move || {
            async move {
                fs::write(&failing, "").unwrap();
                Err(io::Error::other("disk full"))
            }
            .boxed()
        })
        .await;
    assert_eq!(failed.unwrap_err().to_string(), "disk full");
    wait_for(|| s.seen(&file), POLL).await;
    assert_eq!(s.all(), vec![change(&file, true, &["win-1"])]);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_once_for_a_burst_of_writes_with_the_last_content_on_disk() {
    let s = file_setup_with(80, None, None);
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "zero").unwrap();
    s.watches.watch("win-1", &file);
    settle().await;
    for text in ["one", "two", "three"] {
        fs::write(&file, text).unwrap();
        pause(20).await;
    }
    wait_for(|| s.seen(&file), POLL).await;
    pause(200).await;
    assert_eq!(s.all(), vec![change(&file, true, &["win-1"])]);
    assert_eq!(fs::read_to_string(&file).unwrap(), "three");
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_second_write_that_lands_soon_after_the_first_was_reported() {
    let (driven, emitters) = driven_watch();
    let s = file_setup_with(5, None, Some(driven));
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "zero").unwrap();
    s.watches.watch("win-1", &file);
    settle().await;
    fs::write(&file, "one").unwrap();
    (emitters.lock()[0])(DirEvent::Touched("a.txt".to_owned()));
    wait_for(|| s.seen(&file), POLL).await;
    fs::write(&file, "two").unwrap();
    (emitters.lock()[0])(DirEvent::Touched("a.txt".to_owned()));
    wait_for(|| (s.all().len() == 2).then_some(()), POLL).await;
    let exists: Vec<bool> = s.all().iter().map(|c| c.exists).collect();
    assert_eq!(exists, vec![true, true]);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_watched_file_deleted_and_then_its_return() {
    let s = file_setup();
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "one").unwrap();
    s.watches.watch("win-1", &file);
    s.watches.watch("win-2", &file);
    settle().await;
    fs::remove_file(&file).unwrap();
    wait_for(|| s.all().iter().find(|c| !c.exists).cloned(), POLL).await;
    fs::write(&file, "back").unwrap();
    wait_for(|| (s.all().len() == 2).then_some(()), POLL).await;
    assert_eq!(
        s.all(),
        vec![
            change(&file, false, &["win-1", "win-2"]),
            change(&file, true, &["win-1", "win-2"]),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_file_that_changes_from_a_link_into_a_regular_file() {
    let s = file_setup();
    let target = format!("{}/target.txt", s.root);
    let link = format!("{}/link.txt", s.root);
    fs::write(&target, "one").unwrap();
    symlink(&target, &link).unwrap();
    s.watches.watch("win-1", &link);
    settle().await;
    rename_over(&s.root, ".link.txt.tmp", &link, "two");
    let found = wait_for(|| s.seen(&link), POLL).await;
    assert!(found.exists);
}

#[tokio::test(flavor = "multi_thread")]
async fn watches_a_file_opened_through_a_linked_folder_under_the_path_it_was_opened_with() {
    let s = file_setup();
    fs::create_dir(format!("{}/real", s.root)).unwrap();
    symlink(format!("{}/real", s.root), format!("{}/linked", s.root)).unwrap();
    let file = format!("{}/linked/a.txt", s.root);
    fs::write(&file, "one").unwrap();
    settle().await;
    assert!(s.watches.watch("win-1", &file));
    settle().await;
    fs::write(format!("{}/real/a.txt", s.root), "two").unwrap();
    let found = wait_for(|| s.all().first().cloned(), POLL).await;
    assert_eq!(found, change(&file, true, &["win-1"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_file_whose_folder_does_not_exist() {
    let s = file_setup();
    assert!(
        !s.watches
            .watch("win-1", &format!("{}/missing/a.txt", s.root))
    );
    assert_eq!(s.watches.watched_dirs(), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_nothing_about_files_it_was_not_asked_to_watch() {
    let s = file_setup();
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "one").unwrap();
    settle().await;
    s.watches.watch("win-1", &file);
    settle().await;
    fs::write(format!("{}/unwatched.txt", s.root), "x").unwrap();
    fs::write(&file, "two").unwrap();
    wait_for(|| s.seen(&file), POLL).await;
    pause(100).await;
    assert_eq!(s.paths(), vec![file]);
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn holds_one_kernel_watch_per_folder_never_polls_and_releases_it() {
    let s = file_setup();
    let base = TempDir::new().unwrap();
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "one").unwrap();
    fs::write(format!("{}/b.txt", s.root), "one").unwrap();
    s.watches.watch("win-1", &file);
    s.watches.watch("win-1", &format!("{}/b.txt", s.root));
    assert_eq!(kernel_watches_on(&[Path::new(&s.root)]), 1);
    assert_eq!(
        kernel_watches_on(&[
            Path::new(&file),
            &base.path().canonicalize().unwrap(),
            &std::env::temp_dir()
        ]),
        0
    );
    fs::write(&file, "two").unwrap();
    wait_for(|| s.seen(&file), POLL).await;
    s.watches.close_all();
    assert_eq!(s.watches.watched_dirs(), Vec::<String>::new());
    assert_eq!(kernel_watches_on(&[Path::new(&s.root)]), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_watched_file_as_gone_when_its_folder_vanishes_and_nothing_from_the_folder_above()
{
    let s = file_setup();
    let file = format!("{}/sub/a.txt", s.root);
    fs::create_dir(format!("{}/sub", s.root)).unwrap();
    fs::write(&file, "one").unwrap();
    settle().await;
    assert!(s.watches.watch("win-1", &file));
    settle().await;
    fs::remove_dir_all(format!("{}/sub", s.root)).unwrap();
    wait_for(|| s.seen(&file), POLL).await;
    pause(150).await;
    assert_eq!(s.all(), vec![change(&file, false, &["win-1"])]);
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_reporting_once_a_window_lets_go_of_its_files() {
    let s = file_setup();
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "one").unwrap();
    s.watches.watch("win-1", &file);
    s.watches.unwatch_owner("win-1");
    assert_eq!(s.watches.watched_dirs(), Vec::<String>::new());
    fs::write(&file, "two").unwrap();
    pause(150).await;
    assert_eq!(s.all(), Vec::<FileChange>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn drops_a_folder_whose_watcher_reports_an_error() {
    let (driven, emitters) = driven_watch();
    let s = file_setup_with(5, None, Some(driven));
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "one").unwrap();
    assert!(s.watches.watch("win-1", &file));
    assert_eq!(s.watches.watched_dirs(), vec![s.root.clone()]);
    (emitters.lock()[0])(DirEvent::Failed);
    assert_eq!(s.watches.watched_dirs(), Vec::<String>::new());
}

struct TreeSetup {
    _guard: TempDir,
    base: String,
    root: String,
    changes: Arc<Mutex<Vec<TreeChange>>>,
    batches: Arc<Mutex<Vec<Vec<TreeChange>>>>,
    watches: TreeWatches,
}

impl TreeSetup {
    fn listen(&self) -> TreeListener {
        let changes = self.changes.clone();
        let batches = self.batches.clone();
        Arc::new(move |batch: &[TreeChange]| {
            batches.lock().push(batch.to_vec());
            changes.lock().extend(batch.iter().cloned());
        })
    }

    fn seen(&self, path: &str, kind: TreeChangeKind) -> Option<TreeChange> {
        self.changes
            .lock()
            .iter()
            .find(|c| c.path == Path::new(path) && c.kind == kind)
            .cloned()
    }

    fn paths(&self) -> Vec<String> {
        self.changes
            .lock()
            .iter()
            .map(|c| c.path.to_str().unwrap().to_owned())
            .collect()
    }

    fn all(&self) -> Vec<TreeChange> {
        self.changes.lock().clone()
    }
}

impl Drop for TreeSetup {
    fn drop(&mut self) {
        self.watches.close_all();
    }
}

fn tree_with(
    max_dirs: Option<usize>,
    reconcile_ms: Option<u64>,
    watch_dir: Option<WatchDir>,
) -> TreeSetup {
    let guard = TempDir::new().unwrap();
    let base = real(&guard);
    let root = format!("{base}/root");
    fs::create_dir_all(format!("{root}/src/deep")).unwrap();
    fs::create_dir_all(format!("{root}/node_modules/pkg")).unwrap();
    fs::create_dir(format!("{root}/.git")).unwrap();
    fs::create_dir(format!("{base}/sibling")).unwrap();
    fs::write(format!("{root}/src/a.txt"), "one").unwrap();
    let watches = TreeWatches::new(TreeWatchesDeps {
        confine: confine_in(vec![base.clone()]),
        debounce: Duration::from_millis(30),
        max_dirs,
        reconcile: reconcile_ms.map(Duration::from_millis),
        watch_dir,
    });
    TreeSetup {
        _guard: guard,
        base,
        root,
        changes: Arc::new(Mutex::new(Vec::new())),
        batches: Arc::new(Mutex::new(Vec::new())),
        watches,
    }
}

fn tree() -> TreeSetup {
    tree_with(None, None, None)
}

fn silent_tree() -> TreeSetup {
    tree_with(None, Some(40), Some(silent_watch()))
}

fn tree_change(path: &str, kind: TreeChangeKind) -> TreeChange {
    TreeChange {
        path: PathBuf::from(path),
        kind,
    }
}

fn no_listener() -> TreeListener {
    Arc::new(|_: &[TreeChange]| {})
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_file_created_changed_and_deleted_anywhere_under_the_root() {
    let t = tree();
    settle().await;
    let stop = t.watches.watch(&t.root, t.listen());
    settle().await;
    assert!(stop.is_some());
    let created = format!("{}/src/deep/new.txt", t.root);
    fs::write(&created, "x").unwrap();
    wait_for(|| t.seen(&created, TreeChangeKind::Created), POLL).await;
    let existing = format!("{}/src/a.txt", t.root);
    fs::write(&existing, "two").unwrap();
    wait_for(|| t.seen(&existing, TreeChangeKind::Changed), POLL).await;
    fs::remove_file(&created).unwrap();
    wait_for(|| t.seen(&created, TreeChangeKind::Deleted), POLL).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_the_files_of_a_root_that_vanished_as_deleted_and_nothing_from_beside_it() {
    let t = tree();
    settle().await;
    t.watches.watch(&t.root, t.listen());
    settle().await;
    fs::remove_dir_all(&t.root).unwrap();
    let gone = format!("{}/src/a.txt", t.root);
    wait_for(|| t.seen(&gone, TreeChangeKind::Deleted), POLL).await;
    fs::write(format!("{}/sibling/x.txt", t.base), "x").unwrap();
    pause(150).await;
    assert!(
        t.all().iter().all(
            |c| c.kind == TreeChangeKind::Deleted && c.path.starts_with(format!("{}/", t.root))
        )
    );
    assert!(
        !t.watches
            .watched_dirs(&t.root)
            .contains(&format!("{}/src", t.root))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn watches_a_folder_made_later_and_reports_the_files_already_in_it() {
    let t = tree();
    settle().await;
    t.watches.watch(&t.root, t.listen());
    settle().await;
    let made = format!("{}/src/later", t.root);
    fs::create_dir(&made).unwrap();
    fs::write(format!("{made}/first.txt"), "x").unwrap();
    wait_for(
        || t.seen(&format!("{made}/first.txt"), TreeChangeKind::Created),
        POLL,
    )
    .await;
    fs::write(format!("{made}/second.txt"), "y").unwrap();
    wait_for(
        || t.seen(&format!("{made}/second.txt"), TreeChangeKind::Created),
        POLL,
    )
    .await;
    assert!(t.watches.watched_dirs(&t.root).contains(&made));
}

#[tokio::test(flavor = "multi_thread")]
async fn loses_no_file_written_into_folders_as_they_are_being_made() {
    let t = tree();
    settle().await;
    t.watches.watch(&t.root, t.listen());
    settle().await;
    let mut made = Vec::new();
    for folder in 0..12 {
        let dir = format!("{}/src/bulk-{folder}/inner", t.root);
        fs::create_dir_all(&dir).unwrap();
        for file in 0..20 {
            let path = format!("{dir}/f{file}.txt");
            fs::write(&path, "x").unwrap();
            made.push(path);
            if file % 5 == 4 {
                tokio::task::yield_now().await;
            }
        }
    }
    wait_for(
        || {
            let created: std::collections::HashSet<String> = t
                .all()
                .iter()
                .filter(|c| c.kind == TreeChangeKind::Created)
                .map(|c| c.path.to_str().unwrap().to_owned())
                .collect();
            made.iter().all(|p| created.contains(p)).then_some(())
        },
        Duration::from_secs(10),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn delivers_changes_made_together_as_one_batch_of_path_and_kind() {
    let t = tree();
    settle().await;
    t.watches.watch(&t.root, t.listen());
    settle().await;
    fs::write(format!("{}/one.txt", t.root), "x").unwrap();
    fs::write(format!("{}/src/two.txt", t.root), "x").unwrap();
    fs::write(format!("{}/src/a.txt", t.root), "two").unwrap();
    let expected = vec![
        tree_change(&format!("{}/one.txt", t.root), TreeChangeKind::Created),
        tree_change(&format!("{}/src/a.txt", t.root), TreeChangeKind::Changed),
        tree_change(&format!("{}/src/two.txt", t.root), TreeChangeKind::Created),
    ];
    if cfg!(target_os = "macos") {
        wait_for(
            || expected.iter().all(|c| t.all().contains(c)).then_some(()),
            POLL,
        )
        .await;
        return;
    }
    let mut first = wait_for(|| t.batches.lock().first().cloned(), POLL).await;
    first.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(first, expected);
    pause(100).await;
    assert_eq!(t.batches.lock().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_second_write_to_a_file_that_lands_right_after_a_batch_went_out() {
    let t = tree();
    let file = format!("{}/src/a.txt", t.root);
    settle().await;
    t.watches.watch(&t.root, t.listen());
    settle().await;
    fs::write(&file, "two").unwrap();
    wait_for(|| t.all().first().cloned(), POLL).await;
    fs::write(&file, "three").unwrap();
    wait_for(|| (t.all().len() == 2).then_some(()), POLL).await;
    assert_eq!(
        t.all(),
        vec![
            tree_change(&file, TreeChangeKind::Changed),
            tree_change(&file, TreeChangeKind::Changed),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn never_descends_into_dependency_or_version_control_folders_or_through_a_linked_folder() {
    let t = tree();
    let outside = TempDir::new().unwrap();
    let outside_path = real(&outside);
    symlink(&outside_path, format!("{}/linked", t.root)).unwrap();
    settle().await;
    t.watches.watch(&t.root, t.listen());
    settle().await;
    assert_eq!(
        t.watches.watched_dirs(&t.root),
        vec![
            t.root.clone(),
            format!("{}/src", t.root),
            format!("{}/src/deep", t.root)
        ]
    );
    fs::write(format!("{}/node_modules/pkg/index.js", t.root), "x").unwrap();
    fs::write(format!("{outside_path}/secret.txt"), "x").unwrap();
    let marker = format!("{}/src/marker.txt", t.root);
    fs::write(&marker, "x").unwrap();
    wait_for(|| t.seen(&marker, TreeChangeKind::Created), POLL).await;
    assert_eq!(t.paths(), vec![marker]);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_link_to_a_folder_made_later_as_one_created_path_and_never_looks_inside_it() {
    let t = tree();
    let outside = TempDir::new().unwrap();
    let outside_path = real(&outside);
    fs::write(format!("{outside_path}/before.txt"), "x").unwrap();
    settle().await;
    t.watches.watch(&t.root, t.listen());
    settle().await;
    let link = format!("{}/src/linked", t.root);
    symlink(&outside_path, &link).unwrap();
    wait_for(|| t.seen(&link, TreeChangeKind::Created), POLL).await;
    fs::write(format!("{outside_path}/secret.txt"), "x").unwrap();
    fs::create_dir(format!("{}/src/node_modules", t.root)).unwrap();
    fs::write(format!("{}/src/node_modules/index.js", t.root), "x").unwrap();
    let marker = format!("{}/src/marker.txt", t.root);
    fs::write(&marker, "x").unwrap();
    wait_for(|| t.seen(&marker, TreeChangeKind::Created), POLL).await;
    pause(100).await;
    let mut paths = t.paths();
    paths.sort();
    let mut expected = vec![link, marker];
    expected.sort();
    assert_eq!(paths, expected);
    assert_eq!(
        t.watches.watched_dirs(&t.root),
        vec![
            t.root.clone(),
            format!("{}/src", t.root),
            format!("{}/src/deep", t.root)
        ]
    );
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn holds_one_kernel_watch_per_watched_folder_and_none_on_skipped_linked_or_outside_folders() {
    let t = tree();
    let outside = TempDir::new().unwrap();
    let outside_path = real(&outside);
    symlink(&outside_path, format!("{}/linked", t.root)).unwrap();
    t.watches.watch(&t.root, t.listen());
    let root = t.root.clone();
    let watched = [
        PathBuf::from(&root),
        PathBuf::from(format!("{root}/src")),
        PathBuf::from(format!("{root}/src/deep")),
    ];
    let watched_refs: Vec<&Path> = watched.iter().map(PathBuf::as_path).collect();
    assert_eq!(kernel_watches_on(&watched_refs), 3);
    let unwatched = [
        PathBuf::from(&t.base),
        PathBuf::from(format!("{}/sibling", t.base)),
        PathBuf::from(&outside_path),
        std::env::temp_dir(),
        PathBuf::from(format!("{root}/.git")),
        PathBuf::from(format!("{root}/node_modules")),
        PathBuf::from(format!("{root}/node_modules/pkg")),
        PathBuf::from(format!("{root}/src/a.txt")),
    ];
    let unwatched_refs: Vec<&Path> = unwatched.iter().map(PathBuf::as_path).collect();
    assert_eq!(kernel_watches_on(&unwatched_refs), 0);
    fs::write(format!("{}/sibling/x.txt", t.base), "x").unwrap();
    fs::write(format!("{}/beside.txt", t.base), "x").unwrap();
    pause(120).await;
    t.watches.close_all();
    assert_eq!(kernel_watches_on(&watched_refs), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_nothing_from_beside_or_above_the_root() {
    let t = tree();
    settle().await;
    t.watches.watch(&t.root, t.listen());
    settle().await;
    fs::write(format!("{}/sibling/x.txt", t.base), "x").unwrap();
    fs::write(format!("{}/beside.txt", t.base), "x").unwrap();
    let marker = format!("{}/marker.txt", t.root);
    fs::write(&marker, "x").unwrap();
    wait_for(|| t.seen(&marker, TreeChangeKind::Created), POLL).await;
    pause(100).await;
    let distinct: std::collections::BTreeSet<String> = t.paths().into_iter().collect();
    assert_eq!(distinct, std::collections::BTreeSet::from([marker]));
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_folder_outside_the_readable_roots_and_stops_at_the_folder_limit() {
    let t = tree_with(Some(2), None, None);
    assert!(t.watches.watch("/etc", no_listener()).is_none());
    assert!(
        t.watches
            .watch(&format!("{}/src/a.txt", t.root), no_listener())
            .is_none()
    );
    t.watches.watch(&t.root, no_listener());
    assert_eq!(t.watches.watched_dirs(&t.root).len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_root_that_is_a_link_to_a_folder() {
    let t = tree();
    let alias = format!("{}/alias", t.base);
    symlink(&t.root, &alias).unwrap();
    assert!(t.watches.watch(&alias, no_listener()).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn at_the_folder_limit_watches_the_nearest_folders_first_and_leaves_the_rest_unwatched() {
    let t = tree_with(Some(3), None, None);
    fs::create_dir(format!("{}/lib", t.root)).unwrap();
    settle().await;
    t.watches.watch(&t.root, t.listen());
    settle().await;
    assert_eq!(
        t.watches.watched_dirs(&t.root),
        vec![
            t.root.clone(),
            format!("{}/lib", t.root),
            format!("{}/src", t.root)
        ]
    );
    #[cfg(target_os = "linux")]
    {
        let near = [
            PathBuf::from(&t.root),
            PathBuf::from(format!("{}/lib", t.root)),
            PathBuf::from(format!("{}/src", t.root)),
        ];
        let near_refs: Vec<&Path> = near.iter().map(PathBuf::as_path).collect();
        assert_eq!(kernel_watches_on(&near_refs), 3);
        assert_eq!(
            kernel_watches_on(&[Path::new(&format!("{}/src/deep", t.root))]),
            0
        );
    }
    fs::write(format!("{}/src/deep/unseen.txt", t.root), "x").unwrap();
    fs::create_dir(format!("{}/lib/later", t.root)).unwrap();
    fs::write(format!("{}/lib/later/unseen.txt", t.root), "x").unwrap();
    let marker = format!("{}/lib/marker.txt", t.root);
    fs::write(&marker, "x").unwrap();
    wait_for(|| t.seen(&marker, TreeChangeKind::Created), POLL).await;
    pause(100).await;
    let mut distinct: Vec<String> = Vec::new();
    for path in t.paths() {
        if !distinct.contains(&path) {
            distinct.push(path);
        }
    }
    assert_eq!(distinct, vec![marker]);
    assert_eq!(t.watches.watched_dirs(&t.root).len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn watches_a_new_folder_once_a_removed_one_made_room_under_the_limit() {
    let t = tree_with(Some(3), None, None);
    settle().await;
    t.watches.watch(&t.root, t.listen());
    settle().await;
    assert_eq!(
        t.watches.watched_dirs(&t.root),
        vec![
            t.root.clone(),
            format!("{}/src", t.root),
            format!("{}/src/deep", t.root)
        ]
    );
    fs::remove_dir_all(format!("{}/src/deep", t.root)).unwrap();
    wait_for(
        || (t.watches.watched_dirs(&t.root).len() == 2).then_some(()),
        POLL,
    )
    .await;
    fs::create_dir(format!("{}/src/next", t.root)).unwrap();
    let inner = format!("{}/src/next/in.txt", t.root);
    fs::write(&inner, "x").unwrap();
    wait_for(|| t.seen(&inner, TreeChangeKind::Created), POLL).await;
    assert_eq!(
        t.watches.watched_dirs(&t.root),
        vec![
            t.root.clone(),
            format!("{}/src", t.root),
            format!("{}/src/next", t.root)
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_the_files_of_a_removed_folder_as_deleted_and_stops_watching_it() {
    let t = tree();
    fs::write(format!("{}/src/deep/in.txt", t.root), "x").unwrap();
    settle().await;
    t.watches.watch(&t.root, t.listen());
    settle().await;
    fs::remove_dir_all(format!("{}/src", t.root)).unwrap();
    wait_for(
        || {
            t.seen(
                &format!("{}/src/deep/in.txt", t.root),
                TreeChangeKind::Deleted,
            )
        },
        POLL,
    )
    .await;
    wait_for(
        || t.seen(&format!("{}/src/a.txt", t.root), TreeChangeKind::Deleted),
        POLL,
    )
    .await;
    wait_for(
        || (t.watches.watched_dirs(&t.root).len() == 1).then_some(()),
        POLL,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn closes_its_watchers_when_the_last_listener_leaves() {
    let t = tree();
    let first = t.watches.watch(&t.root, t.listen());
    let second = t.watches.watch(&t.root, no_listener());
    first.unwrap()();
    assert!(!t.watches.watched_dirs(&t.root).is_empty());
    second.unwrap()();
    assert_eq!(t.watches.watched_dirs(&t.root), Vec::<String>::new());
    t.watches.close_all();
    #[cfg(target_os = "linux")]
    {
        let all = [
            PathBuf::from(&t.root),
            PathBuf::from(format!("{}/src", t.root)),
            PathBuf::from(format!("{}/src/deep", t.root)),
        ];
        let refs: Vec<&Path> = all.iter().map(PathBuf::as_path).collect();
        assert_eq!(kernel_watches_on(&refs), 0);
    }
    fs::write(format!("{}/src/after.txt", t.root), "x").unwrap();
    pause(120).await;
    assert_eq!(t.all(), Vec::<TreeChange>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn drops_a_tree_folder_whose_watcher_reports_an_error() {
    let (driven, emitters) = driven_watch();
    let t = tree_with(None, None, Some(driven));
    t.watches.watch(&t.root, t.listen());
    let before = t.watches.watched_dirs(&t.root);
    assert_eq!(before.len(), 3);
    assert_eq!(emitters.lock().len(), 3);
    (emitters.lock()[2])(DirEvent::Failed);
    assert_eq!(t.watches.watched_dirs(&t.root).len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn silent_kernel_reports_a_watched_file_as_gone_when_its_folder_vanishes() {
    let s = file_setup_with(10, Some(40), Some(silent_watch()));
    let file = format!("{}/sub/a.txt", s.root);
    fs::create_dir(format!("{}/sub", s.root)).unwrap();
    fs::write(&file, "one").unwrap();
    assert!(s.watches.watch("win-1", &file));
    fs::remove_dir_all(format!("{}/sub", s.root)).unwrap();
    wait_for(|| s.seen(&file), POLL).await;
    pause(150).await;
    assert_eq!(s.all(), vec![change(&file, false, &["win-1"])]);
}

#[tokio::test(flavor = "multi_thread")]
async fn silent_kernel_reports_the_files_of_a_root_that_vanished_as_deleted() {
    let t = silent_tree();
    t.watches.watch(&t.root, t.listen());
    fs::remove_dir_all(&t.root).unwrap();
    wait_for(
        || t.seen(&format!("{}/src/a.txt", t.root), TreeChangeKind::Deleted),
        POLL,
    )
    .await;
    fs::write(format!("{}/sibling/x.txt", t.base), "x").unwrap();
    pause(150).await;
    assert!(
        t.all().iter().all(
            |c| c.kind == TreeChangeKind::Deleted && c.path.starts_with(format!("{}/", t.root))
        )
    );
    assert_eq!(t.watches.watched_dirs(&t.root), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn silent_kernel_loses_no_file_written_into_folders_as_they_are_being_made() {
    let t = silent_tree();
    t.watches.watch(&t.root, t.listen());
    let mut made = Vec::new();
    for folder in 0..6 {
        let dir = format!("{}/src/bulk-{folder}/inner", t.root);
        fs::create_dir_all(&dir).unwrap();
        for file in 0..10 {
            let path = format!("{dir}/f{file}.txt");
            fs::write(&path, "x").unwrap();
            made.push(path);
            if file % 5 == 4 {
                pause(30).await;
            }
        }
    }
    wait_for(
        || {
            let created: std::collections::HashSet<String> = t
                .all()
                .iter()
                .filter(|c| c.kind == TreeChangeKind::Created)
                .map(|c| c.path.to_str().unwrap().to_owned())
                .collect();
            made.iter().all(|p| created.contains(p)).then_some(())
        },
        Duration::from_secs(5),
    )
    .await;
    let created = t
        .all()
        .iter()
        .filter(|c| c.kind == TreeChangeKind::Created)
        .count();
    assert_eq!(created, made.len());
}

fn slow_driven_watch(delay: Duration) -> (WatchDir, Emitters, Arc<AtomicBool>) {
    let emitters: Emitters = Arc::new(Mutex::new(Vec::new()));
    let slow = Arc::new(AtomicBool::new(false));
    let seen = emitters.clone();
    let flag = slow.clone();
    let watch: WatchDir = Arc::new(move |_path: &Path, listener: DirListener| {
        if flag.load(Ordering::SeqCst) {
            std::thread::sleep(delay);
        }
        seen.lock().push(listener);
        Ok(Box::new(()) as WatchHandle)
    });
    (watch, emitters, slow)
}

#[tokio::test(flavor = "multi_thread")]
async fn scans_a_new_folder_without_holding_the_tree_state() {
    let (watch, emitters, slow) = slow_driven_watch(Duration::from_millis(900));
    let t = tree_with(None, None, Some(watch));
    assert!(t.watches.watch(&t.root, t.listen()).is_some());
    slow.store(true, Ordering::SeqCst);
    let fresh = format!("{}/fresh", t.root);
    fs::create_dir(&fresh).unwrap();
    let root_listener = emitters.lock()[0].clone();
    root_listener(DirEvent::Touched("fresh".to_owned()));
    pause(250).await;
    let started = Instant::now();
    let watched = t.watches.watched_dirs(&t.root);
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "the tree state was held for {:?}",
        started.elapsed()
    );
    assert!(!watched.contains(&fresh));
    wait_for(
        || {
            t.watches
                .watched_dirs(&t.root)
                .contains(&fresh)
                .then_some(())
        },
        POLL,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn never_delivers_two_tree_batches_at_the_same_time() {
    let (watch, emitters) = driven_watch();
    let t = tree_with(None, Some(40), Some(watch));
    let active = Arc::new(AtomicUsize::new(0));
    let overlapped = Arc::new(AtomicBool::new(false));
    let delivered = Arc::new(AtomicUsize::new(0));
    let listener: TreeListener = {
        let (active, overlapped, delivered) =
            (active.clone(), overlapped.clone(), delivered.clone());
        Arc::new(move |_: &[TreeChange]| {
            if active.fetch_add(1, Ordering::SeqCst) > 0 {
                overlapped.store(true, Ordering::SeqCst);
            }
            std::thread::sleep(Duration::from_millis(300));
            active.fetch_sub(1, Ordering::SeqCst);
            delivered.fetch_add(1, Ordering::SeqCst);
        })
    };
    assert!(t.watches.watch(&t.root, listener).is_some());
    fs::write(format!("{}/src/one.txt", t.root), "x").unwrap();
    fs::write(format!("{}/src/two.txt", t.root), "x").unwrap();
    let src_listener = emitters.lock()[1].clone();
    src_listener(DirEvent::Touched("one.txt".to_owned()));
    wait_for(
        || (delivered.load(Ordering::SeqCst) >= 2).then_some(()),
        POLL,
    )
    .await;
    pause(400).await;
    assert!(!overlapped.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "multi_thread")]
async fn never_refuses_a_tree_root_that_exists_while_other_threads_open_and_close_it() {
    let (watch, _) = driven_watch();
    let t = tree_with(None, None, Some(watch));
    let refused = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                for _ in 0..400 {
                    match t.watches.watch(&t.root, no_listener()) {
                        Some(stop) => stop(),
                        None => {
                            refused.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                }
            });
        }
    });
    assert_eq!(refused.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn never_runs_two_saves_of_one_file_at_the_same_time() {
    let s = Arc::new(file_setup_with(30, None, Some(silent_watch())));
    let file = format!("{}/a.txt", s.root);
    fs::write(&file, "start").unwrap();
    assert!(s.watches.watch("win-0", &file));
    let active = Arc::new(AtomicUsize::new(0));
    let overlapped = Arc::new(AtomicBool::new(false));
    for round in 0..40 {
        let barrier = Arc::new(tokio::sync::Barrier::new(8));
        let mut tasks = Vec::new();
        for writer in 0..8 {
            let (s, file, barrier) = (s.clone(), file.clone(), barrier.clone());
            let (active, overlapped) = (active.clone(), overlapped.clone());
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                let target = file.clone();
                s.watches
                    .write(&format!("win-{writer}"), &file, b"x", move || {
                        async move {
                            if active.fetch_add(1, Ordering::SeqCst) > 0 {
                                overlapped.store(true, Ordering::SeqCst);
                            }
                            tokio::time::sleep(Duration::from_millis(3)).await;
                            active.fetch_sub(1, Ordering::SeqCst);
                            write_text(Path::new(&target), "x")
                        }
                        .boxed()
                    })
                    .await
                    .unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert!(!overlapped.load(Ordering::SeqCst), "round {round}");
    }
}
