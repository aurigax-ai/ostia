use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionIcon {
    Puzzle,
    Kanban,
    BookOpen,
    GitBranch,
    Globe,
    Bell,
    Server,
    Terminal,
    Circle,
    Check,
    Alert,
    Shield,
    Chat,
    Plugs,
    MagnifyingGlass,
    Graph,
    Toolbox,
    Plus,
    Refresh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidebarKind {
    Location,
    Live,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidebarTone {
    Neutral,
    Brand,
    Ok,
    Warn,
    Error,
}

pub const PANE_CHIP_ITEMS_MAX: usize = 64;
