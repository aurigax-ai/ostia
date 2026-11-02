use serde_json::Value;

use crate::external_links::app_link_scheme;

const ALLOWED_APP_SCHEMES_MAX: usize = 100;

pub struct AppLinkSettings {
    pub ask_before_opening_apps: bool,
    pub allowed_app_schemes: Vec<String>,
}

pub fn parse_allowed_app_schemes(raw: Option<&Value>) -> Vec<String> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let Some(text) = item.as_str() else {
            continue;
        };
        if out.len() >= ALLOWED_APP_SCHEMES_MAX {
            continue;
        }
        let scheme = text.to_lowercase();
        if app_link_scheme(&format!("{scheme}://x")).as_deref() == Some(scheme.as_str())
            && !out.contains(&scheme)
        {
            out.push(scheme);
        }
    }
    out
}

pub fn parse_ask_before_opening_apps(raw: Option<&Value>) -> bool {
    raw != Some(&Value::Bool(false))
}

pub fn app_link_asks(settings: &AppLinkSettings, scheme: &str) -> bool {
    settings.ask_before_opening_apps
        && !settings
            .allowed_app_schemes
            .iter()
            .any(|allowed| allowed == scheme)
}
