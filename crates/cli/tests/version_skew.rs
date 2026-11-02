#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cell::{Cell, RefCell};
use std::fs;

use ostia_cli::common::version_skew::{SkewMark, skew_mark_file, version_skew_warning};
use tempfile::TempDir;

struct Marks {
    mark: RefCell<Option<String>>,
    writes: Cell<usize>,
}

fn marks(initial: Option<&str>) -> Marks {
    Marks {
        mark: RefCell::new(initial.map(str::to_owned)),
        writes: Cell::new(0),
    }
}

impl SkewMark for Marks {
    fn read(&self) -> Option<String> {
        self.mark.borrow().clone()
    }

    fn write(&self, mark: &str) -> bool {
        self.writes.set(self.writes.get() + 1);
        *self.mark.borrow_mut() = Some(mark.to_owned());
        true
    }
}

struct ReadOnly;

impl SkewMark for ReadOnly {
    fn read(&self) -> Option<String> {
        None
    }

    fn write(&self, _mark: &str) -> bool {
        false
    }
}

#[test]
fn stays_quiet_when_the_versions_match_or_one_is_unknown() {
    assert_eq!(
        version_skew_warning(Some("0.5.13"), Some("0.5.13"), &marks(None)),
        None
    );
    assert_eq!(
        version_skew_warning(None, Some("0.5.13"), &marks(None)),
        None
    );
    assert_eq!(
        version_skew_warning(Some("0.5.13"), None, &marks(None)),
        None
    );
}

#[test]
fn stays_quiet_when_the_mark_cannot_be_written_so_a_sandbox_is_not_warned_on_every_call() {
    assert_eq!(
        version_skew_warning(Some("0.5.13-main.12"), Some("0.5.13-main.13"), &ReadOnly),
        None
    );
}

#[test]
fn warns_once_for_a_pair_of_versions_then_again_when_the_pair_changes() {
    let warned = marks(None);
    assert_eq!(
        version_skew_warning(Some("0.5.13-main.12"), Some("0.5.13-main.13"), &warned).as_deref(),
        Some("ostia: the app runs 0.5.13-main.12, this CLI is 0.5.13-main.13; restart Ostia")
    );
    assert_eq!(
        version_skew_warning(Some("0.5.13-main.12"), Some("0.5.13-main.13"), &warned),
        None
    );
    assert!(
        version_skew_warning(Some("0.5.13-main.14"), Some("0.5.13-main.13"), &warned)
            .unwrap()
            .contains("main.14")
    );
}

#[test]
fn treats_an_empty_version_as_unknown_and_never_touches_the_mark_then() {
    let warned = marks(None);
    assert_eq!(
        version_skew_warning(Some(""), Some("0.5.13"), &warned),
        None
    );
    assert_eq!(
        version_skew_warning(Some("0.5.13"), Some(""), &warned),
        None
    );
    assert_eq!(warned.writes.get(), 0);
}

#[test]
fn records_the_pair_as_app_bar_cli_and_writes_nothing_when_it_is_already_recorded() {
    let warned = marks(None);
    version_skew_warning(Some("1.0.0"), Some("1.0.1"), &warned).unwrap();
    assert_eq!(warned.read().as_deref(), Some("1.0.0|1.0.1"));
    assert_eq!(warned.writes.get(), 1);
    assert_eq!(
        version_skew_warning(Some("1.0.0"), Some("1.0.1"), &warned),
        None
    );
    assert_eq!(warned.writes.get(), 1);
}

#[test]
fn warns_when_the_recorded_pair_is_the_other_way_round() {
    let warned = marks(Some("1.0.1|1.0.0"));
    assert_eq!(
        version_skew_warning(Some("1.0.0"), Some("1.0.1"), &warned).as_deref(),
        Some("ostia: the app runs 1.0.0, this CLI is 1.0.1; restart Ostia")
    );
}

#[test]
fn keeps_the_mark_in_a_file_that_reads_back_exactly_what_was_written() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("skew-mark");
    let file = skew_mark_file(&path);
    assert_eq!(file.read(), None);
    assert!(file.write("1.0.0|1.0.1"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "1.0.0|1.0.1");
    assert_eq!(file.read().as_deref(), Some("1.0.0|1.0.1"));
    assert!(file.write("1.0.0|1.0.2"));
    assert_eq!(file.read().as_deref(), Some("1.0.0|1.0.2"));
}

#[test]
fn reports_a_mark_file_that_cannot_be_written_as_not_written() {
    let dir = TempDir::new().unwrap();
    let file = skew_mark_file(&dir.path().join("missing").join("skew-mark"));
    assert!(!file.write("1.0.0|1.0.1"));
    assert_eq!(file.read(), None);
}

#[test]
fn warns_once_through_a_mark_file() {
    let dir = TempDir::new().unwrap();
    let file = skew_mark_file(&dir.path().join("skew-mark"));
    assert!(version_skew_warning(Some("1.0.0"), Some("1.0.1"), &file).is_some());
    assert_eq!(
        version_skew_warning(Some("1.0.0"), Some("1.0.1"), &file),
        None
    );
}
