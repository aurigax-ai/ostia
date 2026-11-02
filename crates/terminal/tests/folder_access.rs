#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{Error, ErrorKind};

use ostia_terminal::folder_access::{
    FolderAccessMonitor, FolderRead, FolderReads, ProtectedFolder, folder_read_of_command,
    folder_read_of_error,
};

fn errno(code: i32) -> Error {
    Error::from_raw_os_error(code)
}

fn reads(entries: &[(ProtectedFolder, FolderRead)]) -> FolderReads {
    entries.iter().copied().collect()
}

const DOWNLOADS: ProtectedFolder = ProtectedFolder::Downloads;
const DOCUMENTS: ProtectedFolder = ProtectedFolder::Documents;

#[test]
fn counts_only_eperm_as_a_macos_privacy_deny() {
    assert_eq!(
        folder_read_of_error(&errno(libc::EPERM)),
        FolderRead::Denied
    );
    assert_eq!(
        folder_read_of_error(&errno(libc::EACCES)),
        FolderRead::Other
    );
    assert_eq!(
        folder_read_of_error(&errno(libc::ENOENT)),
        FolderRead::Other
    );
    assert_eq!(
        folder_read_of_error(&errno(libc::ENOTDIR)),
        FolderRead::Other
    );
}

#[test]
fn reads_the_message_only_when_the_error_has_no_code() {
    assert_eq!(
        folder_read_of_error(&Error::other("ls: Downloads: Operation not permitted")),
        FolderRead::Denied
    );
    assert_eq!(
        folder_read_of_error(&Error::new(
            ErrorKind::PermissionDenied,
            "Operation not permitted"
        )),
        FolderRead::Denied
    );
    assert_eq!(
        folder_read_of_error(&Error::other("Permission denied")),
        FolderRead::Other
    );
}

#[test]
fn ignores_the_message_of_an_error_that_has_a_code_other_than_eperm() {
    let error = errno(libc::EACCES);
    assert!(!error.to_string().contains("Operation not permitted"));
    assert_eq!(folder_read_of_error(&error), FolderRead::Other);
}

#[test]
fn counts_a_failed_ls_as_denied_only_when_it_says_operation_not_permitted() {
    let rows = [
        (0, "", FolderRead::Ok),
        (
            1,
            "ls: /Users/a/Downloads: Operation not permitted ",
            FolderRead::Denied,
        ),
        (
            1,
            "ls: /Users/a/Downloads: Permission denied ",
            FolderRead::Other,
        ),
        (
            1,
            "ls: /Users/a/Desktop: No such file or directory ",
            FolderRead::Other,
        ),
        (2, "", FolderRead::Other),
    ];
    for (code, stderr, expected) in rows {
        assert_eq!(
            folder_read_of_command(code, stderr),
            expected,
            "{code} {stderr}"
        );
    }
}

#[test]
fn counts_a_zero_exit_as_ok_also_when_stderr_has_text() {
    assert_eq!(
        folder_read_of_command(0, "Operation not permitted"),
        FolderRead::Ok
    );
}

#[test]
fn does_not_report_a_folder_that_was_never_readable_in_this_launch() {
    let mut monitor = FolderAccessMonitor::default();
    assert_eq!(
        monitor.observe(&[reads(&[(DOWNLOADS, FolderRead::Denied)])]),
        None
    );
    assert_eq!(
        monitor.observe(&[
            reads(&[(DOWNLOADS, FolderRead::Denied)]),
            reads(&[(DOWNLOADS, FolderRead::Denied)]),
        ]),
        None
    );
}

#[test]
fn reports_a_folder_that_was_readable_earlier_and_is_denied_now() {
    let mut monitor = FolderAccessMonitor::default();
    assert_eq!(
        monitor.observe(&[reads(&[
            (DOWNLOADS, FolderRead::Ok),
            (DOCUMENTS, FolderRead::Ok)
        ])]),
        None
    );
    assert_eq!(
        monitor.observe(&[reads(&[
            (DOWNLOADS, FolderRead::Denied),
            (DOCUMENTS, FolderRead::Ok)
        ])]),
        Some(vec![DOWNLOADS])
    );
}

#[test]
fn reports_a_folder_the_kept_shells_cannot_read_while_ostia_itself_can() {
    let mut monitor = FolderAccessMonitor::default();
    assert_eq!(
        monitor.observe(&[
            reads(&[(DOWNLOADS, FolderRead::Ok), (DOCUMENTS, FolderRead::Ok)]),
            reads(&[(DOWNLOADS, FolderRead::Denied), (DOCUMENTS, FolderRead::Ok)]),
        ]),
        Some(vec![DOWNLOADS])
    );
}

#[test]
fn does_not_report_permission_denied_or_a_missing_folder() {
    let mut monitor = FolderAccessMonitor::default();
    monitor.observe(&[reads(&[
        (DOWNLOADS, FolderRead::Ok),
        (DOCUMENTS, FolderRead::Ok),
    ])]);
    assert_eq!(
        monitor.observe(&[reads(&[
            (DOWNLOADS, FolderRead::Other),
            (DOCUMENTS, FolderRead::Other)
        ])]),
        None
    );
}

#[test]
fn reports_the_same_set_of_folders_once_per_launch_and_a_new_set_again() {
    let mut monitor = FolderAccessMonitor::default();
    monitor.observe(&[reads(&[
        (DOWNLOADS, FolderRead::Ok),
        (DOCUMENTS, FolderRead::Ok),
    ])]);
    assert_eq!(
        monitor.observe(&[reads(&[(DOWNLOADS, FolderRead::Denied)])]),
        Some(vec![DOWNLOADS])
    );
    assert_eq!(
        monitor.observe(&[reads(&[(DOWNLOADS, FolderRead::Denied)])]),
        None
    );
    assert_eq!(
        monitor.observe(&[reads(&[
            (DOWNLOADS, FolderRead::Denied),
            (DOCUMENTS, FolderRead::Denied)
        ])]),
        Some(vec![DOWNLOADS, DOCUMENTS])
    );
    assert_eq!(
        monitor.observe(&[reads(&[(DOWNLOADS, FolderRead::Denied)])]),
        None
    );
}

#[test]
fn lists_blocked_folders_in_the_protected_order_whatever_the_order_of_the_reads() {
    let mut monitor = FolderAccessMonitor::default();
    monitor.observe(&[reads(&[
        (DOCUMENTS, FolderRead::Ok),
        (DOWNLOADS, FolderRead::Ok),
    ])]);
    assert_eq!(
        monitor.observe(&[reads(&[
            (DOCUMENTS, FolderRead::Denied),
            (DOWNLOADS, FolderRead::Denied)
        ])]),
        Some(vec![DOWNLOADS, DOCUMENTS])
    );
}

#[test]
fn remembers_a_readable_folder_across_calls_and_ignores_an_empty_round_list() {
    let mut monitor = FolderAccessMonitor::default();
    assert_eq!(monitor.observe(&[]), None);
    monitor.observe(&[reads(&[(DOCUMENTS, FolderRead::Ok)])]);
    assert_eq!(monitor.observe(&[reads(&[])]), None);
    assert_eq!(
        monitor.observe(&[reads(&[(DOCUMENTS, FolderRead::Denied)])]),
        Some(vec![DOCUMENTS])
    );
}
