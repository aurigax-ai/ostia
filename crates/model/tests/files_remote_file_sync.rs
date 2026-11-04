#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::remote_folders::{
    RemoteContent, RemoteFailure, RemoteReadResult, RemoteStatFile, RemoteStatResult,
    RemoteWriteResult, RemoteWritten,
};
use ostia_model::files::remote_file_sync::{
    REMOTE_POLL_MS, RemoteCheckOutcome, RemoteSaveOutcome, RemoteTextApi, check_remote_text,
    save_remote_text,
};
use parking_lot::Mutex;

const PATH: &str = "remote://abcdef012345/srv/app/app.conf";

struct Remote {
    stat: RemoteStatResult,
    read: RemoteReadResult,
    write: RemoteWriteResult,
    calls: Mutex<Vec<String>>,
}

impl RemoteTextApi for Remote {
    async fn stat(&self, path: &str) -> RemoteStatResult {
        self.calls.lock().push(format!("stat {path}"));
        self.stat.clone()
    }

    async fn read(&self, path: &str) -> RemoteReadResult {
        self.calls.lock().push(format!("read {path}"));
        self.read.clone()
    }

    async fn write(&self, path: &str, content: &str, base_version: &str) -> RemoteWriteResult {
        self.calls
            .lock()
            .push(format!("write {path} {content} {base_version}"));
        self.write.clone()
    }
}

impl Remote {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().clone()
    }

    fn last_call(&self) -> String {
        self.calls().last().cloned().unwrap_or_default()
    }

    fn called(&self, verb: &str) -> bool {
        self.calls().iter().any(|call| call.starts_with(verb))
    }
}

fn missing_stat() -> RemoteStatResult {
    RemoteStatResult::Failure(RemoteFailure::of("not-found"))
}

fn missing_read() -> RemoteReadResult {
    RemoteReadResult::Failure(RemoteFailure::of("not-found"))
}

fn written(version: &str) -> RemoteWriteResult {
    RemoteWriteResult::Written(RemoteWritten {
        ok: true,
        version: version.to_owned(),
    })
}

fn write_failure(error: &'static str) -> RemoteWriteResult {
    RemoteWriteResult::Failure(RemoteFailure::of(error))
}

fn stat_of(kind: &'static str, version: Option<&str>) -> RemoteStatResult {
    RemoteStatResult::Stat(RemoteStatFile {
        ok: true,
        kind,
        version: version.map(str::to_owned),
    })
}

fn content(text: &str, version: &str) -> RemoteReadResult {
    RemoteReadResult::Content(RemoteContent {
        ok: true,
        content: text.to_owned(),
        version: version.to_owned(),
    })
}

fn api() -> Remote {
    Remote {
        stat: missing_stat(),
        read: missing_read(),
        write: written("2-2"),
        calls: Mutex::new(Vec::new()),
    }
}

fn failed(error: &'static str) -> RemoteSaveOutcome {
    RemoteSaveOutcome::Failed {
        error: RemoteFailure::of(error).error,
    }
}

#[test]
fn polls_every_three_seconds() {
    assert_eq!(REMOTE_POLL_MS, 3000);
}

#[tokio::test]
async fn ssh_c66_sends_the_text_with_the_version_it_was_read_at_and_returns_the_new_version() {
    let remote = Remote {
        write: written("9-4"),
        ..api()
    };
    assert_eq!(
        save_remote_text(&remote, PATH, "text", Some("1-1"), false).await,
        RemoteSaveOutcome::Saved {
            version: "9-4".to_owned()
        }
    );
    assert_eq!(remote.last_call(), format!("write {PATH} text 1-1"));
}

#[tokio::test]
async fn writes_a_file_that_did_not_exist_as_new_and_overwrites_with_any_when_forced() {
    let remote = api();
    save_remote_text(&remote, PATH, "text", None, false).await;
    assert_eq!(remote.last_call(), format!("write {PATH} text new"));
    save_remote_text(&remote, PATH, "text", Some("1-1"), true).await;
    assert_eq!(remote.last_call(), format!("write {PATH} text any"));
}

#[tokio::test]
async fn forcing_a_save_of_a_new_file_also_writes_with_any() {
    let remote = api();
    save_remote_text(&remote, PATH, "text", None, true).await;
    assert_eq!(remote.last_call(), format!("write {PATH} text any"));
}

#[tokio::test]
async fn ssh_c67_reads_what_is_on_the_host_now_when_the_file_changed_so_the_human_can_compare() {
    let remote = Remote {
        write: write_failure("changed"),
        read: content("theirs", "5-6"),
        ..api()
    };
    assert_eq!(
        save_remote_text(&remote, PATH, "mine", Some("1-1"), false).await,
        RemoteSaveOutcome::Conflict {
            disk: "theirs".to_owned(),
            version: "5-6".to_owned(),
        }
    );
    assert_eq!(remote.calls().len(), 2);
    assert_eq!(remote.calls()[1], format!("read {PATH}"));
}

#[tokio::test]
async fn reports_a_file_that_vanished_as_deleted_and_any_other_failure_as_failed() {
    let vanished = Remote {
        write: write_failure("changed"),
        ..api()
    };
    assert_eq!(
        save_remote_text(&vanished, PATH, "mine", Some("1-1"), false).await,
        RemoteSaveOutcome::Deleted
    );

    let denied = Remote {
        write: write_failure("denied"),
        ..api()
    };
    assert_eq!(
        save_remote_text(&denied, PATH, "mine", Some("1-1"), false).await,
        failed("denied")
    );
    assert!(!denied.called("read"));

    let unreadable = Remote {
        write: write_failure("changed"),
        read: RemoteReadResult::Failure(RemoteFailure::of("unavailable")),
        ..api()
    };
    assert_eq!(
        save_remote_text(&unreadable, PATH, "mine", Some("1-1"), false).await,
        failed("unavailable")
    );
}

#[tokio::test]
async fn ssh_c68_reads_the_file_only_when_its_version_moved() {
    let same = Remote {
        stat: stat_of("file", Some("1-1")),
        ..api()
    };
    assert_eq!(
        check_remote_text(&same, PATH, Some("1-1")).await,
        RemoteCheckOutcome::Same
    );
    assert!(!same.called("read"));

    let moved = Remote {
        stat: stat_of("file", Some("5-6")),
        read: content("theirs", "5-6"),
        ..api()
    };
    assert_eq!(
        check_remote_text(&moved, PATH, Some("1-1")).await,
        RemoteCheckOutcome::Changed {
            disk: "theirs".to_owned(),
            version: "5-6".to_owned(),
        }
    );
}

#[tokio::test]
async fn says_deleted_once_for_a_file_that_was_there_and_nothing_for_one_that_never_was() {
    assert_eq!(
        check_remote_text(&api(), PATH, Some("1-1")).await,
        RemoteCheckOutcome::Deleted
    );
    assert_eq!(
        check_remote_text(&api(), PATH, None).await,
        RemoteCheckOutcome::Same
    );
}

#[tokio::test]
async fn changes_nothing_when_the_host_cannot_be_asked_or_the_file_has_no_version() {
    let down = Remote {
        stat: RemoteStatResult::Failure(RemoteFailure::of("unavailable")),
        ..api()
    };
    assert_eq!(
        check_remote_text(&down, PATH, Some("1-1")).await,
        RemoteCheckOutcome::Unknown
    );
    let big = Remote {
        stat: stat_of("file", None),
        ..api()
    };
    assert_eq!(
        check_remote_text(&big, PATH, Some("1-1")).await,
        RemoteCheckOutcome::Unknown
    );
    let folder = Remote {
        stat: stat_of("dir", None),
        ..api()
    };
    assert_eq!(
        check_remote_text(&folder, PATH, Some("1-1")).await,
        RemoteCheckOutcome::Unknown
    );
    let raced = Remote {
        stat: stat_of("file", Some("5-6")),
        read: content("mine", "1-1"),
        ..api()
    };
    assert_eq!(
        check_remote_text(&raced, PATH, Some("1-1")).await,
        RemoteCheckOutcome::Same
    );
}

#[tokio::test]
async fn a_folder_with_a_version_is_still_unknown() {
    let folder = Remote {
        stat: stat_of("dir", Some("5-6")),
        ..api()
    };
    assert_eq!(
        check_remote_text(&folder, PATH, Some("1-1")).await,
        RemoteCheckOutcome::Unknown
    );
    assert!(!folder.called("read"));
}

#[tokio::test]
async fn a_file_that_goes_away_between_the_stat_and_the_read_is_deleted_or_same() {
    let gone = Remote {
        stat: stat_of("file", Some("5-6")),
        ..api()
    };
    assert_eq!(
        check_remote_text(&gone, PATH, Some("1-1")).await,
        RemoteCheckOutcome::Deleted
    );
    assert_eq!(
        check_remote_text(&gone, PATH, None).await,
        RemoteCheckOutcome::Same
    );
}

#[tokio::test]
async fn a_read_that_fails_for_another_reason_is_unknown() {
    let down = Remote {
        stat: stat_of("file", Some("5-6")),
        read: RemoteReadResult::Failure(RemoteFailure::of("unavailable")),
        ..api()
    };
    assert_eq!(
        check_remote_text(&down, PATH, Some("1-1")).await,
        RemoteCheckOutcome::Unknown
    );
}

#[tokio::test]
async fn a_stat_failure_that_is_not_not_found_is_unknown_also_for_a_new_file() {
    let denied = Remote {
        stat: RemoteStatResult::Failure(RemoteFailure::of("denied")),
        ..api()
    };
    assert_eq!(
        check_remote_text(&denied, PATH, None).await,
        RemoteCheckOutcome::Unknown
    );
}

#[tokio::test]
async fn a_file_with_no_known_version_that_exists_reads_as_changed() {
    let remote = Remote {
        stat: stat_of("file", Some("5-6")),
        read: content("theirs", "5-6"),
        ..api()
    };
    assert_eq!(
        check_remote_text(&remote, PATH, None).await,
        RemoteCheckOutcome::Changed {
            disk: "theirs".to_owned(),
            version: "5-6".to_owned(),
        }
    );
}
