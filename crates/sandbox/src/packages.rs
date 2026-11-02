use std::sync::LazyLock;

use ostia_base::js::{JS_DOT, static_regex};
use regex::Regex;
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ecosystem {
    Npm,
    PyPi,
    CratesIo,
    Go,
}

impl Ecosystem {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::PyPi => "PyPI",
            Self::CratesIo => "crates.io",
            Self::Go => "Go",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageRef {
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
}

pub const REGISTRY_HOSTS: [&str; 5] = [
    "registry.npmjs.org",
    "files.pythonhosted.org",
    "static.crates.io",
    "crates.io",
    "proxy.golang.org",
];

static NPM_PATH: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^/((?:@[^/]+/)?[^/]+)/-/({JS_DOT}+)\.tgz$")));
static PYPI_WHEEL: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^([^-]+)-([^-]+)-{JS_DOT}+\.whl$")));
static PYPI_SDIST: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^({JS_DOT}+?)-([0-9][^-]*)\.(?:tar\.gz|zip|tar\.bz2)$"
    ))
});
static CRATES_API: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^/api/v1/crates/([^/]+)/([^/]+)/download$"));
static GO_PATH: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^/({JS_DOT}+)/@v/({JS_DOT}+)\.zip$")));
static PYPI_SEPARATORS: LazyLock<Regex> = LazyLock::new(|| static_regex(r"[-_.]+"));
static GO_ESCAPE: LazyLock<Regex> = LazyLock::new(|| static_regex(r"!([a-z])"));

fn pypi_name(raw: &str) -> String {
    PYPI_SEPARATORS
        .replace_all(&raw.to_lowercase(), "-")
        .into_owned()
}

fn go_module(escaped: &str) -> String {
    GO_ESCAPE
        .replace_all(escaped, |caps: &regex::Captures<'_>| caps[1].to_uppercase())
        .into_owned()
}

fn is_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MalformedDownloadPath;

impl std::fmt::Display for MalformedDownloadPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the registry URL path has a bad percent escape")
    }
}

impl std::error::Error for MalformedDownloadPath {}

fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes.get(index + 1..index + 3)?;
            if !pair.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    percent_encoding::percent_decode_str(text)
        .decode_utf8()
        .ok()
        .map(std::borrow::Cow::into_owned)
}

pub fn package_key(pkg: &PackageRef) -> String {
    format!("{}:{}", pkg.ecosystem.as_str(), pkg.name)
}

pub fn package_version_key(pkg: &PackageRef) -> String {
    format!("{}@{}", package_key(pkg), pkg.version)
}

fn npm_download(path: &str) -> Option<PackageRef> {
    let caps = NPM_PATH.captures(path)?;
    let name = caps[1].to_owned();
    let base = name.split_once('/').map_or(name.as_str(), |(_, rest)| rest);
    let version = caps[2].strip_prefix(base)?.strip_prefix('-')?.to_owned();
    Some(PackageRef {
        ecosystem: Ecosystem::Npm,
        name,
        version,
    })
}

fn pypi_download(path: &str) -> Option<PackageRef> {
    let file = path.rsplit('/').next().unwrap_or("");
    if let Some(caps) = PYPI_WHEEL.captures(file) {
        return Some(PackageRef {
            ecosystem: Ecosystem::PyPi,
            name: pypi_name(&caps[1]),
            version: caps[2].to_owned(),
        });
    }
    let caps = PYPI_SDIST.captures(file)?;
    Some(PackageRef {
        ecosystem: Ecosystem::PyPi,
        name: pypi_name(&caps[1]),
        version: caps[2].to_owned(),
    })
}

fn static_crate_download(path: &str) -> Option<PackageRef> {
    let rest = path.strip_prefix("/crates/")?;
    let (name, file) = rest.split_once('/')?;
    if name.is_empty() {
        return None;
    }
    let version = file
        .strip_prefix(name)?
        .strip_prefix('-')?
        .strip_suffix(".crate")?;
    if version.is_empty() || version.chars().any(is_line_terminator) {
        return None;
    }
    Some(PackageRef {
        ecosystem: Ecosystem::CratesIo,
        name: name.to_owned(),
        version: version.to_owned(),
    })
}

fn crates_api_download(path: &str) -> Option<PackageRef> {
    let caps = CRATES_API.captures(path)?;
    Some(PackageRef {
        ecosystem: Ecosystem::CratesIo,
        name: caps[1].to_owned(),
        version: caps[2].to_owned(),
    })
}

fn go_download(path: &str) -> Option<PackageRef> {
    let caps = GO_PATH.captures(path)?;
    Some(PackageRef {
        ecosystem: Ecosystem::Go,
        name: go_module(&caps[1]),
        version: caps[2].to_owned(),
    })
}

pub fn parse_package_download(raw: &str) -> Result<Option<PackageRef>, MalformedDownloadPath> {
    let Ok(url) = Url::parse(raw) else {
        return Ok(None);
    };
    let path = decode_uri_component(url.path()).ok_or(MalformedDownloadPath)?;
    Ok(match url.host_str() {
        Some("registry.npmjs.org") => npm_download(&path),
        Some("files.pythonhosted.org") => pypi_download(&path),
        Some("static.crates.io") => static_crate_download(&path),
        Some("crates.io") => crates_api_download(&path),
        Some("proxy.golang.org") => go_download(&path),
        _ => None,
    })
}
