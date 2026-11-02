#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceFailure {
    Cancelled,
    Failed,
    Timeout,
    Unavailable,
}

impl PresenceFailure {
    pub fn name(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
            Self::Timeout => "timeout",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceVia {
    TouchId,
    Polkit,
    Confirm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceHint {
    PolkitAgent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PresenceResult {
    Granted {
        via: PresenceVia,
    },
    Refused {
        code: PresenceFailure,
        detail: String,
        hint: Option<PresenceHint>,
    },
}
