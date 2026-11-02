use serde::{Deserialize, Serialize};

use crate::PRODUCT_DISPLAY_NAME;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    DriveSelf,
    ReadBoard,
    SendOtherPane,
    TypeOtherPane,
    ReadOtherPane,
    KillPane,
    AllWorkspaces,
    Shell,
    Destructive,
    Phone,
    Gateway,
    Notify,
    Process,
    VaultRead,
    VaultWrite,
    Browse,
    SettingsRead,
    SettingsWrite,
    Assist,
    Credentials,
    LanguageServer,
    AgentPlugin,
    AgentComplete,
    Mcp,
    ReadBus,
    FileContents,
    PhoneScreens,
}

pub const DEFAULT_CAPABILITIES: [Capability; 7] = [
    Capability::DriveSelf,
    Capability::ReadBoard,
    Capability::Notify,
    Capability::SettingsRead,
    Capability::Process,
    Capability::VaultRead,
    Capability::VaultWrite,
];

impl Capability {
    pub fn name(self) -> &'static str {
        match self {
            Self::DriveSelf => "drive-self",
            Self::ReadBoard => "read-board",
            Self::SendOtherPane => "send-other-pane",
            Self::TypeOtherPane => "type-other-pane",
            Self::ReadOtherPane => "read-other-pane",
            Self::KillPane => "kill-pane",
            Self::AllWorkspaces => "all-workspaces",
            Self::Shell => "shell",
            Self::Destructive => "destructive",
            Self::Phone => "phone",
            Self::Gateway => "gateway",
            Self::Notify => "notify",
            Self::Process => "process",
            Self::VaultRead => "vault-read",
            Self::VaultWrite => "vault-write",
            Self::Browse => "browse",
            Self::SettingsRead => "settings-read",
            Self::SettingsWrite => "settings-write",
            Self::Assist => "assist",
            Self::Credentials => "credentials",
            Self::LanguageServer => "language-server",
            Self::AgentPlugin => "agent-plugin",
            Self::AgentComplete => "agent-complete",
            Self::Mcp => "mcp",
            Self::ReadBus => "read-bus",
            Self::FileContents => "file-contents",
            Self::PhoneScreens => "phone-screens",
        }
    }

    pub fn allows(self) -> &'static str {
        match self {
            Self::DriveSelf => "control your own pane",
            Self::ReadBoard => "read the workspace and pane state",
            Self::SendOtherPane => "send messages to other panes",
            Self::TypeOtherPane => "type into other terminal panes",
            Self::ReadOtherPane => "read the screen of other terminal panes",
            Self::KillPane => "close panes",
            Self::AllWorkspaces => "act on other panes and workspaces",
            Self::Shell => "type commands into terminals",
            Self::Destructive => "take destructive actions",
            Self::Phone => "manage the phone companion",
            Self::Gateway => "control the LAN gateway",
            Self::Notify => "send notifications",
            Self::Process => "run and manage background processes",
            Self::VaultRead => "read the vault",
            Self::VaultWrite => "write the vault",
            Self::Browse => "drive the in-app browser",
            Self::SettingsRead => "read settings",
            Self::SettingsWrite => "change settings",
            Self::Assist => "use the assistant",
            Self::Credentials => "use your saved passwords and your signed-in browser",
            Self::LanguageServer => "run language servers",
            Self::AgentPlugin => "manage agent plugins",
            Self::AgentComplete => {
                "send redacted text to the Agent model you set up and read its answer"
            }
            Self::Mcp => "call the MCP servers you set up",
            Self::ReadBus => "see which panes send each other bus messages, never what they say",
            Self::FileContents => {
                "read the files you expand in Files, to list and open what is inside them"
            }
            Self::PhoneScreens => {
                "see and drive a phone's screen while its human runs a session they started on the phone"
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityRefusal {
    Denied,
    NotApproved,
}

pub fn capability_refusal_hint(refusal: CapabilityRefusal, caps: &[Capability]) -> String {
    let needed = caps
        .iter()
        .map(|cap| format!("{} lets you {}", cap.name(), cap.allows()))
        .collect::<Vec<_>>()
        .join("; ");
    let outcome = match refusal {
        CapabilityRefusal::Denied => "The human denied it",
        CapabilityRefusal::NotApproved => "Nobody answered in time",
    };
    format!(
        "{outcome}. {needed}; only the human grants it, in {PRODUCT_DISPLAY_NAME} or Settings. Ask them or work another way; do not retry."
    )
}
