use crate::pty_api::PromptSeparator;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptStyle {
    Shell,
    Ostia,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoreChipId {
    Conda,
    Virtualenv,
    Node,
    Cwd,
    User,
    Host,
    Kube,
    Date,
    Time12,
    Time24,
    ExitCode,
    Duration,
}

impl CoreChipId {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "conda" => Some(Self::Conda),
            "virtualenv" => Some(Self::Virtualenv),
            "node" => Some(Self::Node),
            "cwd" => Some(Self::Cwd),
            "user" => Some(Self::User),
            "host" => Some(Self::Host),
            "kube" => Some(Self::Kube),
            "date" => Some(Self::Date),
            "time12" => Some(Self::Time12),
            "time24" => Some(Self::Time24),
            "exitCode" => Some(Self::ExitCode),
            "duration" => Some(Self::Duration),
            _ => None,
        }
    }
}

pub const DEFAULT_PROMPT_CHIPS: [&str; 6] = [
    "conda",
    "virtualenv",
    "node",
    "cwd",
    "git.branch",
    "git.diff-stats",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptSettings {
    pub style: PromptStyle,
    pub chips: Vec<String>,
    pub same_line: bool,
    pub separator: PromptSeparator,
}

impl Default for PromptSettings {
    fn default() -> Self {
        Self {
            style: PromptStyle::Shell,
            chips: DEFAULT_PROMPT_CHIPS
                .iter()
                .map(|id| (*id).to_owned())
                .collect(),
            same_line: false,
            separator: PromptSeparator::None,
        }
    }
}

pub fn separator_text(separator: PromptSeparator) -> &'static str {
    match separator {
        PromptSeparator::None => "",
        PromptSeparator::Percent => "%",
        PromptSeparator::Dollar => "$",
        PromptSeparator::Greater => ">",
    }
}
