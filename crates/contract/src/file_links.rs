use std::sync::LazyLock;

use ostia_base::js::{JS_SPACE_CLASS, js_number, static_regex, utf16_len};
use regex::Regex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileLinkMatch {
    pub start: usize,
    pub end: usize,
    pub path: String,
    pub line: Option<u64>,
    pub column: Option<u64>,
}

const PATH_CHARS: &str = r"[A-Za-z0-9_.@+\-~/]";
const PATH_END: &str = r"[A-Za-z0-9_@+\-]";

static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    let path = format!(r"(?:~/|\.{{1,2}}/|/)?(?:{PATH_CHARS}+/)*{PATH_CHARS}*{PATH_END}");
    let quoted = format!(r#""(?P<qpath>{path})", line (?P<qline>[0-9]+)"#);
    let plain = format!(
        r"(?P<path>{path})(?::(?P<line>[0-9]+)(?::(?P<col>[0-9]+))?|\((?P<pline>[0-9]+)(?:,[{JS_SPACE_CLASS}]?(?P<pcol>[0-9]+))?\))?"
    );
    static_regex(&format!("{quoted}|{plain}"))
});

static PATH_BODY: LazyLock<Regex> = LazyLock::new(|| static_regex(r"[A-Za-z0-9_@+\-]"));
static EXTENSION: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"\.[A-Za-z][A-Za-z0-9_\-]{0,9}$"));
static URL_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"[A-Za-z][A-Za-z0-9_+.\-]*://[^{JS_SPACE_CLASS}]*$"
    ))
});

fn looks_like_path(path: &str) -> bool {
    if path.contains('/') {
        let stripped: String = path
            .chars()
            .filter(|ch| !matches!(ch, '~' | '.' | '/'))
            .collect();
        return PATH_BODY.is_match(&stripped);
    }
    EXTENSION.is_match(path)
        && !path.starts_with(|ch: char| ch.is_ascii_digit())
        && !path.contains('@')
}

fn is_url_context(text: &str, start: usize) -> bool {
    URL_PREFIX.is_match(&text[..start]) || text[start..].starts_with("//")
}

fn positive(value: Option<&str>) -> Option<u64> {
    let number = js_number(value?);
    (number > 0.0).then_some(number as u64)
}

pub fn find_file_links(text: &str) -> Vec<FileLinkMatch> {
    let mut out = Vec::new();
    for caps in PATTERN.captures_iter(text) {
        let Some(whole) = caps.get(0) else {
            continue;
        };
        let start = whole.start();
        if let Some(qpath) = caps.name("qpath") {
            let from = utf16_len(&text[..start]) + 1;
            out.push(FileLinkMatch {
                start: from,
                end: from + utf16_len(qpath.as_str()),
                path: qpath.as_str().to_owned(),
                line: positive(caps.name("qline").map(|group| group.as_str())),
                column: None,
            });
            continue;
        }
        let Some(path) = caps.name("path").map(|group| group.as_str()) else {
            continue;
        };
        let after_word = text[..start]
            .chars()
            .next_back()
            .is_some_and(|prev| prev.is_ascii_alphanumeric() || matches!(prev, '_' | '@'));
        if after_word || !looks_like_path(path) || is_url_context(text, start) {
            continue;
        }
        let from = utf16_len(&text[..start]);
        let group = |first: &str, second: &str| {
            positive(
                caps.name(first)
                    .or_else(|| caps.name(second))
                    .map(|found| found.as_str()),
            )
        };
        out.push(FileLinkMatch {
            start: from,
            end: from + utf16_len(whole.as_str()),
            path: path.to_owned(),
            line: group("line", "pline"),
            column: group("col", "pcol"),
        });
    }
    out
}

fn normalize(path: &str) -> String {
    let home = path == "~" || path.starts_with("~/");
    let body = if home { &path[1..] } else { path };
    let mut parts: Vec<&str> = Vec::new();
    for part in body.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part != ".." {
            parts.push(part);
        } else if parts.last().is_some_and(|last| *last != "..") {
            parts.pop();
        } else if home {
            parts.push(part);
        }
    }
    format!("{}/{}", if home { "~" } else { "" }, parts.join("/"))
}

pub fn resolve_link_path(path: &str, cwd: &str) -> String {
    if path.starts_with("~/") || path.starts_with('/') {
        return normalize(path);
    }
    normalize(&format!("{cwd}/{path}"))
}
