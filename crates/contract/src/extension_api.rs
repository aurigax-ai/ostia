use std::sync::LazyLock;

use ostia_base::PRODUCT_NAME;
use ostia_base::js::static_regex;
use regex::Regex;
use serde_json::Value;

pub const EXTENSION_API_VERSION: &str = "7.14";
pub const EXTENSION_API_ENV: &str = "EXTENSION_API";

static EXTENSION_API_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ApiVersion {
    pub major: u32,
    pub minor: u32,
}

fn parse_api_text(text: &str) -> Option<ApiVersion> {
    let captures = EXTENSION_API_PATTERN.captures(text)?;
    Some(ApiVersion {
        major: captures.get(1)?.as_str().parse().ok()?,
        minor: captures.get(2)?.as_str().parse().ok()?,
    })
}

pub fn parse_api_version(value: &Value) -> Option<ApiVersion> {
    parse_api_text(value.as_str()?)
}

pub fn is_api_compatible(required: &ApiVersion, provided: &ApiVersion) -> bool {
    required.major == provided.major && required.minor <= provided.minor
}

pub fn api_problem(required: &Value, provided: Option<&str>) -> Option<String> {
    let Some(wanted) = parse_api_version(required) else {
        return Some("api must be an extension API version such as 1.0".to_owned());
    };
    let provided = provided.unwrap_or(EXTENSION_API_VERSION);
    if parse_api_text(provided).is_some_and(|have| is_api_compatible(&wanted, &have)) {
        return None;
    }
    Some(format!(
        "needs extension API {}.{}; this {PRODUCT_NAME} provides {provided}",
        wanted.major, wanted.minor
    ))
}
