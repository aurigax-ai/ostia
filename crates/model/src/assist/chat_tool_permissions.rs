use std::collections::HashSet;

use ostia_contract::chat_tools::{READ_OUTSIDE_GRANT, is_standing_chat_grant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatMode {
    Ask,
    Write,
}

pub const CHAT_MODES: [ChatMode; 2] = [ChatMode::Ask, ChatMode::Write];

pub const DEFAULT_CHAT_MODE: ChatMode = ChatMode::Ask;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneRole {
    Agent,
    Manager,
}

pub fn initial_mode(role: PaneRole) -> ChatMode {
    match role {
        PaneRole::Manager => ChatMode::Write,
        PaneRole::Agent => DEFAULT_CHAT_MODE,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalKind {
    ReadOutside,
    Act,
    Write,
    Command,
    Mcp,
    Ostia,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolAccess {
    Read,
    Act,
    Write,
    Command,
    Mcp,
    Ostia,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteAskReason {
    AskMode,
    Outside,
    Symlink,
    Repository,
    Unsaved,
}

#[derive(Clone, Debug)]
pub struct ToolCheck {
    pub name: String,
    pub access: ToolAccess,
    pub mode: ChatMode,
    pub grants: HashSet<String>,
    pub standing: HashSet<String>,
    pub always_ask: HashSet<String>,
    pub outside: bool,
    pub symlink: bool,
    pub repository: bool,
    pub unsaved: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolDecision {
    Run,
    Ask {
        kind: ApprovalKind,
        grant_key: Option<String>,
        reason: Option<WriteAskReason>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalScope {
    Once,
    Chat,
    Always,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandChoice {
    Insert,
    Run,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalAnswer {
    Denied,
    Approved {
        scope: ApprovalScope,
        choice: Option<CommandChoice>,
    },
}

fn write_ask_reason(check: &ToolCheck) -> Option<WriteAskReason> {
    if check.outside {
        return Some(WriteAskReason::Outside);
    }
    if check.symlink {
        return Some(WriteAskReason::Symlink);
    }
    if check.repository {
        return Some(WriteAskReason::Repository);
    }
    if check.unsaved {
        return Some(WriteAskReason::Unsaved);
    }
    (check.mode != ChatMode::Write).then_some(WriteAskReason::AskMode)
}

fn ask(kind: ApprovalKind, grant_key: Option<&str>) -> ToolDecision {
    ToolDecision::Ask {
        kind,
        grant_key: grant_key.map(str::to_owned),
        reason: None,
    }
}

pub fn decide_tool(check: &ToolCheck) -> ToolDecision {
    let name = check.name.as_str();
    let granted = |key: &str| check.grants.contains(key) || check.standing.contains(key);
    match check.access {
        ToolAccess::Read => {
            if !check.outside || granted(READ_OUTSIDE_GRANT) {
                ToolDecision::Run
            } else {
                ask(ApprovalKind::ReadOutside, Some(READ_OUTSIDE_GRANT))
            }
        }
        ToolAccess::Act => {
            if granted(name) {
                ToolDecision::Run
            } else {
                ask(ApprovalKind::Act, Some(name))
            }
        }
        ToolAccess::Mcp => {
            if granted(name) {
                ToolDecision::Run
            } else {
                ask(ApprovalKind::Mcp, Some(name))
            }
        }
        ToolAccess::Ostia => {
            if check.mode == ChatMode::Write && !check.always_ask.contains(name) {
                ToolDecision::Run
            } else {
                ask(ApprovalKind::Ostia, None)
            }
        }
        ToolAccess::Command => ask(ApprovalKind::Command, None),
        ToolAccess::Write => match write_ask_reason(check) {
            Some(reason) => ToolDecision::Ask {
                kind: ApprovalKind::Write,
                grant_key: None,
                reason: Some(reason),
            },
            None => ToolDecision::Run,
        },
    }
}

pub fn reads_outside_unasked(grants: &HashSet<String>, standing: &HashSet<String>) -> bool {
    let check = ToolCheck {
        name: String::new(),
        access: ToolAccess::Read,
        mode: DEFAULT_CHAT_MODE,
        grants: grants.clone(),
        standing: standing.clone(),
        always_ask: HashSet::new(),
        outside: true,
        symlink: false,
        repository: false,
        unsaved: false,
    };
    decide_tool(&check) == ToolDecision::Run
}

pub fn always_grant_after(decision: &ToolDecision, answer: &ApprovalAnswer) -> Option<String> {
    let ToolDecision::Ask {
        grant_key: Some(key),
        ..
    } = decision
    else {
        return None;
    };
    let ApprovalAnswer::Approved {
        scope: ApprovalScope::Always,
        ..
    } = answer
    else {
        return None;
    };
    is_standing_chat_grant(key).then(|| key.clone())
}

pub fn grants_after(
    grants: &HashSet<String>,
    decision: &ToolDecision,
    answer: &ApprovalAnswer,
) -> HashSet<String> {
    let mut next = grants.clone();
    if let (
        ToolDecision::Ask {
            grant_key: Some(key),
            ..
        },
        ApprovalAnswer::Approved {
            scope: ApprovalScope::Chat,
            ..
        },
    ) = (decision, answer)
        && !key.is_empty()
    {
        next.insert(key.clone());
    }
    next
}
