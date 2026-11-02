use std::collections::HashSet;
use std::sync::LazyLock;

use ostia_base::js::{JS_SPACE_CLASS, js_trim, static_regex, utf16_len};
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use serde_json::{Map, Value};

pub const REDACTION_PATTERNS_MAX: usize = 20;
pub const REDACTION_PATTERN_MAX: usize = 200;
pub const REDACTION_REPEAT_MAX: usize = 256;
pub const CUSTOM_WINDOW: usize = 512;
pub const CUSTOM_WINDOW_STEP: usize = CUSTOM_WINDOW / 2;
pub const CUSTOM_KIND: &str = "custom";
pub const REDACT_TEXTS_MAX: usize = 64;
pub const REDACT_TEXT_MAX: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RedactionSettings {
    pub enabled: bool,
    pub patterns: Vec<String>,
}

pub fn parse_redaction_settings(raw: &Value) -> RedactionSettings {
    let source = raw.as_object();
    let mut patterns: Vec<String> = Vec::new();
    if let Some(items) = source
        .and_then(|object| object.get("patterns"))
        .and_then(Value::as_array)
    {
        for item in items {
            if patterns.len() == REDACTION_PATTERNS_MAX {
                break;
            }
            let Some(pattern) = item.as_str() else {
                continue;
            };
            if pattern.is_empty() || patterns.iter().any(|known| known == pattern) {
                continue;
            }
            patterns.push(pattern.to_owned());
        }
    }
    let enabled = source
        .and_then(|object| object.get("enabled"))
        .is_none_or(|value| value != &Value::Bool(false));
    RedactionSettings { enabled, patterns }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatternProblem {
    Empty,
    TooLong,
    Invalid,
    MatchesEmpty,
    Lookaround,
    Backreference,
    NestedRepeat,
    OpenRepeats,
    WideRepeat,
}

struct Repeat {
    min: u64,
    max: Option<u64>,
    length: usize,
}

fn digits_at(chars: &[char], from: usize, limit: usize) -> usize {
    chars[from..]
        .iter()
        .take(limit)
        .take_while(|ch| ch.is_ascii_digit())
        .count()
}

fn digits_value(chars: &[char]) -> u64 {
    chars.iter().fold(0, |total, digit| {
        total * 10 + u64::from(*digit as u8 - b'0')
    })
}

fn braces_at(source: &[char], at: usize) -> Option<Repeat> {
    let window = &source[at..source.len().min(at + 16)];
    let min_digits = digits_at(window, 1, 6);
    if min_digits == 0 {
        return None;
    }
    let min = digits_value(&window[1..=min_digits]);
    let mut cursor = 1 + min_digits;
    let mut max = Some(min);
    if window.get(cursor) == Some(&',') {
        cursor += 1;
        let max_digits = digits_at(window, cursor, 6);
        max = if max_digits == 0 {
            None
        } else {
            Some(digits_value(&window[cursor..cursor + max_digits]))
        };
        cursor += max_digits;
    }
    if window.get(cursor) != Some(&'}') {
        return None;
    }
    Some(Repeat {
        min,
        max,
        length: cursor + 1,
    })
}

fn repeat_at(source: &[char], at: usize) -> Option<Repeat> {
    let repeat = match source[at] {
        '*' => Repeat {
            min: 0,
            max: None,
            length: 1,
        },
        '+' => Repeat {
            min: 1,
            max: None,
            length: 1,
        },
        '?' => Repeat {
            min: 0,
            max: Some(1),
            length: 1,
        },
        '{' => braces_at(source, at)?,
        _ => return None,
    };
    if source.get(at + repeat.length) == Some(&'?') {
        return Some(Repeat {
            length: repeat.length + 1,
            ..repeat
        });
    }
    Some(repeat)
}

fn class_end(source: &[char], at: usize) -> usize {
    let mut index = at + 1;
    while index < source.len() && source[index] != ']' {
        index += if source[index] == '\\' { 2 } else { 1 };
    }
    index + 1
}

fn is_name_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_' || ch == '$'
}

fn is_name_part(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'
}

fn group_prefix_length(source: &[char], at: usize) -> usize {
    if source[at..].starts_with(&['(', '?', ':']) {
        return 3;
    }
    let window = &source[at..source.len().min(at + 64)];
    if window.len() > 3 && window[..3] == ['(', '?', '<'] && is_name_start(window[3]) {
        let name_end = window[4..]
            .iter()
            .position(|ch| !is_name_part(*ch))
            .map(|offset| 4 + offset);
        if let Some(end) = name_end
            && window[end] == '>'
        {
            return end + 1;
        }
    }
    1
}

fn starts_lookaround(source: &[char], at: usize) -> bool {
    let window = &source[at..source.len().min(at + 4)];
    if window.len() < 3 || window[..2] != ['(', '?'] {
        return false;
    }
    let after = if window[2] == '<' { 3 } else { 2 };
    matches!(window.get(after), Some('=' | '!'))
}

fn structure_problem(source: &[char]) -> Option<PatternProblem> {
    let mut stack: Vec<bool> = vec![false];
    let mut closed: Option<bool> = None;
    let mut open_ended = 0;
    let mut index = 0;
    while index < source.len() {
        let ch = source[index];
        if ch == '\\' {
            let next = source.get(index + 1).copied().unwrap_or('\0');
            if matches!(next, '1'..='9' | 'k') {
                return Some(PatternProblem::Backreference);
            }
            closed = None;
            index += 2;
            continue;
        }
        if ch == '[' {
            closed = None;
            index = class_end(source, index);
            continue;
        }
        if ch == '(' {
            if starts_lookaround(source, index) {
                return Some(PatternProblem::Lookaround);
            }
            stack.push(false);
            closed = None;
            index += group_prefix_length(source, index);
            continue;
        }
        if ch == ')' {
            if stack.len() <= 1 {
                return Some(PatternProblem::Invalid);
            }
            let variable = stack.pop().unwrap_or(false);
            if variable && let Some(parent) = stack.last_mut() {
                *parent = true;
            }
            closed = Some(variable);
            index += 1;
            continue;
        }
        if ch == '|' {
            if let Some(top) = stack.last_mut() {
                *top = true;
            }
            closed = None;
            index += 1;
            continue;
        }
        if let Some(repeat) = repeat_at(source, index) {
            let repeats_more = repeat.max.is_none_or(|max| max > 1);
            if repeats_more && closed == Some(true) {
                return Some(PatternProblem::NestedRepeat);
            }
            match repeat.max {
                None => {
                    open_ended += 1;
                    if open_ended > 1 {
                        return Some(PatternProblem::OpenRepeats);
                    }
                }
                Some(max) if max > REDACTION_REPEAT_MAX as u64 => {
                    return Some(PatternProblem::WideRepeat);
                }
                Some(_) => {}
            }
            if Some(repeat.min) != repeat.max
                && let Some(top) = stack.last_mut()
            {
                *top = true;
            }
            closed = None;
            index += repeat.length;
            continue;
        }
        closed = None;
        index += 1;
    }
    None
}

fn compile(source: &str) -> Option<Regex> {
    RegexBuilder::new(source).build().ok()
}

pub fn pattern_problem(source: &str) -> Option<PatternProblem> {
    if js_trim(source).is_empty() {
        return Some(PatternProblem::Empty);
    }
    if utf16_len(source) > REDACTION_PATTERN_MAX {
        return Some(PatternProblem::TooLong);
    }
    let chars: Vec<char> = source.chars().collect();
    let Some(regex) = compile(source) else {
        return Some(match structure_problem(&chars) {
            Some(problem @ (PatternProblem::Lookaround | PatternProblem::Backreference)) => problem,
            _ => PatternProblem::Invalid,
        });
    };
    if let Some(problem) = structure_problem(&chars) {
        return Some(problem);
    }
    regex.is_match("").then_some(PatternProblem::MatchesEmpty)
}

pub fn compile_patterns(patterns: &[String]) -> Vec<Regex> {
    patterns
        .iter()
        .take(REDACTION_PATTERNS_MAX)
        .filter(|source| pattern_problem(source).is_none())
        .filter_map(|source| compile(source))
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SecretSpan {
    pub start: usize,
    pub end: usize,
    pub kind: String,
}

fn advance_units(text: &str, from: usize, units: usize) -> usize {
    let mut used = 0;
    for (offset, ch) in text[from..].char_indices() {
        if used >= units {
            return from + offset;
        }
        used += ch.len_utf16();
    }
    text.len()
}

pub fn custom_spans(text: &str, regexes: &[Regex]) -> Vec<SecretSpan> {
    let mut spans = Vec::new();
    if regexes.is_empty() {
        return spans;
    }
    let mut line_start = 0;
    while line_start < text.len() {
        let line_end = text[line_start..]
            .find('\n')
            .map_or(text.len(), |offset| line_start + offset);
        let mut at = line_start;
        while at < line_end {
            let piece_end = advance_units(&text[..line_end], at, CUSTOM_WINDOW).min(line_end);
            let piece = &text[at..piece_end];
            for regex in regexes {
                for found in regex.find_iter(piece) {
                    if found.as_str().is_empty() {
                        continue;
                    }
                    spans.push(SecretSpan {
                        start: at + found.start(),
                        end: at + found.end(),
                        kind: CUSTOM_KIND.to_owned(),
                    });
                }
            }
            if piece_end == line_end {
                break;
            }
            at = advance_units(&text[..line_end], at, CUSTOM_WINDOW_STEP);
        }
        line_start = line_end + 1;
    }
    spans
}

fn case_insensitive(word: &str) -> String {
    word.chars()
        .map(|ch| {
            if ch.is_ascii_alphabetic() {
                format!("[{}{}]", ch.to_ascii_lowercase(), ch.to_ascii_uppercase())
            } else {
                ch.to_string()
            }
        })
        .collect()
}

fn secret_name() -> String {
    let word = case_insensitive;
    format!(
        "(?:{}|{}|{}{}{}|{}|{}[_-]?{}|{}[_-]?{}|{}[_-]?{}|{})[A-Za-z0-9_-]{{0,32}}",
        word("secret"),
        word("token"),
        word("passw"),
        format_args!("(?:{})?", word("or")),
        word("d"),
        word("pwd"),
        word("api"),
        word("key"),
        word("access"),
        word("key"),
        word("private"),
        word("key"),
        word("credential"),
    )
}

struct ExtraDetector {
    kind: &'static str,
    pattern: Regex,
    boundary: Boundary,
    accepts_value: bool,
}

#[derive(Clone, Copy)]
enum Boundary {
    None,
    NotAfterTokenChar,
    NotAroundTokenChar,
}

fn is_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'
}

static EXTRA_DETECTORS: LazyLock<Vec<ExtraDetector>> = LazyLock::new(|| {
    let name = secret_name();
    let space = format!("[{JS_SPACE_CLASS}]");
    let line_unsafe = r"\x00-\x1f";
    vec![
        ExtraDetector {
            kind: "jwt",
            pattern: static_regex(
                r"(eyJ[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{16,1024})",
            ),
            boundary: Boundary::NotAfterTokenChar,
            accepts_value: false,
        },
        ExtraDetector {
            kind: "google-api-key",
            pattern: static_regex(r"(AIza[A-Za-z0-9_-]{35})"),
            boundary: Boundary::NotAroundTokenChar,
            accepts_value: false,
        },
        ExtraDetector {
            kind: "authorization",
            pattern: static_regex(&format!(
                "{}[\"']?{space}{{0,3}}[:=]{space}{{0,3}}[\"']?(?:{}|{}|{}){space}{{1,3}}([A-Za-z0-9._~+/=-]{{8,4096}})",
                case_insensitive("authorization"),
                case_insensitive("bearer"),
                case_insensitive("basic"),
                case_insensitive("token"),
            )),
            boundary: Boundary::None,
            accepts_value: false,
        },
        ExtraDetector {
            kind: "assignment",
            pattern: static_regex(&format!(
                "{name}=([^{JS_SPACE_CLASS}\"'`$<>(){{}}\\[\\],;&|\\\\{line_unsafe}][^{JS_SPACE_CLASS}\"'`,;&|<>(){line_unsafe}]{{5,255}})"
            )),
            boundary: Boundary::None,
            accepts_value: true,
        },
        ExtraDetector {
            kind: "assignment",
            pattern: static_regex(&format!(
                "{name}[\"']?{space}{{0,3}}[:=]{space}{{0,3}}\"([^\"\\\\{line_unsafe}]{{4,256}})\""
            )),
            boundary: Boundary::None,
            accepts_value: true,
        },
        ExtraDetector {
            kind: "assignment",
            pattern: static_regex(&format!(
                "{name}[\"']?{space}{{0,3}}[:=]{space}{{0,3}}'([^'\\\\{line_unsafe}]{{4,256}})'"
            )),
            boundary: Boundary::None,
            accepts_value: true,
        },
    ]
});

const NOT_A_VALUE: [&str; 8] = [
    "true",
    "false",
    "null",
    "none",
    "undefined",
    "string",
    "bearer",
    "basic",
];

fn looks_like_value(value: &str) -> bool {
    let lower = value.to_lowercase();
    !NOT_A_VALUE.contains(&lower.as_str()) && !value.chars().all(|ch| ch.is_ascii_digit())
}

pub fn extra_kinds() -> Vec<&'static str> {
    let mut seen = HashSet::new();
    EXTRA_DETECTORS
        .iter()
        .map(|detector| detector.kind)
        .filter(|kind| seen.insert(*kind))
        .collect()
}

fn boundary_holds(text: &str, start: usize, end: usize, boundary: Boundary) -> bool {
    let before_ok = || !text[..start].chars().next_back().is_some_and(is_token_char);
    let after_ok = || !text[end..].chars().next().is_some_and(is_token_char);
    match boundary {
        Boundary::None => true,
        Boundary::NotAfterTokenChar => before_ok(),
        Boundary::NotAroundTokenChar => before_ok() && after_ok(),
    }
}

fn next_boundary(text: &str, from: usize) -> usize {
    from + text[from..].chars().next().map_or(1, char::len_utf8)
}

fn bounded_captures<'t>(detector: &ExtraDetector, text: &'t str) -> Vec<regex::Captures<'t>> {
    let mut found = Vec::new();
    let mut at = 0;
    while at <= text.len() {
        let Some(captures) = detector.pattern.captures_at(text, at) else {
            break;
        };
        let Some(whole) = captures.get(0) else {
            break;
        };
        if boundary_holds(text, whole.start(), whole.end(), detector.boundary) {
            at = if whole.is_empty() {
                next_boundary(text, whole.end())
            } else {
                whole.end()
            };
            found.push(captures);
        } else {
            at = next_boundary(text, whole.start());
        }
    }
    found
}

pub fn extra_spans(text: &str) -> Vec<SecretSpan> {
    let mut spans = Vec::new();
    for detector in EXTRA_DETECTORS.iter() {
        for captures in bounded_captures(detector, text) {
            let Some(value) = captures.get(1) else {
                continue;
            };
            if value.is_empty() || (detector.accepts_value && !looks_like_value(value.as_str())) {
                continue;
            }
            spans.push(SecretSpan {
                start: value.start(),
                end: value.end(),
                kind: detector.kind.to_owned(),
            });
        }
    }
    spans
}

static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"\[redacted:[a-z0-9][a-z0-9-]{0,47}\]"));

pub fn placeholder_for(kind: &str) -> String {
    format!("[redacted:{kind}]")
}

pub fn count_placeholders(text: &str) -> usize {
    PLACEHOLDER.find_iter(text).count()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RedactionResult {
    pub text: String,
    pub count: usize,
    pub kinds: Map<String, Value>,
}

pub fn unchanged(text: &str) -> RedactionResult {
    RedactionResult {
        text: text.to_owned(),
        count: 0,
        kinds: Map::new(),
    }
}

fn outside_placeholders(text: &str, spans: &[SecretSpan]) -> Vec<SecretSpan> {
    let holes: Vec<(usize, usize)> = PLACEHOLDER
        .find_iter(text)
        .map(|hole| (hole.start(), hole.end()))
        .collect();
    if holes.is_empty() {
        return spans.to_vec();
    }
    let mut out = Vec::new();
    for span in spans {
        let mut start = span.start;
        for (hole_start, hole_end) in &holes {
            if *hole_end <= start {
                continue;
            }
            if *hole_start >= span.end {
                break;
            }
            if *hole_start > start {
                out.push(SecretSpan {
                    start,
                    end: *hole_start,
                    kind: span.kind.clone(),
                });
            }
            start = start.max(*hole_end);
        }
        if start < span.end {
            out.push(SecretSpan {
                start,
                end: span.end,
                kind: span.kind.clone(),
            });
        }
    }
    out
}

pub fn apply_redactions(text: &str, found: &[SecretSpan]) -> RedactionResult {
    let inside: Vec<SecretSpan> = found
        .iter()
        .filter(|span| span.end <= text.len() && span.start < span.end)
        .filter(|span| text.is_char_boundary(span.start) && text.is_char_boundary(span.end))
        .cloned()
        .collect();
    let mut spans = outside_placeholders(text, &inside);
    spans.sort_by(|left, right| left.start.cmp(&right.start).then(right.end.cmp(&left.end)));
    if spans.is_empty() {
        return unchanged(text);
    }
    let mut merged: Vec<SecretSpan> = Vec::new();
    for span in spans {
        match merged.last_mut() {
            Some(last) if span.start < last.end => last.end = last.end.max(span.end),
            _ => merged.push(span),
        }
    }
    let mut kinds: Map<String, Value> = Map::new();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for span in &merged {
        out.push_str(&text[at..span.start]);
        out.push_str(&placeholder_for(&span.kind));
        at = span.end;
        let seen = kinds.get(&span.kind).and_then(Value::as_u64).unwrap_or(0);
        kinds.insert(span.kind.clone(), Value::from(seen + 1));
    }
    out.push_str(&text[at..]);
    RedactionResult {
        text: out,
        count: merged.len(),
        kinds,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RedactionKindSource {
    Library,
    Ostia,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RedactionKindInfo {
    pub kind: String,
    pub source: RedactionKindSource,
    pub detects: Vec<String>,
}
