use std::sync::LazyLock;

use ostia_base::host::Host;
use ostia_base::js::{js_trim, static_regex};
use ostia_contract::app_env::env_name;
use regex::Regex;
use url::Url;

const SERVER_URL_ENV: &str = "SERVER_URL";
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];
const GITHUB_HOST: &str = "github.com";
const GITHUB_DEVICE_PATH: &str = "/login/device";

static EXPLICIT_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i)^[a-z][a-z0-9+.-]*://"));

pub fn parse_server_url(text: &str, allow_insecure: bool) -> Option<String> {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return None;
    }
    let url = if EXPLICIT_SCHEME.is_match(trimmed) {
        Url::parse(trimmed)
    } else {
        Url::parse(&format!("https://{trimmed}"))
    }
    .ok()?;
    let has_credentials = !url.username().is_empty() || url.password().is_some();
    let has_extra = url.query().is_some_and(|query| !query.is_empty())
        || url.fragment().is_some_and(|fragment| !fragment.is_empty());
    if has_credentials || has_extra || url.path() != "/" {
        return None;
    }
    match url.scheme() {
        "https" => Some(url.origin().ascii_serialization()),
        "http"
            if allow_insecure
                || url
                    .host_str()
                    .is_some_and(|host| LOOPBACK_HOSTS.contains(&host)) =>
        {
            Some(url.origin().ascii_serialization())
        }
        _ => None,
    }
}

pub fn github_device_uri(text: &str) -> Option<String> {
    let url = Url::parse(text).ok()?;
    let plain = url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    let device = url.host_str() == Some(GITHUB_HOST) && url.path() == GITHUB_DEVICE_PATH;
    (plain && device).then(|| url.as_str().to_owned())
}

pub fn socket_origin(origin: &str) -> String {
    match origin.strip_prefix("http") {
        Some(rest) => format!("ws{rest}"),
        None => origin.to_owned(),
    }
}

pub fn host_of(origin: &str) -> Option<String> {
    let url = Url::parse(origin).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

pub fn default_server_url(is_packaged: bool, host: &Host, stamp: Option<&str>) -> Option<String> {
    let override_url = if is_packaged {
        None
    } else {
        host.var(&env_name(SERVER_URL_ENV))
    };
    let text = override_url.or(stamp)?;
    if text.is_empty() {
        return None;
    }
    parse_server_url(text, !is_packaged)
}
