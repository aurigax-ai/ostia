use ostia_contract::capabilities::Capability;

pub const ALWAYS_ASK: [Capability; 2] = [Capability::Destructive, Capability::Credentials];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalAnswer {
    Once,
    Session,
    Always,
    Workspace,
    Deny,
}

impl ApprovalAnswer {
    pub fn id(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Session => "session",
            Self::Always => "always",
            Self::Workspace => "workspace",
            Self::Deny => "deny",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "once" => Some(Self::Once),
            "session" => Some(Self::Session),
            "always" => Some(Self::Always),
            "workspace" => Some(Self::Workspace),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ApprovalKind {
    #[default]
    Capability,
    SandboxDomain,
    SandboxPort,
    Secret,
    Package,
    PackageMalware,
    AccountSwitch,
    ReachGroup,
    ReachProject,
}

fn answers_for(kind: ApprovalKind) -> &'static [ApprovalAnswer] {
    use ApprovalAnswer::{Always, Deny, Once, Session, Workspace};
    match kind {
        ApprovalKind::Capability => &[Once, Session, Always, Deny],
        ApprovalKind::Secret => &[Once, Session, Deny],
        ApprovalKind::Package => &[Once, Workspace, Deny],
        ApprovalKind::PackageMalware | ApprovalKind::AccountSwitch => &[Once, Deny],
        ApprovalKind::ReachGroup | ApprovalKind::ReachProject => &[Workspace, Deny],
        ApprovalKind::SandboxDomain | ApprovalKind::SandboxPort => &[Workspace, Session, Deny],
    }
}

pub fn asks_always(caps: &[Capability]) -> bool {
    caps.iter().any(|cap| ALWAYS_ASK.contains(cap))
}

pub fn offered_answers(kind: ApprovalKind, caps: &[Capability]) -> Vec<ApprovalAnswer> {
    let always_asks = asks_always(caps);
    answers_for(kind)
        .iter()
        .copied()
        .filter(|answer| {
            !(always_asks && matches!(answer, ApprovalAnswer::Session | ApprovalAnswer::Always))
        })
        .collect()
}
