#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::dict;
use ostia_contract::files_api::ArchiveEntryProblem;
use ostia_model::files::archive_problems::archive_problem_text;
use serde_json::json;

fn marked() -> serde_json::Value {
    json!({"editor": {
        "archiveEncrypted": "enc",
        "archiveLink": "lnk",
        "archiveUnzipLimit": "lim",
        "archiveGone": "gone",
    }})
}

#[test]
fn names_each_problem_with_its_own_line() {
    let d = marked();
    let rows = [
        (ArchiveEntryProblem::Encrypted, "enc"),
        (ArchiveEntryProblem::Link, "lnk"),
        (ArchiveEntryProblem::UnzipLimit, "lim"),
        (ArchiveEntryProblem::Gone, "gone"),
    ];
    for (reason, want) in rows {
        assert_eq!(
            archive_problem_text(&d, reason).as_deref(),
            Some(want),
            "{reason:?}"
        );
    }
}

#[test]
fn reads_the_english_catalog_lines() {
    let d = dict::en();
    assert_eq!(
        archive_problem_text(d, ArchiveEntryProblem::Encrypted).as_deref(),
        Some("This entry is encrypted, so it cannot be shown.")
    );
    assert_eq!(
        archive_problem_text(d, ArchiveEntryProblem::Gone).as_deref(),
        Some("This entry is no longer in the archive.")
    );
}

#[test]
fn gives_no_text_when_the_catalog_has_no_such_line() {
    let d = json!({"editor": {"archiveGone": "gone"}});
    assert_eq!(archive_problem_text(&d, ArchiveEntryProblem::Link), None);
    assert_eq!(
        archive_problem_text(&json!({}), ArchiveEntryProblem::Gone),
        None
    );
}
