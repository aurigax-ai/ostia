#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use ostia_contract::build_info::{BuildInfo, TelemetryStamp};
use ostia_sync::app_update::{UpdateWatcher, UpdateWatcherDeps, without_telemetry};

fn running() -> BuildInfo {
    BuildInfo {
        version: "1.0.0+sha.abcabc".to_owned(),
        built_at: "2026-09-30T10:00:00Z".to_owned(),
        telemetry: None,
        server: None,
    }
}

struct Rig {
    watcher: UpdateWatcher,
    disk: Arc<Mutex<Option<BuildInfo>>>,
    announced: Arc<Mutex<Vec<BuildInfo>>>,
}

fn rig(disk: Option<BuildInfo>) -> Rig {
    let disk = Arc::new(Mutex::new(disk));
    let announced: Arc<Mutex<Vec<BuildInfo>>> = Arc::default();
    let watcher = UpdateWatcher::new(UpdateWatcherDeps {
        current: running(),
        read: Box::new({
            let disk = Arc::clone(&disk);
            move || disk.lock().unwrap().clone()
        }),
        on_update: Box::new({
            let announced = Arc::clone(&announced);
            move |info| announced.lock().unwrap().push(info.clone())
        }),
    });
    Rig {
        watcher,
        disk,
        announced,
    }
}

#[test]
fn stays_quiet_while_the_installed_build_is_the_running_one() {
    let rig = rig(Some(running()));
    assert_eq!(rig.watcher.check(), None);
    assert!(rig.announced.lock().unwrap().is_empty());
}

#[test]
fn announces_a_new_build_once_even_at_the_same_version_and_again_for_a_later_one() {
    let first = BuildInfo {
        version: "1.0.0+sha.defdef".to_owned(),
        built_at: "2026-09-30T11:00:00Z".to_owned(),
        ..running()
    };
    let rig = rig(Some(first.clone()));

    assert_eq!(rig.watcher.check(), Some(first.clone()));
    assert_eq!(rig.watcher.check(), Some(first.clone()));
    assert_eq!(rig.announced.lock().unwrap().len(), 1);

    let later = BuildInfo {
        built_at: "2026-09-30T12:00:00Z".to_owned(),
        ..first
    };
    *rig.disk.lock().unwrap() = Some(later.clone());
    rig.watcher.check();
    assert_eq!(rig.announced.lock().unwrap().len(), 2);
    assert_eq!(rig.watcher.available(), Some(later));
}

#[test]
fn ignores_a_missing_or_half_written_stamp() {
    let rig = rig(None);
    assert_eq!(rig.watcher.check(), None);
    assert!(rig.announced.lock().unwrap().is_empty());
}

#[test]
fn keeps_announcing_nothing_and_reports_no_build_before_the_first_new_one() {
    let rig = rig(Some(running()));
    assert_eq!(rig.watcher.available(), None);
    rig.watcher.check();
    assert_eq!(rig.watcher.available(), None);
}

#[test]
fn sends_the_version_and_build_time_without_the_telemetry_stamp_or_server() {
    let info = BuildInfo {
        telemetry: Some(TelemetryStamp {
            key: "phc_secret".to_owned(),
            host: "https://eu.example".to_owned(),
        }),
        server: Some("https://ostia.example".to_owned()),
        ..running()
    };
    assert_eq!(without_telemetry(&info), running());
}
