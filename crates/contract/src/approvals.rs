use serde::Serialize;
use serde_json::Value;

use crate::capabilities::Capability;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    Ask,
    Allow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalAnswer {
    Once,
    Session,
    Always,
    Workspace,
    Deny,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalOutcome {
    Auto,
    Timeout,
    #[serde(untagged)]
    Answer(ApprovalAnswer),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalKind {
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

pub const APPROVAL_ANSWERS: [ApprovalAnswer; 5] = [
    ApprovalAnswer::Once,
    ApprovalAnswer::Session,
    ApprovalAnswer::Always,
    ApprovalAnswer::Workspace,
    ApprovalAnswer::Deny,
];

pub const APPROVAL_TIMEOUT_MS: u64 = 90_000;
pub const APPROVAL_HISTORY_MAX: usize = 100;
pub const APPROVAL_DETAIL_MAX: usize = 600;

pub const ALWAYS_ASK: [Capability; 2] = [Capability::Destructive, Capability::Credentials];

const STANDING_ANSWERS: [ApprovalAnswer; 2] = [ApprovalAnswer::Session, ApprovalAnswer::Always];

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

pub fn offered_answers(kind: Option<ApprovalKind>, caps: &[Capability]) -> Vec<ApprovalAnswer> {
    let always_asks = caps.iter().any(|cap| ALWAYS_ASK.contains(cap));
    answers_for(kind.unwrap_or(ApprovalKind::Capability))
        .iter()
        .copied()
        .filter(|answer| !(always_asks && STANDING_ANSWERS.contains(answer)))
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ApprovalKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub pane_id: String,
    pub workspace_id: String,
    pub caps: Vec<Capability>,
    pub action: String,
    pub detail: String,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    #[serde(flatten)]
    pub request: ApprovalRequest,
    pub outcome: ApprovalOutcome,
    pub answered_at: i64,
    pub revocable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ApprovalState {
    pub pending: Vec<ApprovalRequest>,
    pub history: Vec<ApprovalRecord>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ApprovalSettings {
    pub mode: ApprovalMode,
}

pub const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = ApprovalSettings {
    mode: ApprovalMode::Ask,
};

pub fn parse_approval_settings(raw: &Value) -> ApprovalSettings {
    let mode = match raw.get("mode").and_then(Value::as_str) {
        Some("ask") => ApprovalMode::Ask,
        Some("allow") => ApprovalMode::Allow,
        _ => DEFAULT_APPROVAL_SETTINGS.mode,
    };
    ApprovalSettings { mode }
}

pub fn auto_approves(mode: ApprovalMode, caps: &[Capability], kind: ApprovalKind) -> bool {
    kind == ApprovalKind::Capability
        && mode == ApprovalMode::Allow
        && !caps.iter().any(|cap| ALWAYS_ASK.contains(cap))
}
