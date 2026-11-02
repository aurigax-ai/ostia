#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TabSleepNotice {
    NotAgent,
    Asleep,
    Awake,
    Conflict { tab: String },
    ForkFolderMissing { agent: String, path: String },
}

#[derive(Clone, Debug, Default)]
pub struct TabSleepNoticeStore {
    notice: Option<TabSleepNotice>,
}

impl TabSleepNoticeStore {
    pub fn notice(&self) -> Option<&TabSleepNotice> {
        self.notice.as_ref()
    }

    pub fn show(&mut self, notice: TabSleepNotice) -> bool {
        self.notice = Some(notice);
        true
    }

    pub fn dismiss(&mut self) -> bool {
        self.notice = None;
        true
    }
}
