use ostia_base::js::utf16_len;
use ostia_contract::redaction::SecretSpan;
use serde_json::Value;

pub const SCAN_CHUNK_MAX: usize = 1024 * 1024;
pub const RULE_PREFIX: &str = "@secretlint/secretlint-rule-";
const REPORTED_VALUE_MIN: usize = 8;
const KIND_MAX: usize = 48;
const FALLBACK_KIND: &str = "secret";

#[derive(Clone, PartialEq)]
pub struct LintMessage {
    pub rule_id: String,
    pub range: (usize, usize),
    pub data: Value,
}

impl std::fmt::Debug for LintMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LintMessage")
            .field("rule_id", &self.rule_id)
            .field("range", &self.range)
            .finish_non_exhaustive()
    }
}

pub fn kind_of_rule(rule_id: &str) -> String {
    let name = rule_id.strip_prefix(RULE_PREFIX).unwrap_or(rule_id);
    let mut kind = String::new();
    let mut in_gap = false;
    for ch in name.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' {
            if in_gap {
                kind.push('-');
                in_gap = false;
            }
            kind.push(ch);
        } else {
            in_gap = true;
        }
    }
    if in_gap {
        kind.push('-');
    }
    let trimmed = kind.trim_matches('-');
    let cut: String = trimmed.chars().take(KIND_MAX).collect();
    if cut.is_empty() {
        FALLBACK_KIND.to_owned()
    } else {
        cut
    }
}

fn reported_values(data: &Value) -> Vec<&str> {
    let Some(object) = data.as_object() else {
        return Vec::new();
    };
    object
        .values()
        .filter_map(Value::as_str)
        .filter(|value| utf16_len(value) >= REPORTED_VALUE_MIN)
        .collect()
}

pub fn spans_of(text: &str, message: &LintMessage, offset: usize) -> Vec<SecretSpan> {
    let kind = kind_of_rule(&message.rule_id);
    let (start, end) = message.range;
    let reported = SecretSpan {
        start: offset + start,
        end: offset + end,
        kind: kind.clone(),
    };
    let range_units = text
        .get(start..end)
        .map_or(end.saturating_sub(start), utf16_len);
    let mut beyond: Vec<SecretSpan> = Vec::new();
    let mut shifted: Option<SecretSpan> = None;
    for value in reported_values(&message.data) {
        let Some(found) = text.get(start..).and_then(|rest| rest.find(value)) else {
            continue;
        };
        let at = start + found;
        if at > end || at + value.len() <= end {
            continue;
        }
        let span = SecretSpan {
            start: offset + at,
            end: offset + at + value.len(),
            kind: kind.clone(),
        };
        if utf16_len(value) == range_units {
            shifted = Some(span);
        } else {
            beyond.push(span);
        }
    }
    match shifted {
        Some(span) if beyond.is_empty() => vec![span],
        Some(span) => [vec![reported, span], beyond].concat(),
        None => [vec![reported], beyond].concat(),
    }
}

fn unit_boundary(text: &str, start: usize, units: usize) -> Option<usize> {
    let mut used = 0;
    for (offset, ch) in text[start..].char_indices() {
        if used + ch.len_utf16() > units {
            return Some(start + offset);
        }
        used += ch.len_utf16();
    }
    None
}

fn chunk_end(text: &str, start: usize) -> usize {
    let Some(limit) = unit_boundary(text, start, SCAN_CHUNK_MAX) else {
        return text.len();
    };
    let newline = if text[limit..].starts_with('\n') {
        Some(limit)
    } else {
        text[start..limit].rfind('\n').map(|found| start + found)
    };
    match newline {
        Some(at) if at > start => at + 1,
        _ => limit,
    }
}

pub fn chunk_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let end = chunk_end(text, start);
        ranges.push((start, end));
        start = end;
    }
    ranges
}
