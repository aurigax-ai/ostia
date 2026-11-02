use std::collections::HashMap;
use std::sync::LazyLock;

use ostia_base::js::{JS_SPACE_CLASS, js_trim, static_regex};
use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use crate::agent_plugins::AgentHookEvent;

const SKILL_KEYS: [&str; 2] = ["name", "description"];

static LINE_BREAK: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"\r\n|[\n\r\x{0085}\x{2028}\x{2029}]"));
static LINE_END: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\r?\n"));
static INLINE_INJECTION: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"[!\x{01c3}][`\x{02cb}\x{02f4}\x{2035}$]"));
static FENCED_INJECTION: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?:[`\x{02cb}\x{02f4}\x{2035}]{3,}|~{3,})[ \t]*[!\x{01c3}$]"));
static FIELD_LINE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^([A-Za-z][A-Za-z0-9_-]*):(?: +(.*))?$"));
static LEADING_SPACE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^[{JS_SPACE_CLASS}]")));
static SPACE_BEFORE_COLON: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^[A-Za-z][A-Za-z0-9_-]*[{JS_SPACE_CLASS}]+:")));
static COMMENT_AFTER_SPACE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"(^|[{JS_SPACE_CLASS}])#")));
static BLOCK_SCALAR: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[>|][+-]?$"));
static FLOW_START: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[{\[]"));
static ANCHOR_START: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[&*!]"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionAgentHook {
    pub ext_id: String,
    pub event: AgentHookEvent,
    pub command: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SkillFrontmatter {
    Valid { name: String, description: String },
    Invalid { error: String },
}

pub fn skill_directive(text: &str) -> Option<String> {
    for (index, line) in LINE_BREAK.split(text).enumerate() {
        let flat: String = line.nfkc().collect();
        if INLINE_INJECTION.is_match(&flat) || FENCED_INJECTION.is_match(&flat) {
            return Some(format!(
                "line {}: shell injection (!` or a ```! block) is not allowed",
                index + 1
            ));
        }
    }
    None
}

fn has_control_character(line: &str) -> bool {
    line.chars().any(|ch| {
        let code = u32::from(ch);
        (code < 0x20 && code != 0x09)
            || code == 0x7f
            || code == 0x85
            || code == 0x2028
            || code == 0x2029
    })
}

fn closing_fence(lines: &[&str]) -> Option<usize> {
    lines
        .iter()
        .enumerate()
        .position(|(index, line)| index > 0 && line.strip_suffix('\r').unwrap_or(*line) == "---")
}

fn refuse(line: usize, reason: &str) -> Option<SkillFrontmatter> {
    Some(SkillFrontmatter::Invalid {
        error: format!("line {line}: {reason}"),
    })
}

fn value_problem(raw: &str) -> Option<&'static str> {
    let value = js_trim(raw);
    if BLOCK_SCALAR.is_match(value) {
        return Some("block scalars are not supported");
    }
    if FLOW_START.is_match(value) {
        return Some("flow collections are not supported");
    }
    if ANCHOR_START.is_match(value) {
        return Some("anchors, aliases and tags are not supported");
    }
    if COMMENT_AFTER_SPACE.is_match(raw) {
        return Some("' #' is ambiguous, remove the comment");
    }
    let quote = match value.as_bytes().first() {
        Some(b'"') => '"',
        Some(b'\'') => '\'',
        _ => return None,
    };
    let paired = value.len() >= 2 && value.ends_with(quote);
    let inner = if paired {
        &value[1..value.len() - 1]
    } else {
        ""
    };
    if !paired || inner.contains(quote) {
        return Some("a quoted value must be one matching pair of quotes");
    }
    if inner.contains('\\') {
        return Some("escapes inside quotes are not supported");
    }
    None
}

fn unquote(value: &str) -> &str {
    if value.starts_with(['"', '\'']) {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn key_problem(line: &str) -> &'static str {
    if line.starts_with(['"', '\'']) {
        "quoted keys are not supported"
    } else if SPACE_BEFORE_COLON.is_match(line) {
        "no space allowed before the colon"
    } else {
        "expected key: value"
    }
}

pub fn skill_frontmatter(text: &str) -> Option<SkillFrontmatter> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = LINE_END.split(text).collect();
    if lines.first() != Some(&"---") {
        return None;
    }
    let end = closing_fence(&lines)?;
    let next = lines
        .iter()
        .skip(end + 1)
        .find(|line| !js_trim(line).is_empty());
    if next == Some(&"---") {
        return refuse(end + 2, "a second frontmatter block is not supported");
    }
    let mut fields: HashMap<&str, String> = HashMap::new();
    for (index, line) in lines.iter().enumerate().take(end).skip(1) {
        let at = index + 1;
        if js_trim(line).is_empty() {
            continue;
        }
        if line.starts_with('#') {
            return refuse(at, "comments are not supported");
        }
        if has_control_character(line) {
            return refuse(at, "control characters are not supported");
        }
        if LEADING_SPACE.is_match(line) {
            return refuse(at, "indented lines are not supported");
        }
        let Some(captures) = FIELD_LINE.captures(line) else {
            return refuse(at, key_problem(line));
        };
        let key = captures.get(1).map_or("", |name| name.as_str());
        let raw = captures.get(2).map_or("", |value| value.as_str());
        if !SKILL_KEYS.contains(&key) {
            return refuse(
                at,
                &format!("'{key}' is not allowed, a skill carries only name and description"),
            );
        }
        if fields.contains_key(key) {
            return refuse(at, &format!("duplicate key '{key}'"));
        }
        if let Some(problem) = value_problem(raw) {
            return refuse(at, problem);
        }
        fields.insert(key, unquote(js_trim(raw)).to_owned());
    }
    let invalid = |error: &str| {
        Some(SkillFrontmatter::Invalid {
            error: error.to_owned(),
        })
    };
    let Some(name) = fields.get("name") else {
        return invalid("needs a name");
    };
    let Some(description) = fields.get("description") else {
        return invalid("needs a description");
    };
    if name.is_empty() {
        return invalid("name is empty");
    }
    if description.is_empty() {
        return invalid("description is empty");
    }
    Some(SkillFrontmatter::Valid {
        name: name.clone(),
        description: description.clone(),
    })
}
