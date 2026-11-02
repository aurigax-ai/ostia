use std::sync::LazyLock;

use ostia_base::js::{static_regex, utf16_len};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::utf16_prefix::utf16_prefix;

pub const SPEC_FILE_MAX_BYTES: u64 = 4 * 1024 * 1024;

const MAX_DEPTH: usize = 12;
const MAX_NAME: usize = 200;
const MAX_DESCRIPTION: usize = 400;
const MAX_ITEMS: usize = 20000;
const MAX_NAMES: usize = 20;

static SPEC_COMMAND_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$"));

pub fn is_spec_command(command: &str) -> bool {
    SPEC_COMMAND_PATTERN.is_match(command)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpecTemplate {
    Filepaths,
    Folders,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SpecSuggestion {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecArg {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestions: Option<Vec<SpecSuggestion>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<Vec<SpecTemplate>>,
    #[serde(skip_serializing_if = "is_false")]
    pub is_optional: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub is_variadic: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecOption {
    pub names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<SpecArg>>,
    #[serde(skip_serializing_if = "is_false")]
    pub is_persistent: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub is_repeatable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SpecCommand {
    pub names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subcommands: Option<Vec<SpecCommand>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<SpecOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<SpecArg>>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

type Parsed<T> = Result<T, &'static str>;

fn names(raw: Option<&Value>) -> Parsed<Vec<String>> {
    let items = match raw.and_then(Value::as_array) {
        Some(items) if !items.is_empty() && items.len() <= MAX_NAMES => items,
        _ => return Err("names must be a non-empty array"),
    };
    items
        .iter()
        .map(|item| match item.as_str() {
            Some(name) if !name.is_empty() && utf16_len(name) <= MAX_NAME => Ok(name.to_owned()),
            _ => Err("each name must be a non-empty string"),
        })
        .collect()
}

fn description(raw: Option<&Value>) -> Option<String> {
    raw.and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(|text| utf16_prefix(text, MAX_DESCRIPTION).to_owned())
}

fn list<T>(
    raw: Option<&Value>,
    budget: &mut usize,
    mut parse: impl FnMut(&Value, &mut usize) -> Parsed<T>,
) -> Parsed<Option<Vec<T>>> {
    let Some(raw) = raw else { return Ok(None) };
    let Some(items) = raw.as_array() else {
        return Err("expected an array");
    };
    let mut out = Vec::new();
    for item in items {
        *budget += 1;
        if *budget > MAX_ITEMS {
            return Err("spec is too large");
        }
        out.push(parse(item, budget)?);
    }
    Ok(Some(out))
}

fn non_empty<T>(items: Option<Vec<T>>) -> Option<Vec<T>> {
    items.filter(|items| !items.is_empty())
}

fn flag(raw: &Value, key: &str) -> bool {
    raw.get(key) == Some(&Value::Bool(true))
}

fn parse_suggestion(raw: &Value, _budget: &mut usize) -> Parsed<SpecSuggestion> {
    if !raw.is_object() {
        return Err("suggestion needs a name");
    }
    match raw.get("name").and_then(Value::as_str) {
        Some(name) if !name.is_empty() && utf16_len(name) <= MAX_NAME => Ok(SpecSuggestion {
            name: name.to_owned(),
            description: description(raw.get("description")),
        }),
        _ => Err("suggestion needs a name"),
    }
}

fn parse_arg(raw: &Value, budget: &mut usize) -> Parsed<SpecArg> {
    if !raw.is_object() {
        return Err("arg must be an object");
    }
    let mut arg = SpecArg::default();
    if let Some(name) = raw
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
    {
        arg.name = Some(utf16_prefix(name, MAX_NAME).to_owned());
    }
    arg.description = description(raw.get("description"));
    arg.suggestions = non_empty(list(raw.get("suggestions"), budget, parse_suggestion)?);
    if let Some(template) = raw.get("template") {
        let Some(items) = template.as_array() else {
            return Err("template must be an array");
        };
        let template: Vec<SpecTemplate> = items
            .iter()
            .filter_map(|item| match item.as_str() {
                Some("filepaths") => Some(SpecTemplate::Filepaths),
                Some("folders") => Some(SpecTemplate::Folders),
                _ => None,
            })
            .collect();
        if !template.is_empty() {
            arg.template = Some(template);
        }
    }
    arg.is_optional = flag(raw, "isOptional");
    arg.is_variadic = flag(raw, "isVariadic");
    Ok(arg)
}

fn parse_option(raw: &Value, budget: &mut usize) -> Parsed<SpecOption> {
    if !raw.is_object() {
        return Err("option must be an object");
    }
    let option_names = names(raw.get("names"))?;
    Ok(SpecOption {
        names: option_names,
        description: description(raw.get("description")),
        args: non_empty(list(raw.get("args"), budget, parse_arg)?),
        is_persistent: flag(raw, "isPersistent"),
        is_repeatable: flag(raw, "isRepeatable"),
    })
}

fn parse_command(raw: &Value, depth: usize, budget: &mut usize) -> Parsed<SpecCommand> {
    if depth > MAX_DEPTH {
        return Err("spec is nested too deeply");
    }
    if !raw.is_object() {
        return Err("command must be an object");
    }
    let command_names = names(raw.get("names"))?;
    let description = description(raw.get("description"));
    let subcommands = non_empty(list(raw.get("subcommands"), budget, |item, budget| {
        parse_command(item, depth + 1, budget)
    })?);
    let options = non_empty(list(raw.get("options"), budget, parse_option)?);
    let args = non_empty(list(raw.get("args"), budget, parse_arg)?);
    Ok(SpecCommand {
        names: command_names,
        description,
        subcommands,
        options,
        args,
    })
}

pub fn parse_completion_spec(raw: &Value) -> Result<SpecCommand, &'static str> {
    parse_command(raw, 0, &mut 0)
}
