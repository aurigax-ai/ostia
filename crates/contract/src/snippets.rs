use std::collections::BTreeMap;
use std::sync::LazyLock;

use ostia_base::js::{js_number_text, js_trim, static_regex, utf16_len};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use url::Url;

use crate::is_record::is_record;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetArgument {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnippetSource {
    Workspace,
    User,
    Extension,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetEntry {
    pub name: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub arguments: Vec<SnippetArgument>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shells: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    pub source: SnippetSource,
    pub origin: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnippetProblem {
    pub source: SnippetSource,
    pub origin: String,
    pub error: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnippetListing {
    pub snippets: Vec<SnippetEntry>,
    pub problems: Vec<SnippetProblem>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snippet {
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub arguments: Vec<SnippetArgument>,
    pub shells: Option<Vec<String>>,
    pub author: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommandPart {
    Text(String),
    Arg(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct SnippetError(String);

pub struct SnippetLimits {
    pub name: usize,
    pub command: usize,
    pub description: usize,
    pub tags: usize,
    pub tag: usize,
    pub arguments: usize,
    pub argument_description: usize,
    pub default_value: usize,
    pub shells: usize,
    pub author: usize,
    pub source_url: usize,
}

pub const SNIPPET_LIMITS: SnippetLimits = SnippetLimits {
    name: 200,
    command: 8192,
    description: 1000,
    tags: 32,
    tag: 64,
    arguments: 32,
    argument_description: 500,
    default_value: 1000,
    shells: 8,
    author: 200,
    source_url: 2000,
};

static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"\{\{\{([^{}]+)\}\}\}|\{\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}\}"));

pub fn is_argument_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && name.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn command_parts(command: &str) -> Vec<CommandPart> {
    let mut parts = Vec::new();
    let mut text = String::new();
    let mut last = 0;
    for captures in PLACEHOLDER.captures_iter(command) {
        let whole = captures.get(0).map_or(0..0, |m| m.range());
        text.push_str(&command[last..whole.start]);
        last = whole.end;
        if let Some(escaped) = captures.get(1) {
            text.push_str("{{");
            text.push_str(escaped.as_str());
            text.push_str("}}");
            continue;
        }
        if !text.is_empty() {
            parts.push(CommandPart::Text(std::mem::take(&mut text)));
        }
        if let Some(name) = captures.get(2) {
            parts.push(CommandPart::Arg(name.as_str().to_owned()));
        }
    }
    text.push_str(&command[last..]);
    if !text.is_empty() {
        parts.push(CommandPart::Text(text));
    }
    parts
}

pub fn placeholder_names(command: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for part in command_parts(command) {
        if let CommandPart::Arg(name) = part
            && !names.contains(&name)
        {
            names.push(name);
        }
    }
    names
}

pub fn snippet_arguments(snippet: &Snippet) -> Vec<SnippetArgument> {
    placeholder_names(&snippet.command)
        .into_iter()
        .map(|name| {
            snippet
                .arguments
                .iter()
                .find(|a| a.name == name)
                .cloned()
                .unwrap_or(SnippetArgument {
                    name,
                    description: None,
                    default_value: None,
                })
        })
        .collect()
}

pub fn render_snippet(command: &str, values: &BTreeMap<String, String>) -> String {
    command_parts(command)
        .into_iter()
        .map(|part| match part {
            CommandPart::Arg(name) => values.get(&name).cloned().unwrap_or_default(),
            CommandPart::Text(text) => text,
        })
        .collect()
}

pub fn default_values(snippet: &Snippet) -> BTreeMap<String, String> {
    snippet_arguments(snippet)
        .into_iter()
        .map(|a| (a.name, a.default_value.unwrap_or_default()))
        .collect()
}

fn fail<T>(message: String) -> Result<T, SnippetError> {
    Err(SnippetError(message))
}

fn optional_text(
    value: Option<&Value>,
    max: usize,
    field: &str,
) -> Result<Option<String>, SnippetError> {
    let text = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(text)) => text,
        Some(_) => return fail(format!("{field} must be a string")),
    };
    if utf16_len(text) > max {
        return fail(format!("{field} is longer than {max} characters"));
    }
    Ok((!js_trim(text).is_empty()).then(|| text.clone()))
}

fn scalar_text(
    value: Option<&Value>,
    max: usize,
    field: &str,
) -> Result<Option<String>, SnippetError> {
    match value {
        Some(Value::Number(number)) => Ok(Some(
            number
                .as_f64()
                .map_or_else(|| number.to_string(), js_number_text),
        )),
        Some(Value::Bool(flag)) => Ok(Some(flag.to_string())),
        other => optional_text(other, max, field),
    }
}

fn text_list(
    value: Option<&Value>,
    count: usize,
    max: usize,
    field: &str,
) -> Result<Vec<String>, SnippetError> {
    let items = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) if items.len() <= count => items,
        Some(_) => return fail(format!("{field} must be a list of at most {count} strings")),
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let text = item
            .as_str()
            .filter(|t| !js_trim(t).is_empty() && utf16_len(t) <= max);
        let Some(text) = text else {
            return fail(format!(
                "{field} must hold non-empty strings of at most {max} characters"
            ));
        };
        let trimmed = js_trim(text);
        if !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_owned());
        }
    }
    Ok(out)
}

fn parse_argument(raw: &Value, index: usize) -> Result<SnippetArgument, SnippetError> {
    let location = format!("arguments[{index}]");
    if !is_record(raw) {
        return fail(format!("{location} must be a mapping"));
    }
    let Some(name) = raw
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| is_argument_name(n))
    else {
        return fail(format!("{location}.name must be letters, digits, _ or -"));
    };
    let description = optional_text(
        raw.get("description"),
        SNIPPET_LIMITS.argument_description,
        &format!("{location}.description"),
    )?;
    let default_value = scalar_text(
        raw.get("default_value"),
        SNIPPET_LIMITS.default_value,
        &format!("{location}.default_value"),
    )?;
    Ok(SnippetArgument {
        name: name.to_owned(),
        description,
        default_value,
    })
}

fn is_web_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "https" | "http"))
}

fn trimmed(text: Option<String>) -> Option<String> {
    text.map(|t| js_trim(&t).to_owned())
}

pub fn parse_snippet(raw: &Value) -> Result<Snippet, SnippetError> {
    if !is_record(raw) {
        return fail("a snippet must be a mapping".to_owned());
    }
    let Some(name) = optional_text(raw.get("name"), SNIPPET_LIMITS.name, "name")? else {
        return fail("missing name".to_owned());
    };
    let Some(command) = optional_text(raw.get("command"), SNIPPET_LIMITS.command, "command")?
    else {
        return fail("missing command".to_owned());
    };
    let description = trimmed(optional_text(
        raw.get("description"),
        SNIPPET_LIMITS.description,
        "description",
    )?);
    let tags = text_list(
        raw.get("tags"),
        SNIPPET_LIMITS.tags,
        SNIPPET_LIMITS.tag,
        "tags",
    )?;

    let raw_args: &[Value] = match raw.get("arguments") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(items)) if items.len() <= SNIPPET_LIMITS.arguments => items,
        Some(_) => {
            return fail(format!(
                "arguments must be a list of at most {}",
                SNIPPET_LIMITS.arguments
            ));
        }
    };
    let mut arguments: Vec<SnippetArgument> = Vec::new();
    for (index, item) in raw_args.iter().enumerate() {
        let argument = parse_argument(item, index)?;
        if arguments.iter().any(|a| a.name == argument.name) {
            return fail(format!("duplicate argument '{}'", argument.name));
        }
        arguments.push(argument);
    }

    let shells = text_list(
        raw.get("shells"),
        SNIPPET_LIMITS.shells,
        SNIPPET_LIMITS.tag,
        "shells",
    )?;
    let author = trimmed(optional_text(
        raw.get("author"),
        SNIPPET_LIMITS.author,
        "author",
    )?);
    let source_url = trimmed(optional_text(
        raw.get("source_url"),
        SNIPPET_LIMITS.source_url,
        "source_url",
    )?);
    if let Some(url) = &source_url
        && !is_web_url(url)
    {
        return fail("source_url must be an http(s) URL".to_owned());
    }
    Ok(Snippet {
        name: js_trim(&name).to_owned(),
        command,
        description,
        tags,
        arguments,
        shells: (!shells.is_empty()).then_some(shells),
        author,
        source_url,
    })
}

pub fn snippet_document(snippet: &Snippet) -> Value {
    let mut doc = Map::new();
    doc.insert("name".to_owned(), Value::from(snippet.name.clone()));
    doc.insert("command".to_owned(), Value::from(snippet.command.clone()));
    if let Some(description) = snippet.description.as_ref().filter(|d| !d.is_empty()) {
        doc.insert("description".to_owned(), Value::from(description.clone()));
    }
    if !snippet.tags.is_empty() {
        doc.insert("tags".to_owned(), Value::from(snippet.tags.clone()));
    }
    if !snippet.arguments.is_empty() {
        let arguments: Vec<Value> = snippet.arguments.iter().map(argument_document).collect();
        doc.insert("arguments".to_owned(), Value::Array(arguments));
    }
    if let Some(shells) = &snippet.shells {
        doc.insert("shells".to_owned(), Value::from(shells.clone()));
    }
    if let Some(author) = snippet.author.as_ref().filter(|a| !a.is_empty()) {
        doc.insert("author".to_owned(), Value::from(author.clone()));
    }
    if let Some(url) = snippet.source_url.as_ref().filter(|u| !u.is_empty()) {
        doc.insert("source_url".to_owned(), Value::from(url.clone()));
    }
    Value::Object(doc)
}

fn argument_document(argument: &SnippetArgument) -> Value {
    let mut doc = Map::new();
    doc.insert("name".to_owned(), Value::from(argument.name.clone()));
    if let Some(description) = argument.description.as_ref().filter(|d| !d.is_empty()) {
        doc.insert("description".to_owned(), Value::from(description.clone()));
    }
    if let Some(value) = &argument.default_value {
        doc.insert("default_value".to_owned(), Value::from(value.clone()));
    }
    Value::Object(doc)
}

pub fn snippet_file_stem(name: &str) -> String {
    let mut dashed = String::new();
    let mut pending_dash = false;
    for c in name.nfkd().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending_dash {
                dashed.push('-');
            }
            pending_dash = false;
            dashed.push(c);
        } else {
            pending_dash = !dashed.is_empty();
        }
    }
    dashed.truncate(60);
    let stem = dashed.trim_end_matches('-');
    if stem.is_empty() {
        "snippet".to_owned()
    } else {
        stem.to_owned()
    }
}
