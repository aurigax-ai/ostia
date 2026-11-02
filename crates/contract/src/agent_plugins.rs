#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookAgent {
    Claude,
    Codex,
}

impl HookAgent {
    pub const ALL: [Self; 2] = [Self::Claude, Self::Codex];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentHookEvent {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    Stop,
    SessionEnd,
    Notification,
}

impl AgentHookEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionStart => "SessionStart",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
            Self::Stop => "Stop",
            Self::SessionEnd => "SessionEnd",
            Self::Notification => "Notification",
        }
    }
}

pub fn hook_agents_for(event: AgentHookEvent) -> &'static [HookAgent] {
    match event {
        AgentHookEvent::Notification => &[HookAgent::Claude],
        _ => &HookAgent::ALL,
    }
}
