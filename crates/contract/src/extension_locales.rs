use std::collections::HashMap;
use std::sync::LazyLock;

use ostia_base::js::{static_regex, utf16_len};
use regex::{Captures, Regex};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::dict::placeholder_text;
use crate::proto_guard::is_dangerous_segment;

pub const EXTENSION_LOCALES_DIR: &str = "locales";
pub const EXTENSION_LOCALES_MAX: usize = 32;
pub const EXTENSION_LOCALE_FILE_MAX_BYTES: usize = 256 * 1024;
pub const EXTENSION_MESSAGES_MAX: usize = 2000;
pub const EXTENSION_MESSAGE_MAX: usize = 4000;
pub const EXTENSION_MESSAGE_KEY_MAX: usize = 120;
pub const EXTENSION_BASE_LOCALE: &str = "en";
pub const LOCALE_CHANGED_EVENT: &str = "locale.changed";

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\{([A-Za-z0-9_]+)\}"));

pub type LocaleStrings = HashMap<String, String>;
pub type MessageVars = Map<String, Value>;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ExtensionLocaleChangedPayload {
    pub locale: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParsedMessages {
    pub messages: LocaleStrings,
    pub problems: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Translator {
    own: Option<LocaleStrings>,
    base: Option<LocaleStrings>,
}

pub fn extension_locale_file(tag: &str) -> String {
    format!("{EXTENSION_LOCALES_DIR}/{tag}.json")
}

pub fn match_locale<'a>(locale: Option<&str>, available: &[&'a str]) -> Option<&'a str> {
    let lowered = locale.filter(|text| !text.is_empty())?.to_lowercase();
    let subtags: Vec<&str> = lowered.split('-').collect();
    for length in (1..=subtags.len()).rev() {
        let wanted = subtags[..length].join("-");
        if let Some(exact) = available
            .iter()
            .copied()
            .find(|tag| tag.to_lowercase() == wanted)
        {
            return Some(exact);
        }
    }
    available
        .iter()
        .copied()
        .find(|tag| tag.to_lowercase().split('-').next() == subtags.first().copied())
}

pub fn format_message(template: &str, vars: &MessageVars) -> String {
    PLACEHOLDER
        .replace_all(template, |captures: &Captures| {
            vars.get(&captures[1])
                .and_then(placeholder_text)
                .unwrap_or_else(|| captures[0].to_owned())
        })
        .into_owned()
}

fn catalog_tag<'a, T>(catalogs: &'a [(&str, T)], tag: &str) -> Option<&'a T> {
    catalogs
        .iter()
        .find(|(known, _)| *known == tag)
        .map(|(_, catalog)| catalog)
}

fn matching_catalog<'a, T>(catalogs: &'a [(&str, T)], locale: Option<&str>) -> Option<&'a T> {
    let tags: Vec<&str> = catalogs.iter().map(|(tag, _)| *tag).collect();
    match_locale(locale, &tags).and_then(|tag| catalog_tag(catalogs, tag))
}

pub fn localized<'a, T>(catalogs: &'a [(&str, T)], locale: Option<&str>) -> Option<&'a T> {
    matching_catalog(catalogs, locale).or_else(|| catalog_tag(catalogs, EXTENSION_BASE_LOCALE))
}

pub fn translator_for(catalogs: &[(&str, LocaleStrings)], locale: Option<&str>) -> Translator {
    Translator {
        own: matching_catalog(catalogs, locale).cloned(),
        base: catalog_tag(catalogs, EXTENSION_BASE_LOCALE).cloned(),
    }
}

impl Translator {
    pub fn translate(&self, key: &str, vars: &MessageVars) -> String {
        let message = [&self.own, &self.base]
            .into_iter()
            .flatten()
            .find_map(|catalog| catalog.get(key))
            .map_or(key, String::as_str);
        format_message(message, vars)
    }
}

pub fn parse_messages(raw: Option<&Value>) -> ParsedMessages {
    let mut parsed = ParsedMessages::default();
    let Some(raw) = raw else {
        return parsed;
    };
    let Some(entries) = raw.as_object() else {
        parsed
            .problems
            .push("messages must be an object of strings".to_owned());
        return parsed;
    };
    if entries.len() > EXTENSION_MESSAGES_MAX {
        parsed.problems.push(format!(
            "messages holds more than {EXTENSION_MESSAGES_MAX} strings"
        ));
    }
    for (key, value) in entries.iter().take(EXTENSION_MESSAGES_MAX) {
        if key.is_empty() || utf16_len(key) > EXTENSION_MESSAGE_KEY_MAX || is_dangerous_segment(key)
        {
            parsed
                .problems
                .push(format!("messages.{key}: not a usable key"));
            continue;
        }
        match value.as_str() {
            None => parsed
                .problems
                .push(format!("messages.{key}: must be a string")),
            Some(text) if utf16_len(text) > EXTENSION_MESSAGE_MAX => parsed.problems.push(format!(
                "messages.{key}: longer than {EXTENSION_MESSAGE_MAX} characters"
            )),
            Some(text) => {
                parsed.messages.insert(key.clone(), text.to_owned());
            }
        }
    }
    parsed
}
