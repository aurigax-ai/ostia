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
