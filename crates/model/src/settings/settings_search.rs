use ostia_base::js::{js_trim, utf16_len};
use regex::{Regex, RegexBuilder};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HighlightPart {
    pub text: String,
    pub at: usize,
    pub is_match: bool,
}

fn query_pattern(query: &str) -> Option<Regex> {
    let trimmed = js_trim(query);
    if trimmed.is_empty() {
        return None;
    }
    RegexBuilder::new(&regex::escape(trimmed))
        .case_insensitive(true)
        .build()
        .ok()
}

pub fn matches_query(texts: &[Option<&str>], query: &str) -> bool {
    let Some(pattern) = query_pattern(query) else {
        return false;
    };
    texts
        .iter()
        .flatten()
        .any(|text| !text.is_empty() && pattern.is_match(text))
}

pub fn highlight_parts(text: &str, query: &str) -> Vec<HighlightPart> {
    let whole = |text: &str| {
        vec![HighlightPart {
            text: text.to_owned(),
            at: 0,
            is_match: false,
        }]
    };
    let Some(pattern) = query_pattern(query) else {
        return if text.is_empty() {
            Vec::new()
        } else {
            whole(text)
        };
    };
    if text.is_empty() {
        return Vec::new();
    }
    let mut parts = Vec::new();
    let mut cursor_byte = 0;
    let mut cursor_unit = 0;
    for found in pattern.find_iter(text) {
        if found.start() > cursor_byte {
            let gap = &text[cursor_byte..found.start()];
            parts.push(HighlightPart {
                text: gap.to_owned(),
                at: cursor_unit,
                is_match: false,
            });
            cursor_unit += utf16_len(gap);
        }
        parts.push(HighlightPart {
            text: found.as_str().to_owned(),
            at: cursor_unit,
            is_match: true,
        });
        cursor_unit += utf16_len(found.as_str());
        cursor_byte = found.end();
    }
    if cursor_byte < text.len() {
        parts.push(HighlightPart {
            text: text[cursor_byte..].to_owned(),
            at: cursor_unit,
            is_match: false,
        });
    }
    parts
}
