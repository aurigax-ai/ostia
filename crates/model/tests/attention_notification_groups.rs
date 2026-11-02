#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_contract::attention::{NotificationEntry, NotificationKind};
use ostia_model::attention::notification_groups::{
    NOTIFICATION_TABS, NotificationTab, group_notifications, in_tab,
};

fn entry(id: &str, kind: NotificationKind, pane_id: Option<&str>) -> NotificationEntry {
    NotificationEntry {
        id: id.to_owned(),
        ts: "2026-09-30T10:00:00Z".to_owned(),
        kind,
        title: id.to_owned(),
        body: None,
        from: "x".to_owned(),
        pane_id: pane_id.map(str::to_owned),
        ext_id: None,
        panel_path: None,
    }
}

#[test]
fn puts_waiting_approvals_and_errors_under_needs_you() {
    use NotificationKind::{Approval, Done, Error, Message, Waiting};
    assert!(in_tab(&entry("a", Waiting, None), NotificationTab::Needs));
    assert!(in_tab(&entry("b", Approval, None), NotificationTab::Needs));
    assert!(in_tab(&entry("c", Error, None), NotificationTab::Needs));
    assert!(!in_tab(&entry("d", Done, None), NotificationTab::Needs));
    assert!(in_tab(&entry("d", Done, None), NotificationTab::Done));
    assert!(in_tab(
        &entry("e", Message, None),
        NotificationTab::Messages
    ));
    assert!(in_tab(&entry("e", Message, None), NotificationTab::All));
}

#[test]
fn every_kind_belongs_to_all_and_to_exactly_the_tabs_that_list_it() {
    use NotificationKind::{Approval, Done, Error, Message, Waiting};
    let rows = [
        (Waiting, [true, true, false, false]),
        (Approval, [true, true, false, false]),
        (Error, [true, true, false, false]),
        (Done, [true, false, true, false]),
        (Message, [true, false, false, true]),
    ];
    for (kind, expected) in rows {
        let found = NOTIFICATION_TABS.map(|tab| in_tab(&entry("x", kind, None), tab));
        assert_eq!(found, expected, "{kind:?}");
    }
}

#[test]
fn lists_the_tabs_in_display_order() {
    assert_eq!(
        NOTIFICATION_TABS,
        [
            NotificationTab::All,
            NotificationTab::Needs,
            NotificationTab::Done,
            NotificationTab::Messages,
        ]
    );
}

#[test]
fn groups_by_workspace_in_the_order_of_each_groups_newest_entry() {
    let location: HashMap<&str, &str> = HashMap::from([("p1", "home"), ("p2", "model-runtime")]);
    let groups = group_notifications(
        &[
            entry("n3", NotificationKind::Done, Some("p2")),
            entry("n2", NotificationKind::Waiting, Some("p1")),
            entry("n1", NotificationKind::Done, Some("p2")),
        ],
        |entry| match location.get(entry.pane_id.as_deref().unwrap_or("")) {
            Some(name) => ((*name).to_owned(), (*name).to_owned()),
            None => ("closed".to_owned(), "Closed".to_owned()),
        },
    );
    let found: Vec<(&str, Vec<&str>)> = groups
        .iter()
        .map(|group| {
            (
                group.label.as_str(),
                group.entries.iter().map(|e| e.id.as_str()).collect(),
            )
        })
        .collect();
    assert_eq!(
        found,
        vec![("model-runtime", vec!["n3", "n1"]), ("home", vec!["n2"])]
    );
}

#[test]
fn entries_with_no_workspace_share_one_group_under_the_label_the_caller_gives() {
    let groups = group_notifications(
        &[
            entry("n2", NotificationKind::Done, None),
            entry("n1", NotificationKind::Done, Some("gone")),
        ],
        |_| ("closed".to_owned(), "Closed".to_owned()),
    );
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].key, "closed");
    assert_eq!(groups[0].label, "Closed");
    assert_eq!(groups[0].entries.len(), 2);
}

#[test]
fn no_entries_make_no_groups() {
    let groups = group_notifications(&[], |_| ("k".to_owned(), "K".to_owned()));
    assert!(groups.is_empty());
}
