use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex, utf16_len};
use regex::Regex;
use serde_json::{Map, Value};

use crate::chord_spec::ChordSpec;

const MAX_LABEL: usize = 120;
const MAX_ITEMS: usize = 40;

static COMMAND_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$"));
static ACCELERATOR: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9_+=,.\-\[\]\\;'`/]{1,48}$"));
static LETTER_KEY: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z]$"));
static FUNCTION_KEY: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^f([1-9]|1[0-9]|2[0-4])$"));
static PLAIN_KEY: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9=,.\-\[\]\\;'`/]$"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppMenuEntry {
    Command {
        command: String,
        label: String,
        accelerator: Option<String>,
    },
    Separator,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppMenuSection {
    pub label: String,
    pub items: Vec<AppMenuEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppMenuSpec {
    pub file: AppMenuSection,
    pub view: AppMenuSection,
    pub go: AppMenuSection,
    pub help: AppMenuSection,
}

fn label_text(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (!js_trim(text).is_empty() && utf16_len(text) <= MAX_LABEL).then(|| text.to_owned())
}

fn entry_of(raw: &Value) -> Option<AppMenuEntry> {
    let item = raw.as_object()?;
    if item.get("separator") == Some(&Value::Bool(true)) {
        return Some(AppMenuEntry::Separator);
    }
    let label = label_text(item.get("label"))?;
    let command = item
        .get("command")?
        .as_str()
        .filter(|id| COMMAND_ID.is_match(id))?;
    let accelerator = item
        .get("accelerator")
        .and_then(Value::as_str)
        .filter(|key| ACCELERATOR.is_match(key))
        .map(str::to_owned);
    Some(AppMenuEntry::Command {
        command: command.to_owned(),
        label,
        accelerator,
    })
}

fn section(source: &Map<String, Value>, name: &str) -> Option<AppMenuSection> {
    let value = source.get(name)?.as_object()?;
    let label = label_text(value.get("label"))?;
    let raw_items = value.get("items")?.as_array()?;
    if raw_items.len() > MAX_ITEMS {
        return None;
    }
    let items = raw_items.iter().map(entry_of).collect::<Option<Vec<_>>>()?;
    Some(AppMenuSection { label, items })
}

pub fn parse_app_menu_spec(raw: &Value) -> Option<AppMenuSpec> {
    let source = raw.as_object()?;
    Some(AppMenuSpec {
        file: section(source, "file")?,
        view: section(source, "view")?,
        go: section(source, "go")?,
        help: section(source, "help")?,
    })
}

fn named_key(key: &str) -> Option<&'static str> {
    Some(match key {
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        "space" => "Space",
        "enter" => "Return",
        "tab" => "Tab",
        "escape" => "Esc",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "insert" => "Insert",
        "+" => "Plus",
        _ => return None,
    })
}

fn electron_key(key: &str) -> Option<String> {
    if let Some(name) = named_key(key) {
        return Some(name.to_owned());
    }
    if LETTER_KEY.is_match(key) || FUNCTION_KEY.is_match(key) {
        return Some(key.to_uppercase());
    }
    PLAIN_KEY.is_match(key).then(|| key.to_owned())
}

pub fn electron_accelerator(spec: &ChordSpec) -> Option<String> {
    let key = electron_key(&spec.key)?;
    let mut parts: Vec<&str> = Vec::new();
    if spec.ctrl {
        parts.push("Ctrl");
    }
    if spec.alt {
        parts.push("Alt");
    }
    if spec.shift {
        parts.push("Shift");
    }
    if spec.meta {
        parts.push("Cmd");
    }
    parts.push(&key);
    Some(parts.join("+"))
}
