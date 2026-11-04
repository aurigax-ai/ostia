use ostia_base::js::js_trim;
use ostia_contract::assist::{
    ASSIST_PROVIDER_ID_PATTERN, ASSIST_PROVIDER_MODELS_MAX, ASSIST_PROVIDERS_MAX,
    AssistProviderConfig, AssistProviderKind,
};
use ostia_contract::assist_reports::is_assist_model_id;
use ostia_contract::utf16_prefix::utf16_prefix;
use serde_json::Value;

const KIND_ID_UNITS: usize = 28;

pub fn new_provider_id(kind: &str, taken: &[String]) -> String {
    if !taken.iter().any(|id| id == kind) {
        return kind.to_owned();
    }
    let head = utf16_prefix(kind, KIND_ID_UNITS);
    (2..)
        .map(|n| format!("{head}-{n}"))
        .find(|id| !taken.contains(id))
        .unwrap_or_default()
}

pub fn with_provider(
    providers: &[AssistProviderConfig],
    ext_id: &str,
    kind: &AssistProviderKind,
) -> Option<Vec<AssistProviderConfig>> {
    if providers.len() >= ASSIST_PROVIDERS_MAX {
        return None;
    }
    let taken: Vec<String> = providers.iter().map(|p| p.id.clone()).collect();
    let id = new_provider_id(&kind.id, &taken);
    if !ASSIST_PROVIDER_ID_PATTERN.is_match(&id) {
        return None;
    }
    let name = if providers.iter().any(|p| p.name == kind.title) {
        format!("{} ({id})", kind.title)
    } else {
        kind.title.clone()
    };
    let mut next = providers.to_vec();
    next.push(AssistProviderConfig {
        id,
        ext_id: ext_id.to_owned(),
        kind: kind.id.clone(),
        name,
        base_url: String::new(),
        enabled: true,
        models: Vec::new(),
    });
    Some(next)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProviderPatch {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub enabled: Option<bool>,
    pub models: Option<Vec<String>>,
}

pub fn patch_provider(
    providers: &[AssistProviderConfig],
    id: &str,
    patch: &ProviderPatch,
) -> Vec<AssistProviderConfig> {
    providers
        .iter()
        .map(|provider| {
            if provider.id != id {
                return provider.clone();
            }
            AssistProviderConfig {
                name: patch.name.clone().unwrap_or_else(|| provider.name.clone()),
                base_url: patch
                    .base_url
                    .clone()
                    .unwrap_or_else(|| provider.base_url.clone()),
                enabled: patch.enabled.unwrap_or(provider.enabled),
                models: patch
                    .models
                    .clone()
                    .unwrap_or_else(|| provider.models.clone()),
                ..provider.clone()
            }
        })
        .collect()
}

pub fn with_model(models: &[String], raw: &str) -> Option<Vec<String>> {
    let id = js_trim(raw);
    is_assist_model_id(Some(&Value::from(id)))?;
    if models.iter().any(|known| known == id) || models.len() >= ASSIST_PROVIDER_MODELS_MAX {
        return None;
    }
    let mut next = models.to_vec();
    next.push(id.to_owned());
    Some(next)
}
