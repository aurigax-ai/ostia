use std::sync::LazyLock;

use ostia_base::js::{is_js_space, js_trim, static_regex, utf16_len};
use regex::{Regex, RegexBuilder};

use crate::pane_history::PaneHistory;
use crate::scrollback_history::{HistoryMatch, HistorySearchResult};

const MATCH_LIMIT: usize = 1000;

static ANSI: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(
        r"[\x1B\x{9B}][\[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z0-9/#&.:=?%@~_]+)*|[a-zA-Z0-9]+(?:;[-a-zA-Z0-9/#&.:=?%@~_]*)*)?(?:\x07|\x1B\\|\x{9C}))|(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]))",
    )
});

pub fn strip_vt_control_characters(text: &str) -> String {
    ANSI.replace_all(text, "").into_owned()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HistorySearchOptions {
    pub case_sensitive: bool,
    pub regex: bool,
    pub whole_word: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

pub struct LineMatcher {
    pattern: Regex,
}

impl LineMatcher {
    pub fn find(&self, text: &str) -> Vec<Span> {
        let mut hits = Vec::new();
        let mut units = 0usize;
        let mut byte = 0usize;
        for found in self.pattern.find_iter(text) {
            if found.as_str().is_empty() {
                continue;
            }
            units += utf16_len(&text[byte..found.start()]);
            let start = units;
            units += utf16_len(found.as_str());
            byte = found.end();
            hits.push(Span { start, end: units });
        }
        hits
    }
}

pub fn line_matcher(query: &str, opts: &HistorySearchOptions) -> Option<LineMatcher> {
    if query.is_empty() {
        return None;
    }
    let source = if opts.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let bounded = if opts.whole_word {
        format!(r"(?-u:\b)(?:{source})(?-u:\b)")
    } else {
        source
    };
    RegexBuilder::new(&bounded)
        .case_insensitive(!opts.case_sensitive)
        .build()
        .ok()
        .map(|pattern| LineMatcher { pattern })
}

pub async fn search_history(
    history: &PaneHistory,
    query: &str,
    opts: &HistorySearchOptions,
    until: u64,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Option<HistorySearchResult> {
    let Some(matcher) = line_matcher(query, opts) else {
        return Some(HistorySearchResult {
            count: 0,
            matches: Vec::new(),
        });
    };
    let mut count = 0u64;
    let mut matches: Vec<HistoryMatch> = Vec::new();
    let mut chunks = history.chunks(history.first(), until);
    while let Some(chunk) = chunks.next().await {
        if cancelled() {
            return None;
        }
        for (index, text) in chunk.lines.iter().enumerate() {
            let line = chunk.first + u64::try_from(index).unwrap_or(u64::MAX);
            if line < history.first() || line >= until {
                continue;
            }
            for hit in matcher.find(&strip_vt_control_characters(text)) {
                count += 1;
                matches.push(HistoryMatch {
                    line,
                    start: hit.start,
                    end: hit.end,
                });
            }
            if matches.len() >= 2 * MATCH_LIMIT {
                matches.drain(..matches.len() - MATCH_LIMIT);
            }
        }
        tokio::task::yield_now().await;
    }
    if cancelled() {
        return None;
    }
    if matches.len() > MATCH_LIMIT {
        matches.drain(..matches.len() - MATCH_LIMIT);
    }
    Some(HistorySearchResult { count, matches })
}

fn first_line(command: &str) -> &str {
    js_trim(command).split('\n').next().unwrap_or("")
}

pub fn same_command(recorded: Option<&str>, asked: &str) -> bool {
    match recorded {
        None => true,
        Some(recorded) => js_trim(asked).is_empty() || first_line(recorded) == first_line(asked),
    }
}

pub fn utf16_prefix(text: &str, units: usize) -> String {
    let mut taken = 0usize;
    let mut out = String::new();
    for ch in text.chars() {
        let width = ch.len_utf16();
        if taken + width > units {
            break;
        }
        taken += width;
        out.push(ch);
    }
    out
}

pub fn utf16_suffix(text: &str, units: usize) -> String {
    let mut taken = 0usize;
    let mut start = text.len();
    for (index, ch) in text.char_indices().rev() {
        let width = ch.len_utf16();
        if taken + width > units {
            break;
        }
        taken += width;
        start = index;
    }
    text[start..].to_string()
}

pub fn output_text(lines: &[String], end_col: Option<usize>) -> String {
    let mut plain: Vec<String> = lines
        .iter()
        .map(|line| strip_vt_control_characters(line))
        .collect();
    if let Some(end_col) = end_col
        && !plain.is_empty()
    {
        let last = plain.len() - 1;
        if end_col > 0 {
            plain[last] = utf16_prefix(&plain[last], end_col);
        } else {
            plain.pop();
        }
    }
    let mut trimmed: Vec<&str> = plain
        .iter()
        .map(|line| line.trim_end_matches(is_js_space))
        .collect();
    while trimmed.last().is_some_and(|line| line.is_empty()) {
        trimmed.pop();
    }
    trimmed.join("\n")
}
