use std::collections::HashSet;
use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex, utf16_len};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::is_record::is_record;
use crate::proto_guard::is_dangerous_segment;

pub static EDITOR_LANGUAGE_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z][a-z0-9+#-]{0,39}$"));
pub const PLAIN_TEXT_LANGUAGE: &str = "plaintext";
pub const SETTINGS_LANGUAGE_ID: &str = "ostia-settings";
pub const MAX_EDITOR_LANGUAGES: usize = 16;
pub const MAX_LANGUAGE_FILE_PATTERNS: usize = 16;
pub const EDITOR_LANGUAGE_NAME_MAX: usize = 80;
pub static EDITOR_LANGUAGE_EXTENSION_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^\.[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,29}$"));
pub static EDITOR_LANGUAGE_FILENAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9._+-]{1,60}$"));
pub static EDITOR_LANGUAGE_GRAMMAR_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"\.json$"));
pub const GRAMMAR_FILE_MAX_BYTES: usize = 256 * 1024;
pub const GRAMMAR_MAX_STATES: usize = 200;
pub const GRAMMAR_MAX_RULES: usize = 500;
pub const GRAMMAR_REGEX_MAX: usize = 2000;
const COMMENT_TOKEN_MAX: usize = 10;
const MAX_BRACKET_PAIRS: usize = 16;
const MAX_GRAMMAR_DEPTH: usize = 12;

static AT_NAME: LazyLock<Regex> = LazyLock::new(|| static_regex(r"@[A-Za-z_][A-Za-z0-9_]*"));

const LANGUAGE_BY_EXTENSION: [(&str, &str); 38] = [
    ("ts", "typescript"),
    ("tsx", "typescript"),
    ("mts", "typescript"),
    ("cts", "typescript"),
    ("js", "javascript"),
    ("jsx", "javascript"),
    ("mjs", "javascript"),
    ("cjs", "javascript"),
    ("json", "json"),
    ("jsonc", "json"),
    ("css", "css"),
    ("scss", "scss"),
    ("less", "less"),
    ("html", "html"),
    ("htm", "html"),
    ("md", "markdown"),
    ("mdx", "markdown"),
    ("py", "python"),
    ("pyi", "python"),
    ("rs", "rust"),
    ("go", "go"),
    ("sh", "shell"),
    ("zsh", "shell"),
    ("bash", "shell"),
    ("yaml", "yaml"),
    ("yml", "yaml"),
    ("toml", "ini"),
    ("ini", "ini"),
    ("sql", "sql"),
    ("c", "c"),
    ("h", "c"),
    ("cpp", "cpp"),
    ("cc", "cpp"),
    ("cxx", "cpp"),
    ("hpp", "cpp"),
    ("hh", "cpp"),
    ("java", "java"),
    ("lua", "lua"),
];

pub static BUILTIN_EDITOR_LANGUAGE_IDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut ids: HashSet<&'static str> = LANGUAGE_BY_EXTENSION
        .iter()
        .map(|(_, language)| *language)
        .collect();
    ids.insert(PLAIN_TEXT_LANGUAGE);
    ids.insert(SETTINGS_LANGUAGE_ID);
    ids
});

pub type BracketPair = [String; 2];

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorLanguageConfiguration {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_comment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_comment: Option<BracketPair>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brackets: Option<Vec<BracketPair>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_closing_pairs: Option<Vec<BracketPair>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EditorLanguageMapping {
    pub id: String,
    pub extensions: Vec<String>,
    pub filenames: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EditorLanguageContribution {
    pub id: String,
    pub name: String,
    pub extensions: Vec<String>,
    pub filenames: Vec<String>,
    pub configuration: EditorLanguageConfiguration,
    pub grammar: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorLanguage {
    pub id: String,
    pub ext_id: String,
    pub name: String,
    pub extensions: Vec<String>,
    pub filenames: Vec<String>,
    pub configuration: EditorLanguageConfiguration,
    pub grammar: Value,
}

fn builtin_language(extension: &str) -> Option<&'static str> {
    LANGUAGE_BY_EXTENSION
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, language)| *language)
}

fn base_name(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

pub fn file_extension(path: &str) -> String {
    let name = base_name(path);
    name.rfind('.')
        .map_or_else(String::new, |dot| name[dot + 1..].to_lowercase())
}

pub fn language_for_path(path: &str, contributed: &[EditorLanguageMapping]) -> String {
    if let Some(language) = builtin_language(&file_extension(path)) {
        return language.to_owned();
    }
    let name = base_name(path);
    if let Some(by_name) = contributed
        .iter()
        .find(|language| language.filenames.iter().any(|known| known == name))
    {
        return by_name.id.clone();
    }
    let lower = name.to_lowercase();
    let lower_length = utf16_len(&lower);
    let mut best: Option<(&str, usize)> = None;
    for language in contributed {
        for suffix in &language.extensions {
            let length = utf16_len(suffix);
            if lower_length > length
                && lower.ends_with(&suffix.to_lowercase())
                && best.is_none_or(|(_, longest)| length > longest)
            {
                best = Some((language.id.as_str(), length));
            }
        }
    }
    best.map_or_else(|| PLAIN_TEXT_LANGUAGE.to_owned(), |(id, _)| id.to_owned())
}

fn short_token(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| {
        let length = utf16_len(text);
        length > 0 && length <= COMMENT_TOKEN_MAX
    })
}

fn pair(value: &Value) -> Option<BracketPair> {
    let [open, close] = value.as_array()?.as_slice() else {
        return None;
    };
    Some([
        short_token(open)?.to_owned(),
        short_token(close)?.to_owned(),
    ])
}

fn pairs(raw: Option<&Value>, place: &str) -> Result<Option<Vec<BracketPair>>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let items = raw
        .as_array()
        .filter(|items| items.len() <= MAX_BRACKET_PAIRS)
        .ok_or_else(|| format!("{place} must be at most {MAX_BRACKET_PAIRS} pairs"))?;
    items
        .iter()
        .map(|item| pair(item).ok_or_else(|| format!("{place} must hold pairs of short strings")))
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn parse_configuration(
    raw: Option<&Value>,
    place: &str,
) -> Result<EditorLanguageConfiguration, String> {
    let Some(raw) = raw else {
        return Ok(EditorLanguageConfiguration::default());
    };
    let Some(map) = raw.as_object() else {
        return Err(format!("{place} must be an object"));
    };
    let mut configuration = EditorLanguageConfiguration::default();
    if let Some(value) = map.get("lineComment") {
        let token = short_token(value)
            .ok_or_else(|| format!("{place}.lineComment must be a short string"))?;
        configuration.line_comment = Some(token.to_owned());
    }
    if let Some(value) = map.get("blockComment") {
        let block = pair(value)
            .ok_or_else(|| format!("{place}.blockComment must be a pair of short strings"))?;
        configuration.block_comment = Some(block);
    }
    configuration.brackets = pairs(map.get("brackets"), &format!("{place}.brackets"))?;
    configuration.auto_closing_pairs = pairs(
        map.get("autoClosingPairs"),
        &format!("{place}.autoClosingPairs"),
    )?;
    Ok(configuration)
}

pub(crate) fn unique_strings<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for name in names {
        if !unique.iter().any(|seen| seen == name) {
            unique.push(name.to_owned());
        }
    }
    unique
}

fn patterns(raw: Option<&Value>, pattern: &Regex, place: &str) -> Result<Vec<String>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let names = raw
        .as_array()
        .filter(|items| items.len() <= MAX_LANGUAGE_FILE_PATTERNS)
        .and_then(|items| {
            items
                .iter()
                .map(|item| item.as_str().filter(|text| pattern.is_match(text)))
                .collect::<Option<Vec<&str>>>()
        })
        .ok_or_else(|| format!("{place} must be at most {MAX_LANGUAGE_FILE_PATTERNS} names"))?;
    Ok(unique_strings(names))
}

fn parse_language(
    item: &Value,
    place: &str,
    earlier: &[EditorLanguageContribution],
    is_inside: &dyn Fn(&str) -> bool,
) -> Result<EditorLanguageContribution, String> {
    if !is_record(item) {
        return Err(format!("{place}: must be an object"));
    }
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| EDITOR_LANGUAGE_ID_PATTERN.is_match(id))
        .ok_or_else(|| format!("{place}: invalid id"))?;
    if BUILTIN_EDITOR_LANGUAGE_IDS.contains(id) {
        return Err(format!(
            "{place}: '{id}' is a language the editor already has"
        ));
    }
    if earlier.iter().any(|language| language.id == id) {
        return Err(format!("{place}: duplicate id '{id}'"));
    }
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !js_trim(name).is_empty() && utf16_len(name) <= EDITOR_LANGUAGE_NAME_MAX)
        .ok_or_else(|| format!("{place}: name must be 1-{EDITOR_LANGUAGE_NAME_MAX} characters"))?;
    let extensions = patterns(
        item.get("extensions"),
        &EDITOR_LANGUAGE_EXTENSION_PATTERN,
        &format!("{place}.extensions"),
    )?;
    let filenames = patterns(
        item.get("filenames"),
        &EDITOR_LANGUAGE_FILENAME_PATTERN,
        &format!("{place}.filenames"),
    )?;
    if extensions.len() + filenames.len() == 0 {
        return Err(format!(
            "{place}: needs at least one extension or file name"
        ));
    }
    let configuration =
        parse_configuration(item.get("configuration"), &format!("{place}.configuration"))?;
    let grammar = item
        .get("grammar")
        .and_then(Value::as_str)
        .filter(|grammar| EDITOR_LANGUAGE_GRAMMAR_PATTERN.is_match(grammar) && is_inside(grammar))
        .ok_or_else(|| format!("{place}: grammar must be a .json file inside the extension"))?;
    Ok(EditorLanguageContribution {
        id: id.to_owned(),
        name: name.to_owned(),
        extensions,
        filenames,
        configuration,
        grammar: grammar.to_owned(),
    })
}

pub fn parse_editor_languages(
    raw: Option<&Value>,
    is_inside: &dyn Fn(&str) -> bool,
) -> Result<Vec<EditorLanguageContribution>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let items = raw
        .as_array()
        .filter(|items| items.len() <= MAX_EDITOR_LANGUAGES)
        .ok_or_else(|| {
            format!(
                "contributes.editorLanguages must be an array of at most {MAX_EDITOR_LANGUAGES}"
            )
        })?;
    let mut languages: Vec<EditorLanguageContribution> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let place = format!("contributes.editorLanguages[{index}]");
        let language = parse_language(item, &place, &languages, is_inside)?;
        languages.push(language);
    }
    Ok(languages)
}

fn compiles(source: &str) -> bool {
    utf16_len(source) <= GRAMMAR_REGEX_MAX
        && regress::Regex::new(&AT_NAME.replace_all(source, "x")).is_ok()
}

fn rule_regex(rule: &Value) -> Option<&Value> {
    match rule {
        Value::Array(items) => items.first(),
        Value::Object(map) => map.get("regex"),
        _ => None,
    }
}

fn clean_grammar_value(value: &Value, depth: usize) -> Option<Value> {
    if depth > MAX_GRAMMAR_DEPTH {
        return None;
    }
    match value {
        Value::Array(items) => Some(Value::Array(
            items
                .iter()
                .map(|item| clean_grammar_value(item, depth + 1).unwrap_or(Value::Null))
                .collect(),
        )),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                if is_dangerous_segment(key) {
                    continue;
                }
                if let Some(cleaned) = clean_grammar_value(item, depth + 1) {
                    out.insert(key.clone(), cleaned);
                }
            }
            Some(Value::Object(out))
        }
        Value::String(_) | Value::Number(_) | Value::Bool(_) => Some(value.clone()),
        Value::Null => None,
    }
}

fn check_state(state: &str, rules: &Value) -> Result<(), String> {
    let rules = rules
        .as_array()
        .filter(|rules| rules.len() <= GRAMMAR_MAX_RULES)
        .ok_or_else(|| {
            format!("tokenizer.{state} must be an array of at most {GRAMMAR_MAX_RULES} rules")
        })?;
    for (index, rule) in rules.iter().enumerate() {
        if rule.get("include").is_some_and(Value::is_string) {
            continue;
        }
        let compiling = rule_regex(rule)
            .and_then(Value::as_str)
            .is_some_and(compiles);
        if !compiling {
            return Err(format!(
                "tokenizer.{state}[{index}] does not start with a regular expression that compiles"
            ));
        }
    }
    Ok(())
}

pub fn validate_monarch_grammar(raw: &Value) -> Result<Value, String> {
    let Some(Value::Object(grammar)) = clean_grammar_value(raw, 0) else {
        return Err("must be a JSON object".to_owned());
    };
    let Some(Value::Object(tokenizer)) = grammar.get("tokenizer") else {
        return Err("tokenizer must be an object of states".to_owned());
    };
    if tokenizer.is_empty() || tokenizer.len() > GRAMMAR_MAX_STATES {
        return Err(format!("tokenizer must have 1-{GRAMMAR_MAX_STATES} states"));
    }
    for (state, rules) in tokenizer {
        check_state(state, rules)?;
    }
    for (key, value) in &grammar {
        if key != "defaultToken" && value.as_str().is_some_and(|text| !compiles(text)) {
            return Err(format!("{key} is not a regular expression that compiles"));
        }
    }
    Ok(Value::Object(grammar))
}
