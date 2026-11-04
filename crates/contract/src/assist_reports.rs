use ostia_base::js::{js_trim, utf16_len};
use serde_json::{Map, Value};

use crate::assist::{
    ASSIST_ERROR_MAX, ASSIST_KINDS_MAX, ASSIST_LABEL_MAX, ASSIST_MODEL_DESCRIPTION_MAX,
    ASSIST_MODEL_ID_MAX, ASSIST_MODELS_MAX, ASSIST_PROVIDER_ID_PATTERN, ASSIST_PROVIDER_MODELS_MAX,
    ASSIST_PROVIDER_NAME_MAX, ASSIST_PROVIDER_URL_MAX, ASSIST_PROVIDERS_MAX, AssistFeatureId,
    AssistModelRef, AssistModelSettings, AssistPoint, AssistProviderConfig, AssistSetupProblem,
    ChatToolMode,
};
use crate::assist_payloads::{SHORT_MAX, optional_short};
use crate::string_enum::StringEnum;

const EXT_ID_MAX: usize = 64;

type Object = Map<String, Value>;

fn put<T: Into<Value>>(object: &mut Object, key: &str, value: Option<T>) {
    if let Some(value) = value {
        object.insert(key.to_string(), value.into());
    }
}

fn tool_mode(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|mode| ChatToolMode::ALL.contains(mode))
}

pub fn normalize_assist_status(raw: &Value) -> Value {
    let mut out = Object::new();
    let Some(raw) = raw.as_object() else {
        return Value::Object(out);
    };
    for point in AssistPoint::ALL {
        let Some(entry) = raw.get(*point).and_then(Value::as_object) else {
            continue;
        };
        let mut status = Object::new();
        status.insert(
            "ready".to_string(),
            Value::Bool(entry.get("ready") == Some(&Value::Bool(true))),
        );
        put(
            &mut status,
            "label",
            optional_short(entry.get("label"), ASSIST_LABEL_MAX),
        );
        if *point == "chat" {
            put(&mut status, "tools", tool_mode(entry.get("tools")));
        }
        out.insert((*point).to_string(), Value::Object(status));
    }
    Value::Object(out)
}

pub fn normalize_assist_features(raw: &Value) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let items = raw.as_array().map(Vec::as_slice).unwrap_or_default();
    for item in items {
        let Some(item) = item.as_object() else {
            continue;
        };
        let Some(id) = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| AssistFeatureId::ALL.contains(id))
        else {
            continue;
        };
        let Some(setting) = item.get("setting").and_then(Value::as_str) else {
            continue;
        };
        if out.iter().any(|feature| feature["id"].as_str() == Some(id)) {
            continue;
        }
        let mut feature = Object::new();
        feature.insert("id".to_string(), id.into());
        feature.insert("setting".to_string(), setting.into());
        feature.insert(
            "ready".to_string(),
            Value::Bool(item.get("ready") == Some(&Value::Bool(true))),
        );
        out.push(Value::Object(feature));
    }
    Value::Array(out)
}

pub fn normalize_setup_problem(raw: &Value) -> Option<&'static str> {
    let text = raw.as_str()?;
    AssistSetupProblem::ALL
        .iter()
        .copied()
        .find(|problem| *problem == text)
}

pub fn normalize_assist_error(raw: Option<&Value>) -> Option<String> {
    optional_short(raw, ASSIST_ERROR_MAX)
}

pub fn normalize_assist_label(raw: Option<&Value>) -> Option<String> {
    optional_short(raw, ASSIST_LABEL_MAX)
}

fn provider_id(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|id| ASSIST_PROVIDER_ID_PATTERN.is_match(id))
}

fn model_id_fits(id: &str) -> bool {
    !id.is_empty() && utf16_len(id) <= ASSIST_MODEL_ID_MAX
}

pub fn is_assist_model_id(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|id| model_id_fits(id))
}

fn model_ids(raw: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let items = raw
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for item in items {
        let id = item.as_str().map_or("", js_trim);
        if model_id_fits(id) && !out.iter().any(|known| known == id) {
            out.push(id.to_string());
        }
        if out.len() == ASSIST_PROVIDER_MODELS_MAX {
            break;
        }
    }
    out
}

pub fn normalize_model_ref(raw: &Value) -> Option<AssistModelRef> {
    let raw = raw.as_object()?;
    let ext_id = optional_short(raw.get("extId"), EXT_ID_MAX)?;
    let provider = provider_id(raw.get("provider"));
    let model = is_assist_model_id(raw.get("model"));
    let (Some(provider), Some(model)) = (provider, model) else {
        return Some(AssistModelRef {
            ext_id,
            provider: None,
            model: None,
        });
    };
    Some(AssistModelRef {
        ext_id,
        provider: Some(provider.to_string()),
        model: Some(model.to_string()),
    })
}

pub fn normalize_provider_config(raw: &Value) -> Option<AssistProviderConfig> {
    let raw = raw.as_object()?;
    let id = provider_id(raw.get("id"))?;
    let kind = provider_id(raw.get("kind"))?;
    let ext_id = optional_short(raw.get("extId"), EXT_ID_MAX)?;
    let base_url = raw
        .get("baseUrl")
        .and_then(Value::as_str)
        .map_or("", js_trim);
    if utf16_len(base_url) > ASSIST_PROVIDER_URL_MAX {
        return None;
    }
    Some(AssistProviderConfig {
        id: id.to_string(),
        ext_id,
        kind: kind.to_string(),
        name: optional_short(raw.get("name"), ASSIST_PROVIDER_NAME_MAX)
            .unwrap_or_else(|| kind.to_string()),
        base_url: base_url.to_string(),
        enabled: raw.get("enabled") != Some(&Value::Bool(false)),
        models: model_ids(raw.get("models")),
    })
}

pub fn parse_assist_model_settings(raw: &Value) -> AssistModelSettings {
    let empty = Object::new();
    let source = raw.as_object().unwrap_or(&empty);
    let mut providers: Vec<AssistProviderConfig> = Vec::new();
    let items = source
        .get("providers")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for item in items {
        if providers.len() == ASSIST_PROVIDERS_MAX {
            break;
        }
        if let Some(provider) = normalize_provider_config(item)
            && !providers.iter().any(|known| known.id == provider.id)
        {
            providers.push(provider);
        }
    }
    let model_of = |key: &str| source.get(key).and_then(normalize_model_ref);
    AssistModelSettings {
        providers,
        fast_model: model_of("fastModel"),
        chat_model: model_of("chatModel"),
    }
}

pub fn normalize_provider_kinds(raw: &Value) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let items = raw.as_array().map(Vec::as_slice).unwrap_or_default();
    for item in items {
        if out.len() == ASSIST_KINDS_MAX {
            break;
        }
        let Some(item) = item.as_object() else {
            continue;
        };
        let Some(id) = provider_id(item.get("id")) else {
            continue;
        };
        if out.iter().any(|kind| kind["id"].as_str() == Some(id)) {
            continue;
        }
        let mut kind = Object::new();
        kind.insert("id".to_string(), id.into());
        kind.insert(
            "title".to_string(),
            optional_short(item.get("title"), ASSIST_PROVIDER_NAME_MAX)
                .unwrap_or_else(|| id.to_string())
                .into(),
        );
        kind.insert(
            "baseUrl".to_string(),
            optional_short(item.get("baseUrl"), ASSIST_PROVIDER_URL_MAX)
                .unwrap_or_default()
                .into(),
        );
        let key = if item.get("key").and_then(Value::as_str) == Some("required") {
            "required"
        } else {
            "optional"
        };
        kind.insert("key".to_string(), key.into());
        out.push(Value::Object(kind));
    }
    Value::Array(out)
}

fn catalog_models(raw: Option<&Value>) -> Vec<Value> {
    let mut models: Vec<Value> = Vec::new();
    let items = raw
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for entry in items {
        if models.len() == ASSIST_MODELS_MAX {
            break;
        }
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let Some(id) = is_assist_model_id(entry.get("id")) else {
            continue;
        };
        if models.iter().any(|model| model["id"].as_str() == Some(id)) {
            continue;
        }
        let mut model = Object::new();
        model.insert("id".to_string(), id.into());
        put(&mut model, "tools", tool_mode(entry.get("tools")));
        models.push(Value::Object(model));
    }
    models
}

pub fn normalize_provider_states(raw: &Value) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let items = raw.as_array().map(Vec::as_slice).unwrap_or_default();
    for item in items {
        if out.len() == ASSIST_PROVIDERS_MAX {
            break;
        }
        let Some(item) = item.as_object() else {
            continue;
        };
        let (Some(id), Some(kind)) = (provider_id(item.get("id")), provider_id(item.get("kind")))
        else {
            continue;
        };
        if out
            .iter()
            .any(|provider| provider["id"].as_str() == Some(id))
        {
            continue;
        }
        let mut state = Object::new();
        state.insert("id".to_string(), id.into());
        state.insert("kind".to_string(), kind.into());
        state.insert(
            "name".to_string(),
            optional_short(item.get("name"), ASSIST_PROVIDER_NAME_MAX)
                .unwrap_or_else(|| id.to_string())
                .into(),
        );
        state.insert(
            "setup".to_string(),
            item.get("setup")
                .and_then(normalize_setup_problem)
                .map_or(Value::Null, Value::from),
        );
        state.insert(
            "lifecycle".to_string(),
            Value::Bool(item.get("lifecycle") == Some(&Value::Bool(true))),
        );
        state.insert(
            "models".to_string(),
            Value::Array(catalog_models(item.get("models"))),
        );
        put(
            &mut state,
            "lastError",
            normalize_assist_error(item.get("lastError")),
        );
        out.push(Value::Object(state));
    }
    Value::Array(out)
}

fn assist_model(raw: &Value) -> Option<Value> {
    let raw = raw.as_object()?;
    let mut model = Object::new();
    model.insert("id".to_string(), is_assist_model_id(raw.get("id"))?.into());
    put(
        &mut model,
        "name",
        optional_short(raw.get("name"), SHORT_MAX),
    );
    put(
        &mut model,
        "description",
        optional_short(raw.get("description"), ASSIST_MODEL_DESCRIPTION_MAX),
    );
    for key in ["installed", "loaded", "busy"] {
        put(&mut model, key, raw.get(key).and_then(Value::as_bool));
    }
    let idle = raw
        .get("idleSecs")
        .and_then(Value::as_f64)
        .filter(|secs| *secs >= 0.0);
    put(&mut model, "idleSecs", idle.map(|secs| secs.floor() as u64));
    Some(Value::Object(model))
}

pub fn normalize_assist_models(raw: &Value) -> Option<Value> {
    let raw = raw.as_object()?;
    let mut models: Vec<Value> = Vec::new();
    let items = raw
        .get("models")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for item in items {
        if let Some(model) = assist_model(item)
            && !models.iter().any(|known| known["id"] == model["id"])
        {
            models.push(model);
        }
        if models.len() == ASSIST_MODELS_MAX {
            break;
        }
    }
    let mut list = Object::new();
    list.insert(
        "lifecycle".to_string(),
        Value::Bool(raw.get("lifecycle") == Some(&Value::Bool(true))),
    );
    list.insert("models".to_string(), Value::Array(models));
    put(&mut list, "error", normalize_assist_error(raw.get("error")));
    Some(Value::Object(list))
}
