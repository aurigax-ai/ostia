use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;
use serde_json::Value;

use crate::pty_api::PromptSeparator;

pub const MAX_PROMPT_CHIPS: usize = 32;

static EXTENSION_CHIP_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{0,39}$"));

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

pub const CORE_CHIP_IDS: [&str; 12] = [
    "conda",
    "virtualenv",
    "node",
    "cwd",
    "user",
    "host",
    "kube",
    "date",
    "time12",
    "time24",
    "exitCode",
    "duration",
];

impl PromptStyle {
    fn from_text(text: &str) -> Option<Self> {
        match text {
            "shell" => Some(Self::Shell),
            "ostia" => Some(Self::Ostia),
            _ => None,
        }
    }
}

fn separator_from_text(text: &str) -> Option<PromptSeparator> {
    match text {
        "none" => Some(PromptSeparator::None),
        "%" => Some(PromptSeparator::Percent),
        "$" => Some(PromptSeparator::Dollar),
        ">" => Some(PromptSeparator::Greater),
        _ => None,
    }
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

pub fn is_prompt_chip_id(id: &Value) -> bool {
    id.as_str()
        .is_some_and(|id| CoreChipId::from_id(id).is_some() || EXTENSION_CHIP_ID.is_match(id))
}

pub fn parse_prompt_chips(raw: &Value) -> Vec<String> {
    let Some(items) = raw.as_array() else {
        return PromptSettings::default().chips;
    };
    let mut chips: Vec<String> = Vec::new();
    for item in items {
        if chips.len() >= MAX_PROMPT_CHIPS {
            break;
        }
        if let Some(id) = item.as_str().filter(|_| is_prompt_chip_id(item))
            && !chips.iter().any(|chip| chip == id)
        {
            chips.push(id.to_owned());
        }
    }
    chips
}

pub fn parse_prompt_settings(raw: &Value) -> PromptSettings {
    let defaults = PromptSettings::default();
    let Some(raw) = raw.as_object() else {
        return defaults;
    };
    PromptSettings {
        style: raw
            .get("style")
            .and_then(Value::as_str)
            .and_then(PromptStyle::from_text)
            .unwrap_or(defaults.style),
        chips: parse_prompt_chips(raw.get("chips").unwrap_or(&Value::Null)),
        same_line: raw
            .get("sameLine")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        separator: raw
            .get("separator")
            .and_then(Value::as_str)
            .and_then(separator_from_text)
            .unwrap_or(defaults.separator),
    }
}
