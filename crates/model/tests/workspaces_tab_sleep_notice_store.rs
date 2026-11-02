#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::workspaces::tab_sleep_notice_store::{TabSleepNotice, TabSleepNoticeStore};

#[test]
fn starts_with_no_notice() {
    assert_eq!(TabSleepNoticeStore::default().notice(), None);
}

#[test]
fn show_keeps_each_kind_of_notice() {
    let notices = [
        TabSleepNotice::NotAgent,
        TabSleepNotice::Asleep,
        TabSleepNotice::Awake,
        TabSleepNotice::Conflict {
            tab: "Claude".to_owned(),
        },
        TabSleepNotice::ForkFolderMissing {
            agent: "claude".to_owned(),
            path: "/gone".to_owned(),
        },
    ];
    for notice in notices {
        let mut store = TabSleepNoticeStore::default();
        assert!(store.show(notice.clone()), "notice {notice:?}");
        assert_eq!(store.notice(), Some(&notice));
    }
}

#[test]
fn show_replaces_the_notice_that_is_open() {
    let mut store = TabSleepNoticeStore::default();
    store.show(TabSleepNotice::Asleep);
    store.show(TabSleepNotice::Awake);
    assert_eq!(store.notice(), Some(&TabSleepNotice::Awake));
}

#[test]
fn dismiss_closes_the_notice_and_leaves_a_closed_store_closed() {
    let mut store = TabSleepNoticeStore::default();
    store.show(TabSleepNotice::NotAgent);
    store.dismiss();
    assert_eq!(store.notice(), None);
    store.dismiss();
    assert_eq!(store.notice(), None);
}
