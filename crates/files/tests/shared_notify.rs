#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg(target_os = "linux")]

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ostia_files::file_watch::{DirEvent, DirListener, WatchHandle, notify_watch_dir};
use parking_lot::Mutex;
use tempfile::TempDir;

type Seen = Arc<Mutex<Vec<(&'static str, String)>>>;

fn inotify_instances() -> usize {
    fs::read_dir("/proc/self/fd")
        .unwrap()
        .flatten()
        .filter(|fd| {
            fs::read_link(fd.path())
                .is_ok_and(|target| target.to_string_lossy() == "anon_inode:inotify")
        })
        .count()
}

fn listener(label: &'static str, seen: &Seen) -> DirListener {
    let seen = seen.clone();
    Arc::new(move |event| {
        if let DirEvent::Touched(name) = event {
            seen.lock().push((label, name));
        }
    })
}

fn wait_until(find: impl Fn() -> bool) {
    let started = Instant::now();
    while !find() {
        assert!(started.elapsed() < Duration::from_secs(3), "timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn count(seen: &Seen, label: &str) -> usize {
    seen.lock().iter().filter(|(who, _)| *who == label).count()
}

#[test]
fn watches_every_folder_through_one_inotify_instance_and_routes_by_folder() {
    let guard = TempDir::new().unwrap();
    let base = guard.path().canonicalize().unwrap();
    let dirs: Vec<_> = (0..8)
        .map(|index| {
            let dir = base.join(format!("d{index}"));
            fs::create_dir(&dir).unwrap();
            dir
        })
        .collect();
    let seen: Seen = Arc::default();
    let watch = notify_watch_dir();
    let mut handles: Vec<WatchHandle> = dirs
        .iter()
        .map(|dir| watch(dir, listener("first", &seen)).unwrap())
        .collect();
    assert_eq!(inotify_instances(), 1);

    fs::write(dirs[3].join("one.txt"), "x").unwrap();
    wait_until(|| count(&seen, "first") > 0);
    std::thread::sleep(Duration::from_millis(100));
    assert!(seen.lock().iter().all(|(_, name)| name == "one.txt"));
    assert_eq!(count(&seen, "first"), seen.lock().len());

    let other = watch(Path::new(&dirs[3]), listener("second", &seen)).unwrap();
    assert_eq!(inotify_instances(), 1);
    fs::write(dirs[3].join("two.txt"), "x").unwrap();
    wait_until(|| count(&seen, "second") > 0);

    let first_before = count(&seen, "first");
    drop(handles.remove(3));
    std::thread::sleep(Duration::from_millis(100));
    let second_before = count(&seen, "second");
    fs::write(dirs[3].join("three.txt"), "x").unwrap();
    wait_until(|| count(&seen, "second") > second_before);
    assert_eq!(count(&seen, "first"), first_before);

    drop(other);
    drop(handles);
    fs::write(dirs[3].join("four.txt"), "x").unwrap();
    std::thread::sleep(Duration::from_millis(150));
    assert!(!seen.lock().iter().any(|(_, name)| name == "four.txt"));
}
