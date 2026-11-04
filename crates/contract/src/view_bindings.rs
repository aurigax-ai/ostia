use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex};
use regex::Regex;

use crate::string_enum::{StringEnum, string_enum};

string_enum!(ViewFilter {
    Upper = "upper",
    Lower = "lower",
    Count = "count",
    Not = "not",
    Relative = "relative",
    Time = "time",
    Date = "date",
});

pub const VIEW_FILTERS: &[&str] = ViewFilter::ALL;

#[derive(Debug, Clone, PartialEq)]
pub struct ViewFormat {
    pub now: f64,
    pub locale: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    pub path: Vec<String>,
    pub filters: Vec<ViewFilter>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TemplatePart {
    Text(String),
    Binding(Binding),
}

static SEGMENT: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]{1,4})$"));
static IDENTIFIER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[A-Za-z_][A-Za-z0-9_]*$"));
static BINDING: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\{\{([^{}]*)\}\}"));

const DANGEROUS_SEGMENTS: [&str; 3] = ["__proto__", "prototype", "constructor"];

pub fn is_dangerous_segment(segment: &str) -> bool {
    DANGEROUS_SEGMENTS.contains(&segment)
}

pub fn is_identifier(name: &str) -> bool {
    IDENTIFIER.is_match(name) && !is_dangerous_segment(name)
}

pub fn parse_path(raw: &str) -> Result<Vec<String>, String> {
    let text = js_trim(raw);
    if text.is_empty() {
        return Err("empty path".to_owned());
    }
    for segment in text.split('.') {
        if !SEGMENT.is_match(segment) {
            return Err(format!("'{text}' is not a property path"));
        }
        if is_dangerous_segment(segment) {
            return Err(format!("'{segment}' is not allowed in a path"));
        }
    }
    let segments: Vec<&str> = text.split('.').collect();
    if !segments
        .first()
        .is_some_and(|first| IDENTIFIER.is_match(first))
    {
        return Err(format!("'{text}' must start with a name"));
    }
    Ok(segments.into_iter().map(str::to_owned).collect())
}

fn parse_binding(inner: &str) -> Result<Binding, String> {
    let mut pieces = inner.split('|');
    let path = parse_path(pieces.next().unwrap_or_default())?;
    let mut filters = Vec::new();
    for raw in pieces {
        let name = js_trim(raw);
        let filter = ViewFilter::parse(name).ok_or_else(|| {
            format!(
                "unknown filter '{name}' (known: {})",
                ViewFilter::ALL.join(", ")
            )
        })?;
        filters.push(filter);
    }
    Ok(Binding { path, filters })
}

fn has_unbalanced_braces(literal: &str) -> bool {
    literal.contains("{{") || literal.contains("}}")
}

pub fn compile_template(template: &str) -> Result<Vec<TemplatePart>, String> {
    let mut parts = Vec::new();
    let mut last = 0;
    for captures in BINDING.captures_iter(template) {
        let (Some(whole), Some(inner)) = (captures.get(0), captures.get(1)) else {
            continue;
        };
        let literal = &template[last..whole.start()];
        if has_unbalanced_braces(literal) {
            return Err("unbalanced {{ }}".to_owned());
        }
        if !literal.is_empty() {
            parts.push(TemplatePart::Text(literal.to_owned()));
        }
        parts.push(TemplatePart::Binding(parse_binding(inner.as_str())?));
        last = whole.end();
    }
    let tail = &template[last..];
    if has_unbalanced_braces(tail) {
        return Err("unbalanced {{ }}".to_owned());
    }
    if !tail.is_empty() {
        parts.push(TemplatePart::Text(tail.to_owned()));
    }
    Ok(parts)
}

pub fn has_bindings(template: &str) -> bool {
    compile_template(template).is_ok_and(|parts| {
        parts
            .iter()
            .any(|part| matches!(part, TemplatePart::Binding(_)))
    })
}

pub fn bindings_of(template: &str) -> Vec<Binding> {
    compile_template(template)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|part| match part {
            TemplatePart::Binding(binding) => Some(binding),
            TemplatePart::Text(_) => None,
        })
        .collect()
}
