pub const PARK_NOTICE_MS: u64 = 15_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParkNoticeKind {
    Parked {
        workspace_id: String,
        title: String,
    },
    ResumeFailed {
        workspace_id: String,
        pane_id: String,
        title: String,
        reason: String,
    },
    Refused {
        workspace_id: String,
        pane_id: String,
        title: String,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParkNotice {
    kind: ParkNoticeKind,
    seq: u64,
}

impl ParkNotice {
    pub fn kind(&self) -> &ParkNoticeKind {
        &self.kind
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }
}

#[derive(Clone, Debug, Default)]
pub struct ParkStore {
    notice: Option<ParkNotice>,
    seq: u64,
}

impl ParkStore {
    pub fn notice(&self) -> Option<&ParkNotice> {
        self.notice.as_ref()
    }

    pub fn show_notice(&mut self, kind: ParkNoticeKind) -> bool {
        self.seq += 1;
        self.notice = Some(ParkNotice {
            kind,
            seq: self.seq,
        });
        true
    }

    pub fn dismiss_notice(&mut self) -> bool {
        self.notice = None;
        true
    }

    pub fn expire(&mut self, seq: u64) -> bool {
        if self.notice.as_ref().is_some_and(|n| n.seq == seq) {
            self.notice = None;
            return true;
        }
        false
    }
}
