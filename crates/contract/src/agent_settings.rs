use std::collections::HashSet;
use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex, utf16_len};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::agent_core_tools::AGENT_ACT_TOOLS;

pub const AGENT_PROVIDER_MODELS_MAX: usize = 64;

const AGENT_PROVIDERS_MAX: usize = 16;
const AGENT_PROVIDER_NAME_MAX: usize = 80;
const AGENT_MODEL_MAX: usize = 120;
const AGENT_URL_MAX: usize = 2048;

static AGENT_PROVIDER_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z0-9][a-z0-9-]{0,31}$"));

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderEntry {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub models: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHostSettings {
    pub providers: Vec<AgentProviderEntry>,
    pub always_ask: Vec<&'static str>,
}

pub static DEFAULT_AGENT_SETTINGS: LazyLock<AgentHostSettings> =
    LazyLock::new(|| AgentHostSettings {
        providers: Vec::new(),
        always_ask: Vec::new(),
    });

fn parse_always_ask(raw: Option<&Value>) -> Vec<&'static str> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    let listed: HashSet<&str> = items.iter().filter_map(Value::as_str).collect();
    AGENT_ACT_TOOLS
        .into_iter()
        .filter(|name| listed.contains(name))
        .collect()
}

fn plain_http_url(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    if utf16_len(text) > AGENT_URL_MAX {
        return None;
    }
    let url = Url::parse(text).ok()?;
    let web = matches!(url.scheme(), "http" | "https");
    let plain = url.username().is_empty()
        && url.password().is_none_or(str::is_empty)
        && url.query().is_none_or(str::is_empty)
        && url.fragment().is_none_or(str::is_empty);
    (web && plain).then(|| text.to_owned())
}

fn model_ids(raw: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    items
        .iter()
        .filter_map(Value::as_str)
        .filter(|model| !model.is_empty() && utf16_len(model) <= AGENT_MODEL_MAX)
        .filter(|model| seen.insert(*model))
        .take(AGENT_PROVIDER_MODELS_MAX)
        .map(str::to_owned)
        .collect()
}

fn cut_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

fn parse_agent_provider(raw: &Value) -> Option<AgentProviderEntry> {
    let record = raw.as_object()?;
    let id = record.get("id")?.as_str()?;
    if !AGENT_PROVIDER_ID.is_match(id) {
        return None;
    }
    let base_url = plain_http_url(record.get("baseUrl"))?;
    let models = model_ids(record.get("models"));
    if models.is_empty() {
        return None;
    }
    let name = record
        .get("name")
        .and_then(Value::as_str)
        .map_or("", |name| cut_utf16(js_trim(name), AGENT_PROVIDER_NAME_MAX));
    Some(AgentProviderEntry {
        id: id.to_owned(),
        name: if name.is_empty() { id } else { name }.to_owned(),
        base_url,
        models,
    })
}

pub fn parse_agent_settings(raw: &Value) -> AgentHostSettings {
    let source = raw.as_object();
    let mut providers: Vec<AgentProviderEntry> = Vec::new();
    if let Some(Value::Array(items)) = source.and_then(|record| record.get("providers")) {
        for item in items {
            if providers.len() == AGENT_PROVIDERS_MAX {
                break;
            }
            if let Some(provider) = parse_agent_provider(item)
                && !providers.iter().any(|kept| kept.id == provider.id)
            {
                providers.push(provider);
            }
        }
    }
    AgentHostSettings {
        providers,
        always_ask: parse_always_ask(source.and_then(|record| record.get("alwaysAsk"))),
    }
}
