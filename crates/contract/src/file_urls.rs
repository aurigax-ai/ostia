use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;
use url::Url;

use crate::external_links::{AppLinkMatch, find_scheme_links};
use crate::file_links::resolve_link_path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileUrlOpener {
    HtmlPage,
    DefaultApp,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileUrlTarget {
    pub path: String,
    pub opener: FileUrlOpener,
}

const PAGE_EXTENSIONS: [&str; 2] = ["html", "htm"];
const APP_EXTENSIONS: [&str; 15] = [
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "drawio", "md", "txt", "csv", "json",
    "docx", "xlsx", "pptx",
];

static LOCAL_SUFFIX: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\.local$"));

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decoded(pathname: &str) -> Option<String> {
    let bytes = pathname.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let high = hex_value(*bytes.get(i + 1)?)?;
        let low = hex_value(*bytes.get(i + 2)?)?;
        out.push(high * 16 + low);
        i += 3;
    }
    String::from_utf8(out).ok()
}

fn bare_host(name: &str) -> String {
    LOCAL_SUFFIX.replace(&name.to_lowercase(), "").into_owned()
}

pub fn is_local_host(host: &str, hostname: &str) -> bool {
    if host.is_empty() || host == "localhost" {
        return true;
    }
    !hostname.is_empty() && bare_host(host) == bare_host(hostname)
}

pub fn file_url_path(url: &str, accepts_host: &dyn Fn(&str) -> bool) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "file" || !accepts_host(parsed.host_str().unwrap_or("")) {
        return None;
    }
    let path = decoded(parsed.path())?;
    if !path.starts_with('/') || path.contains('\0') {
        return None;
    }
    Some(resolve_link_path(&path, "/"))
}

pub fn file_url_opener(path: &str) -> Option<FileUrlOpener> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let dot = name.rfind('.')?;
    if dot == 0 {
        return None;
    }
    let extension = name[dot + 1..].to_lowercase();
    if PAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Some(FileUrlOpener::HtmlPage);
    }
    APP_EXTENSIONS
        .contains(&extension.as_str())
        .then_some(FileUrlOpener::DefaultApp)
}

pub fn opens_file_url(url: &str) -> bool {
    file_url_path(url, &|_| true).is_some_and(|path| file_url_opener(&path).is_some())
}

pub fn find_file_urls(text: &str) -> Vec<AppLinkMatch> {
    find_scheme_links(text, &opens_file_url)
}
