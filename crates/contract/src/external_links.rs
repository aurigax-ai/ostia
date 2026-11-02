use std::sync::LazyLock;

use ostia_base::js::{JS_DOT, JS_SPACE_CLASS, static_regex, utf16_len};
use regex::Regex;
use url::Url;

const PREVIEW_SCHEME: &str = "ostia-preview";

const BROWSER_SCHEMES: [&str; 2] = ["http", "https"];
const SYSTEM_SCHEMES: [&str; 1] = ["mailto"];
const APP_SCHEMES: [&str; 3] = ["obsidian", "vscode", "vscode-insiders"];
const BLOCKED_SCHEMES: [&str; 27] = [
    "javascript",
    "data",
    "vbscript",
    "blob",
    "about",
    "chrome-extension",
    "chrome-untrusted",
    "devtools",
    "view-source",
    "filesystem",
    "file",
    "ostia",
    PREVIEW_SCHEME,
    "remote",
    "untitled",
    "app",
    "smb",
    "cifs",
    "afp",
    "nfs",
    "ftp",
    "ftps",
    "dav",
    "davs",
    "webdav",
    "search",
    "search-ms",
];

const SCHEME: &str = r"[A-Za-z][A-Za-z0-9+.\-]+://";
const TRAILING: [char; 8] = ['.', ',', ';', ':', '!', '?', '\'', '"'];

static BRACKETED: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"<({SCHEME}[^<>\r\n]+)>")));
static PLAIN: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"{SCHEME}[^{JS_SPACE_CLASS}<>\x22\x27\x60\x{{3000}}-\x{{303f}}\x{{ff00}}-\x{{ffef}}]+"
    ))
});
static SCHEME_THEN_CHAR: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r":\/\/{JS_DOT}")));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkKind {
    Browser,
    External,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppLinkMatch {
    pub start: usize,
    pub end: usize,
    pub url: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserPage {
    Chrome,
    Edge,
    Brave,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExternalLinkPolicy {
    pub apps: bool,
}

fn has_scheme_format(scheme: &str) -> bool {
    let bytes = scheme.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'+' | b'.' | b'-')
        })
}

fn is_app_link(url: &Url) -> bool {
    let scheme = url.scheme();
    if BLOCKED_SCHEMES.contains(&scheme) || scheme.starts_with("ms-") || !has_scheme_format(scheme)
    {
        return false;
    }
    if APP_SCHEMES.contains(&scheme) {
        return true;
    }
    url.as_str().starts_with(&format!("{scheme}://"))
        && url.password().is_none_or(|password| password.is_empty())
}

pub fn browser_page_of(url: &str) -> Option<BrowserPage> {
    let parsed = Url::parse(url).ok()?;
    if !is_app_link(&parsed) {
        return None;
    }
    match parsed.scheme() {
        "chrome" => Some(BrowserPage::Chrome),
        "edge" => Some(BrowserPage::Edge),
        "brave" => Some(BrowserPage::Brave),
        _ => None,
    }
}

pub fn app_link_scheme(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let scheme = parsed.scheme();
    if BROWSER_SCHEMES.contains(&scheme) || SYSTEM_SCHEMES.contains(&scheme) {
        return None;
    }
    is_app_link(&parsed).then(|| scheme.to_owned())
}

pub fn external_href(url: &str, policy: ExternalLinkPolicy) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let scheme = parsed.scheme();
    let allowed = BROWSER_SCHEMES.contains(&scheme)
        || SYSTEM_SCHEMES.contains(&scheme)
        || (policy.apps && is_app_link(&parsed));
    allowed.then(|| parsed.as_str().to_owned())
}

pub fn link_kind(url: &str) -> Option<LinkKind> {
    let parsed = Url::parse(url).ok()?;
    let scheme = parsed.scheme();
    if BROWSER_SCHEMES.contains(&scheme) {
        return Some(LinkKind::Browser);
    }
    (SYSTEM_SCHEMES.contains(&scheme) || is_app_link(&parsed)).then_some(LinkKind::External)
}

fn opener(closer: char) -> Option<char> {
    match closer {
        ')' => Some('('),
        ']' => Some('['),
        _ => None,
    }
}

fn balanced(url: &str) -> &str {
    let mut counts = [0usize; 4];
    let slot = |ch: char| match ch {
        '(' => Some(0),
        ')' => Some(1),
        '[' => Some(2),
        ']' => Some(3),
        _ => None,
    };
    for ch in url.chars() {
        if let Some(index) = slot(ch) {
            counts[index] += 1;
        }
    }
    let mut end = url.len();
    while let Some(ch) = url[..end].chars().next_back() {
        let wanted = opener(ch).and_then(slot);
        let closing = slot(ch);
        if TRAILING.contains(&ch) {
            end -= ch.len_utf8();
        } else if let (Some(wanted), Some(closing)) = (wanted, closing)
            && counts[closing] > counts[wanted]
        {
            counts[closing] -= 1;
            end -= ch.len_utf8();
        } else {
            break;
        }
    }
    &url[..end]
}

fn follows_link_character(text: &str, start: usize) -> bool {
    text[..start].chars().next_back().is_some_and(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '_' | '+' | '.' | ':' | '/' | '-')
    })
}

fn plain_matches(text: &str) -> Vec<(usize, &str)> {
    let mut found = Vec::new();
    let mut at = 0;
    while at <= text.len() {
        let Some(hit) = PLAIN.find_at(text, at) else {
            break;
        };
        if follows_link_character(text, hit.start()) {
            let step = text[hit.start()..].chars().next().map_or(1, char::len_utf8);
            at = hit.start() + step;
            continue;
        }
        found.push((hit.start(), hit.as_str()));
        at = hit.end().max(hit.start() + 1);
    }
    found
}

pub fn find_scheme_links(text: &str, accepts: &dyn Fn(&str) -> bool) -> Vec<AppLinkMatch> {
    let mut out: Vec<AppLinkMatch> = Vec::new();
    for caps in BRACKETED.captures_iter(text) {
        let (Some(whole), Some(group)) = (caps.get(0), caps.get(1)) else {
            continue;
        };
        let start = utf16_len(&text[..whole.start()]) + 1;
        if !accepts(group.as_str()) {
            continue;
        }
        out.push(AppLinkMatch {
            start,
            end: start + utf16_len(group.as_str()),
            url: group.as_str().to_owned(),
        });
    }
    let covered = |out: &[AppLinkMatch], start: usize, end: usize| {
        out.iter()
            .any(|link| start < link.end + 1 && end + 1 > link.start)
    };
    for (byte_start, matched) in plain_matches(text) {
        let start = utf16_len(&text[..byte_start]);
        let url = balanced(matched);
        let end = start + utf16_len(url);
        if !SCHEME_THEN_CHAR.is_match(url) || !accepts(url) || covered(&out, start, end) {
            continue;
        }
        out.push(AppLinkMatch {
            start,
            end,
            url: url.to_owned(),
        });
    }
    out.sort_by_key(|link| link.start);
    out
}

pub fn find_app_links(text: &str) -> Vec<AppLinkMatch> {
    find_scheme_links(text, &|url| link_kind(url) == Some(LinkKind::External))
}
