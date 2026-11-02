#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use history_support::put;
use ostia_terminal::history_feed::SpillClient;
use ostia_terminal::pane_histories::{
    FREE_SPACE_FLOOR, PaneHistories, PaneHistoriesDeps, remove_histories, sweep_history_root,
};
use ostia_terminal::pane_history::PaneHistory;
use ostia_terminal::scrollback_history::ScrollbackHistory;
use parking_lot::Mutex;
use tempfile::TempDir;

type Free = Arc<dyn Fn(&Path) -> Result<u64, String> + Send + Sync>;

const DEAD_PID: u32 = (1 << 22) + 7;

fn deps(root: &Path, setting: ScrollbackHistory, free: Free) -> PaneHistoriesDeps {
    PaneHistoriesDeps {
        root: root.to_path_buf(),
        setting: Arc::new(move || setting),
        start_spill: Arc::new(|| SpillClient::spawn().unwrap()),
        free_bytes: Some(free),
        on_failed: None,
        segment_bytes: None,
    }
}

fn plenty() -> Free {
    Arc::new(|_| Ok(FREE_SPACE_FLOOR * 2))
}

fn histories(setting: ScrollbackHistory, free: Free) -> (PaneHistories, TempDir) {
    let root = tempfile::Builder::new()
        .prefix("histories-")
        .tempdir()
        .unwrap();
    let store = PaneHistories::new(deps(root.path(), setting, free));
    (store, root)
}

fn names(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    found.sort();
    found
}

fn line(text: &str) -> Vec<String> {
    vec![text.to_string()]
}

#[test]
fn sweeps_folders_of_runs_whose_process_is_gone_and_keeps_live_ones() {
    let root = tempfile::tempdir().unwrap();
    let parent = std::os::unix::process::parent_id();
    fs::create_dir(root.path().join(format!("{DEAD_PID}-abcd"))).unwrap();
    fs::create_dir(root.path().join(format!("{parent}-abcd"))).unwrap();
    fs::create_dir(root.path().join("stray")).unwrap();
    sweep_history_root(root.path(), u32::MAX);
    assert_eq!(names(root.path()), vec![format!("{parent}-abcd")]);
    let mode = fs::metadata(root.path()).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
}

#[tokio::test]
async fn keeps_no_history_when_the_setting_is_off() {
    let (store, _root) = histories(ScrollbackHistory::Off, plenty());
    assert!(store.for_pane("p1").is_none());
}

#[tokio::test]
async fn gives_each_pane_its_own_folder_under_this_run_named_without_the_pane_id() {
    let (store, root) = histories(ScrollbackHistory::Unlimited, plenty());
    let history = store.for_pane("p1").unwrap();
    put(&history, &line("a"));
    history.flush().await;
    let runs = names(root.path());
    assert_eq!(runs.len(), 1);
    assert!(runs[0].starts_with(&format!("{}-", std::process::id())));
    let folders = names(&root.path().join(&runs[0]));
    assert_eq!(folders.len(), 1);
    assert!(!folders[0].contains("p1"));
    assert!(history.same_as(&store.for_pane("p1").unwrap()));
    store.remove_all().await.unwrap();
}

#[tokio::test]
async fn drops_a_pane_folder_on_close_and_the_run_folder_on_quit() {
    let (store, root) = histories(ScrollbackHistory::Unlimited, plenty());
    let one = store.for_pane("p1").unwrap();
    let two = store.for_pane("p2").unwrap();
    put(&one, &line("a"));
    put(&two, &line("b"));
    one.flush().await;
    two.flush().await;
    let run = names(root.path()).remove(0);
    store.drop_pane("p1");
    store.remove_all().await.unwrap();
    assert!(!root.path().join(run).exists());
}

#[tokio::test]
async fn frees_space_from_the_largest_pane_first_when_the_disk_runs_low() {
    let root = tempfile::tempdir().unwrap();
    let big: Arc<Mutex<Option<PaneHistory>>> = Arc::new(Mutex::new(None));
    let low = Arc::new(AtomicBool::new(false));
    let free: Free = {
        let big = big.clone();
        let low = low.clone();
        Arc::new(move |_| {
            let first_is_zero = big.lock().as_ref().is_some_and(|h| h.first() == 0);
            if low.load(Ordering::SeqCst) && first_is_zero {
                Ok(0)
            } else {
                Ok(FREE_SPACE_FLOOR)
            }
        })
    };
    let mut config = deps(root.path(), ScrollbackHistory::Unlimited, free);
    config.segment_bytes = Some(1);
    let store = PaneHistories::new(config);
    let large = store.for_pane("big").unwrap();
    *big.lock() = Some(large.clone());
    let small = store.for_pane("small").unwrap();
    for i in 0..3 {
        put(&large, &line(&format!("{} {i}", "x".repeat(1000))));
        large.flush().await;
    }
    assert!(large.droppable());
    low.store(true, Ordering::SeqCst);
    put(&small, &line("y"));
    small.flush().await;
    assert!(large.live());
    assert_eq!(large.first(), 1);
    assert!(small.live());
    assert_eq!(small.read(0, 1).await, line("y"));
    store.remove_all().await.unwrap();
}

#[tokio::test]
async fn fails_only_the_asking_pane_when_the_free_space_cannot_be_read() {
    let root = tempfile::tempdir().unwrap();
    let broken = Arc::new(AtomicBool::new(false));
    let read = broken.clone();
    let free: Free = Arc::new(move |_| {
        if read.load(Ordering::SeqCst) {
            Err("EIO".to_owned())
        } else {
            Ok(FREE_SPACE_FLOOR * 2)
        }
    });
    let mut config = deps(root.path(), ScrollbackHistory::Unlimited, free);
    config.segment_bytes = Some(1);
    let reasons: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = reasons.clone();
    config.on_failed = Some(Arc::new(move |pane, reason| {
        recorded.lock().push((pane.to_owned(), reason.to_owned()));
    }));
    let store = PaneHistories::new(config);
    let other = store.for_pane("other").unwrap();
    for i in 0..3 {
        put(&other, &line(&format!("o {i}")));
        other.flush().await;
    }
    let first_before = other.first();
    let asking = store.for_pane("asking").unwrap();
    broken.store(true, Ordering::SeqCst);
    put(&asking, &line("y"));
    asking.flush().await;
    assert!(!asking.live());
    assert!(other.live());
    assert_eq!(other.first(), first_before);
    assert_eq!(
        *reasons.lock(),
        vec![("asking".to_owned(), "EIO".to_owned())]
    );
    store.remove_all().await.unwrap();
}

#[tokio::test]
async fn turns_a_pane_off_when_no_pane_can_give_up_space() {
    let (store, _root) = histories(ScrollbackHistory::Unlimited, Arc::new(|_| Ok(0)));
    let only = store.for_pane("only").unwrap();
    put(&only, &line("y"));
    only.flush().await;
    assert!(!only.live());
    store.remove_all().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quit_waits_for_the_pending_segment_write_of_a_pane_closed_just_before_quit_and_of_a_failed_history_replaced_for_its_pane()
 {
    type Retire = fn(&PaneHistories);
    let rows: [(&str, Retire); 2] = [
        ("a pane closed just before quit", |store| {
            store.drop_pane("p1");
        }),
        ("a failed history replaced for its pane", |store| {
            store.get("p1").unwrap().fail("test");
            let _ = store.for_pane("p1");
        }),
    ];
    for (name, retire) in rows {
        let root = tempfile::tempdir().unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let entered_tx = Mutex::new(entered_tx);
        let release_rx = Mutex::new(release_rx);
        let held = Arc::new(AtomicBool::new(true));
        let free: Free = Arc::new(move |_| {
            if held.swap(false, Ordering::SeqCst) {
                entered_tx.lock().send(()).unwrap();
                release_rx.lock().recv().unwrap();
            }
            Ok(FREE_SPACE_FLOOR * 2)
        });
        let store = PaneHistories::new(deps(root.path(), ScrollbackHistory::Unlimited, free));
        let history = store.for_pane("p1").unwrap();
        put(&history, &line("a"));
        let flushing = tokio::spawn({
            let history = history.clone();
            async move { history.flush().await }
        });
        tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
            .await
            .unwrap();
        retire(&store);
        let removing = tokio::spawn({
            let store = store.clone();
            async move { store.remove_all().await }
        });
        release_tx.send(()).unwrap();
        removing.await.unwrap().unwrap();
        flushing.await.unwrap();
        assert!(names(root.path()).is_empty(), "{name}");
    }
}

#[tokio::test]
async fn logs_a_run_folder_it_cannot_remove_and_lets_quit_carry_on() {
    let (store, root) = histories(ScrollbackHistory::Unlimited, plenty());
    let history = store.for_pane("p1").unwrap();
    put(&history, &line("a"));
    history.flush().await;
    let locked: PathBuf = root.path().to_path_buf();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
    let warned: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = warned.clone();
    remove_histories(Some(&store), &move |event, code| {
        recorded.lock().push((event.to_string(), code.to_string()));
    })
    .await;
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        *warned.lock(),
        vec![("history-remove-failed".to_string(), "EACCES".to_string())]
    );
}
