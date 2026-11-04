use ostia_base::js::{JS_DOT, JS_SPACE_CLASS, utf16_len};
use regex::{Regex, RegexBuilder};

const ASCII_WORD_BOUNDARY: &str = r"(?-u:\b)";
const ASCII_NOT_WORD_BOUNDARY: &str = r"(?-u:\B)";
const DIGITS: &str = "0-9";
const WORD: &str = "A-Za-z0-9_";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MatchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

#[derive(Clone, Debug)]
pub struct LineMatcher {
    pattern: Regex,
}

impl LineMatcher {
    pub fn find_all(&self, line: &str) -> Vec<(usize, usize)> {
        let mut ranges = Vec::new();
        let mut byte = 0;
        let mut units = 0;
        for found in self.pattern.find_iter(line) {
            if found.is_empty() {
                continue;
            }
            units += utf16_len(&line[byte..found.start()]);
            let start = units;
            units += utf16_len(found.as_str());
            byte = found.end();
            ranges.push((start, units));
        }
        ranges
    }
}

fn class_escape(letter: char, in_class: bool) -> Option<String> {
    let space = JS_SPACE_CLASS;
    let text = match (letter, in_class) {
        ('d', false) => format!("[{DIGITS}]"),
        ('D', _) => format!("[^{DIGITS}]"),
        ('w', false) => format!("[{WORD}]"),
        ('W', _) => format!("[^{WORD}]"),
        ('s', false) => format!("[{space}]"),
        ('S', _) => format!("[^{space}]"),
        ('d', true) => DIGITS.to_owned(),
        ('w', true) => WORD.to_owned(),
        ('s', true) => space.to_owned(),
        ('b', true) => r"\x08".to_owned(),
        ('b', false) => ASCII_WORD_BOUNDARY.to_owned(),
        ('B', false) => ASCII_NOT_WORD_BOUNDARY.to_owned(),
        _ => return None,
    };
    Some(text)
}

fn js_pattern(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut in_class = false;
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => match chars.next() {
                Some(letter) => match class_escape(letter, in_class) {
                    Some(text) => out.push_str(&text),
                    None => {
                        out.push('\\');
                        out.push(letter);
                    }
                },
                None => out.push('\\'),
            },
            '[' if in_class => out.push_str(r"\["),
            '&' | '~' if in_class => {
                out.push('\\');
                out.push(ch);
            }
            '[' => {
                in_class = true;
                match (chars.peek().copied(), chars.clone().nth(1)) {
                    (Some(']'), _) => {
                        chars.next();
                        in_class = false;
                        out.push_str(r"[^\s\S]");
                    }
                    (Some('^'), Some(']')) => {
                        chars.next();
                        chars.next();
                        in_class = false;
                        out.push_str(r"[\s\S]");
                    }
                    _ => out.push('['),
                }
            }
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            '.' if !in_class => out.push_str(JS_DOT),
            other => out.push(other),
        }
    }
    out
}

pub fn text_matcher(query: &str, options: &MatchOptions) -> Option<LineMatcher> {
    if query.is_empty() {
        return None;
    }
    let body = if options.regex {
        js_pattern(query)
    } else {
        regex::escape(query)
    };
    let source = if options.whole_word {
        format!("{ASCII_WORD_BOUNDARY}(?:{body}){ASCII_WORD_BOUNDARY}")
    } else {
        body
    };
    let pattern = RegexBuilder::new(&source)
        .case_insensitive(!options.case_sensitive)
        .build()
        .ok()?;
    Some(LineMatcher { pattern })
}
