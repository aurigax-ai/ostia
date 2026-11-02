use ostia_contract::attention::{NotificationEntry, NotificationKind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationTab {
    All,
    Needs,
    Done,
    Messages,
}

pub const NOTIFICATION_TABS: [NotificationTab; 4] = [
    NotificationTab::All,
    NotificationTab::Needs,
    NotificationTab::Done,
    NotificationTab::Messages,
];

pub fn in_tab(entry: &NotificationEntry, tab: NotificationTab) -> bool {
    match tab {
        NotificationTab::All => true,
        NotificationTab::Needs => matches!(
            entry.kind,
            NotificationKind::Waiting | NotificationKind::Approval | NotificationKind::Error
        ),
        NotificationTab::Done => entry.kind == NotificationKind::Done,
        NotificationTab::Messages => entry.kind == NotificationKind::Message,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotificationGroup {
    pub key: String,
    pub label: String,
    pub entries: Vec<NotificationEntry>,
}

pub fn group_notifications(
    entries: &[NotificationEntry],
    group_of: impl Fn(&NotificationEntry) -> (String, String),
) -> Vec<NotificationGroup> {
    let mut groups: Vec<NotificationGroup> = Vec::new();
    for entry in entries {
        let (key, label) = group_of(entry);
        match groups.iter_mut().find(|group| group.key == key) {
            Some(group) => group.entries.push(entry.clone()),
            None => groups.push(NotificationGroup {
                key,
                label,
                entries: vec![entry.clone()],
            }),
        }
    }
    groups
}
