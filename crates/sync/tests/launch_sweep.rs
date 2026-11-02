#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ostia_sync::install_replace::PendingSweep;
use ostia_sync::launch_sweep::{LaunchSweep, sweep_update_leftovers};
use support::{is_root, names, write};
use tempfile::TempDir;

const VERSION: &str = "9.9.9";

fn app_folder(dir: &Path) {
    write(&dir.join("resources").join("app.asar"), "asar");
}

struct Outcome {
    swept: usize,
    warned: Vec<String>,
}

async fn sweep(app_dir: &Path, mac_install: bool, version: Option<&str>) -> Outcome {
    let swept = Arc::new(AtomicUsize::new(0));
    let warned: Arc<Mutex<Vec<String>>> = Arc::default();
    sweep_update_leftovers(LaunchSweep {
        pending: Some(PendingSweep {
            app_dir: app_dir.to_path_buf(),
            version: VERSION.to_owned(),
        }),
        app_dir: Some(app_dir.to_path_buf()),
        version: version.map_or_else(|| format!("{VERSION}+sha.abc"), str::to_owned),
        mac_install,
        swept: Box::new({
            let swept = Arc::clone(&swept);
            move || {
                swept.fetch_add(1, Ordering::SeqCst);
            }
        }),
        warn: Box::new({
            let warned = Arc::clone(&warned);
            move |event| warned.lock().unwrap().push(event.as_str().to_owned())
        }),
    })
    .await;
    let mut warned = warned.lock().unwrap().clone();
    warned.sort();
    Outcome {
        swept: swept.load(Ordering::SeqCst),
        warned,
    }
}

#[tokio::test]
async fn the_old_app_folder_of_a_finished_update_is_deleted_at_launch_app_asar_included() {
    let root = TempDir::new().unwrap();
    let app_dir = root.path().join("ostia");
    app_folder(&app_dir);
    let old = PathBuf::from(format!("{}.old", app_dir.display()));
    app_folder(&old);

    let outcome = sweep(&app_dir, false, None).await;

    assert_eq!(names(root.path()), ["ostia"]);
    assert_eq!(outcome.swept, 1);
    assert!(outcome.warned.is_empty());
}

#[tokio::test]
async fn a_staged_copy_and_an_old_app_left_by_an_earlier_update_are_deleted_at_launch_app_asar_included()
 {
    let root = TempDir::new().unwrap();
    let bundle = root.path().join("Ostia.app");
    app_folder(&bundle);
    app_folder(&root.path().join(".Ostia.app.new"));
    app_folder(&PathBuf::from(format!("{}.old", bundle.display())));

    let outcome = sweep(&bundle, true, None).await;

    assert_eq!(names(root.path()), ["Ostia.app"]);
    assert_eq!(outcome.swept, 1);
    assert!(outcome.warned.is_empty());
}

#[tokio::test]
async fn keeps_the_old_folder_and_its_record_until_the_updated_version_runs() {
    let root = TempDir::new().unwrap();
    let app_dir = root.path().join("ostia");
    app_folder(&app_dir);
    app_folder(&PathBuf::from(format!("{}.old", app_dir.display())));

    let outcome = sweep(&app_dir, false, Some("1.0.0")).await;

    assert_eq!(names(root.path()), ["ostia", "ostia.old"]);
    assert_eq!(outcome.swept, 0);
}

#[tokio::test]
async fn logs_a_failed_sweep_and_keeps_the_record() {
    if is_root() {
        return;
    }
    let root = TempDir::new().unwrap();
    let bundle = root.path().join("Ostia.app");
    app_folder(&bundle);
    app_folder(&root.path().join(".Ostia.app.new"));
    app_folder(&PathBuf::from(format!("{}.old", bundle.display())));
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o555)).unwrap();

    let outcome = sweep(&bundle, true, None).await;

    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        outcome.warned,
        ["install-sweep-failed", "update-staged-discard-failed"]
    );
    assert_eq!(outcome.swept, 0);
}

#[tokio::test]
async fn sweeps_nothing_without_a_record_or_an_app_folder() {
    let root = TempDir::new().unwrap();
    let app_dir = root.path().join("ostia");
    app_folder(&app_dir);
    let old = PathBuf::from(format!("{}.old", app_dir.display()));
    app_folder(&old);

    let swept = Arc::new(AtomicUsize::new(0));
    sweep_update_leftovers(LaunchSweep {
        pending: None,
        app_dir: Some(app_dir),
        version: VERSION.to_owned(),
        mac_install: false,
        swept: Box::new({
            let swept = Arc::clone(&swept);
            move || {
                swept.fetch_add(1, Ordering::SeqCst);
            }
        }),
        warn: Box::new(|event| panic!("unexpected warning {}", event.as_str())),
    })
    .await;

    assert!(old.exists());
    assert_eq!(swept.load(Ordering::SeqCst), 0);
}
