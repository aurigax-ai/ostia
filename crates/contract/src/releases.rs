use std::cmp::Ordering;
use std::sync::LazyLock;

use ostia_base::PRODUCT_NAME;
use ostia_base::js::{static_regex, utf16_len};
use regex::Regex;
use serde_json::Value;
use url::Url;

pub const RELEASE_OWNER: &str = "aurigax-ai";
pub const RELEASE_NAME: &str = "ostia";
pub const RELEASE_API_BASE_URL: &str = "https://api.github.com";

const VERSION_MAX_CHARS: usize = 64;

static VERSION: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(
        r"^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$",
    )
});
static SHA256_DIGEST: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^sha256:([0-9a-f]{64})$"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateChannel {
    Stable,
    Beta,
    Main,
}

pub type AssetName = fn(&str) -> String;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub prerelease: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseInfo {
    pub version: String,
    pub url: String,
    pub dmg_sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParsedRelease {
    Release(ReleaseInfo),
    NotStable,
    Malformed,
}

pub fn dmg_asset_name(version: &str) -> String {
    format!("{PRODUCT_NAME}-{version}-arm64.dmg")
}

pub fn tarball_asset_name(version: &str) -> String {
    format!("{PRODUCT_NAME}-{version}-linux-x64.tar.gz")
}

pub fn parse_version(text: &str) -> Option<Version> {
    if utf16_len(text) > VERSION_MAX_CHARS {
        return None;
    }
    let captures = VERSION.captures(text)?;
    let number = |index: usize| captures.get(index)?.as_str().parse::<u64>().ok();
    Some(Version {
        major: number(1)?,
        minor: number(2)?,
        patch: number(3)?,
        prerelease: captures.get(4).map_or_else(Vec::new, |parts| {
            parts.as_str().split('.').map(str::to_owned).collect()
        }),
    })
}

fn is_numeric(part: &str) -> bool {
    !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
}

fn compare_prerelease_part(a: &str, b: &str) -> Ordering {
    let numeric = is_numeric(a);
    if numeric != is_numeric(b) {
        return if numeric {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    if numeric && a.len() != b.len() {
        return a.len().cmp(&b.len());
    }
    a.cmp(b)
}

fn compare_prerelease(a: &[String], b: &[String]) -> Ordering {
    if a.is_empty() || b.is_empty() {
        return b.len().cmp(&a.len());
    }
    for (left, right) in a.iter().zip(b) {
        let order = compare_prerelease_part(left, right);
        if order != Ordering::Equal {
            return order;
        }
    }
    a.len().cmp(&b.len())
}

pub fn compare_versions(a: &Version, b: &Version) -> Ordering {
    a.major
        .cmp(&b.major)
        .then(a.minor.cmp(&b.minor))
        .then(a.patch.cmp(&b.patch))
        .then_with(|| compare_prerelease(&a.prerelease, &b.prerelease))
}

pub fn is_newer_version(candidate: &str, current: &str) -> bool {
    parse_version(candidate)
        .zip(parse_version(current))
        .is_some_and(|(a, b)| compare_versions(&a, &b).is_gt())
}

fn release_page_url(page: &str, tag: &str) -> Option<String> {
    let url = Url::parse(page).ok()?;
    let trusted = url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().unwrap_or("").is_empty()
        && url.query().unwrap_or("").is_empty()
        && url.fragment().unwrap_or("").is_empty()
        && url.path() == format!("/{RELEASE_OWNER}/{RELEASE_NAME}/releases/tag/{tag}");
    trusted.then(|| url.as_str().to_owned())
}

struct ParsedEntry {
    text: String,
    version: Version,
    url: String,
    stable: bool,
    draft: bool,
    flagged: bool,
    dmg_sha256: Option<String>,
    asset_names: Vec<String>,
}

fn asset_names(assets: &[Value]) -> Vec<String> {
    assets
        .iter()
        .filter_map(|asset| asset.get("name")?.as_str().map(str::to_owned))
        .collect()
}

fn dmg_sha256(assets: &[Value], text: &str) -> Option<String> {
    let name = dmg_asset_name(text);
    let asset = assets
        .iter()
        .find(|asset| asset.get("name").and_then(Value::as_str) == Some(name.as_str()))?;
    let digest = asset.get("digest").and_then(Value::as_str)?;
    SHA256_DIGEST
        .captures(digest)?
        .get(1)
        .map(|hex| hex.as_str().to_owned())
}

fn parse_entry(raw: &Value) -> Option<ParsedEntry> {
    let object = raw.as_object()?;
    let tag = object.get("tag_name")?.as_str()?;
    let draft = object.get("draft")?.as_bool()?;
    let prerelease = object.get("prerelease")?.as_bool()?;
    let text = tag.strip_prefix('v').unwrap_or(tag);
    let version = parse_version(text)?;
    let page = object.get("html_url")?.as_str()?;
    let url = release_page_url(page, tag)?;
    let assets = object
        .get("assets")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let plain = version.prerelease.is_empty() && !text.contains('+');
    Some(ParsedEntry {
        text: text.to_owned(),
        version,
        url,
        stable: plain && !prerelease,
        draft,
        flagged: prerelease,
        dmg_sha256: dmg_sha256(assets, text),
        asset_names: asset_names(assets),
    })
}

fn release_info(entry: &ParsedEntry) -> ReleaseInfo {
    ReleaseInfo {
        version: entry.text.clone(),
        url: entry.url.clone(),
        dmg_sha256: entry.dmg_sha256.clone(),
    }
}

fn is_numbered_prerelease(version: &Version, kinds: &[&str]) -> bool {
    matches!(
        version.prerelease.as_slice(),
        [kind, number] if kinds.contains(&kind.as_str()) && is_numeric(number)
    )
}

pub fn is_main_channel_version(version: &Version) -> bool {
    is_numbered_prerelease(version, &["main", "rc"])
}

fn is_beta_channel_version(version: &Version) -> bool {
    is_numbered_prerelease(version, &["rc"])
}

pub fn parse_latest_release(raw: &Value) -> ParsedRelease {
    let Some(entry) = parse_entry(raw) else {
        return ParsedRelease::Malformed;
    };
    if entry.draft || !entry.stable {
        return ParsedRelease::NotStable;
    }
    ParsedRelease::Release(release_info(&entry))
}

fn offered_on_main(entry: &ParsedEntry) -> bool {
    if entry.draft {
        return false;
    }
    if entry.stable {
        return true;
    }
    entry.flagged && !entry.text.contains('+') && is_main_channel_version(&entry.version)
}

fn offered_on_beta(entry: &ParsedEntry, asset: AssetName) -> bool {
    if entry.draft || !entry.asset_names.contains(&asset(&entry.text)) {
        return false;
    }
    if entry.stable {
        return true;
    }
    entry.flagged && !entry.text.contains('+') && is_beta_channel_version(&entry.version)
}

fn pick_highest(raw: &Value, offered: impl Fn(&ParsedEntry) -> bool) -> ParsedRelease {
    let Some(items) = raw.as_array() else {
        return ParsedRelease::Malformed;
    };
    let mut best: Option<ParsedEntry> = None;
    for item in items {
        let Some(entry) = parse_entry(item) else {
            continue;
        };
        if !offered(&entry) {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|current| compare_versions(&entry.version, &current.version).is_gt())
        {
            best = Some(entry);
        }
    }
    best.map_or(ParsedRelease::NotStable, |entry| {
        ParsedRelease::Release(release_info(&entry))
    })
}

pub fn pick_main_channel_release(raw: &Value) -> ParsedRelease {
    pick_highest(raw, offered_on_main)
}

pub fn pick_beta_release(raw: &Value, asset: AssetName) -> ParsedRelease {
    pick_highest(raw, |entry| offered_on_beta(entry, asset))
}

pub fn parse_update_channel(raw: &Value) -> UpdateChannel {
    match raw.as_str() {
        Some("main") => UpdateChannel::Main,
        Some("beta") => UpdateChannel::Beta,
        _ => UpdateChannel::Stable,
    }
}
