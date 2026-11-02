use ostia_base::js::{js_trim, utf16_len};
use ostia_contract::hidden_text::has_control_character;
use serde::Serialize;
use serde_json::Value;

use crate::js_text::utf16_prefix;

const GROUP_NAME_MAX: usize = 60;
const DESCRIPTION_MAX: usize = 500;
const SPLIT_TAB_NAME_MAX: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceGroupColor {
    Red,
    Orange,
    Yellow,
    Green,
    Teal,
    Blue,
    Purple,
    Pink,
}

impl WorkspaceGroupColor {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "red" => Some(Self::Red),
            "orange" => Some(Self::Orange),
            "yellow" => Some(Self::Yellow),
            "green" => Some(Self::Green),
            "teal" => Some(Self::Teal),
            "blue" => Some(Self::Blue),
            "purple" => Some(Self::Purple),
            "pink" => Some(Self::Pink),
            _ => None,
        }
    }
}

pub fn normalize_group_name(raw: Option<&Value>) -> Option<String> {
    let name = js_trim(utf16_prefix(js_trim(raw?.as_str()?), GROUP_NAME_MAX));
    (!name.is_empty()).then(|| name.to_owned())
}

pub fn normalize_description(raw: Option<&Value>) -> Option<String> {
    let text = js_trim(raw?.as_str()?);
    if text.is_empty() {
        return None;
    }
    if utf16_len(text) > DESCRIPTION_MAX {
        return Some(format!("{}…", utf16_prefix(text, DESCRIPTION_MAX - 1)));
    }
    Some(text.to_owned())
}

pub fn normalize_split_tab_name(raw: Option<&Value>) -> Option<String> {
    let name = js_trim(raw?.as_str()?);
    (!name.is_empty() && utf16_len(name) <= SPLIT_TAB_NAME_MAX && !has_control_character(name))
        .then(|| name.to_owned())
}
