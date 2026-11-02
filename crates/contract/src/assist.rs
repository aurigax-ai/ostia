use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;
use serde::Serialize;
use serde_json::json;

use crate::string_enum::string_enum;

string_enum!(AssistPoint {
    Input = "input",
    Command = "command",
    Completion = "completion",
    Terminal = "terminal",
    Chat = "chat",
});

string_enum!(ChatToolMode {
    Native = "native",
    Prompted = "prompted",
});

string_enum!(AssistFeatureId {
    Chat = "chat",
    Typos = "typos",
    PromptReview = "promptReview",
    CommandSuggest = "commandSuggest",
    TerminalCompletions = "terminalCompletions",
    EditorCompletions = "editorCompletions",
    ExplainError = "explainError",
});

string_enum!(AssistSetupProblem {
    NoProvider = "no-provider",
    NoEndpoint = "no-endpoint",
    NoKey = "no-key",
    NoModel = "no-model",
    Unreachable = "unreachable",
});

string_enum!(AssistKeyNeed {
    Required = "required",
    Optional = "optional",
});

string_enum!(AssistUi {
    Chat = "chat",
    Ask = "ask",
    Compose = "compose",
});

string_enum!(AssistTask {
    Typos = "typos",
    Review = "review",
});

string_enum!(ChatToolState {
    Done = "done",
    Error = "error",
    Denied = "denied",
});

string_enum!(ChatContextKind {
    Output = "output",
    Selection = "selection",
    Cwd = "cwd",
    Pane = "pane",
    Error = "error",
    File = "file",
    Editor = "editor",
    Browser = "browser",
});

string_enum!(AssistError {
    Unavailable = "unavailable",
    Cancelled = "cancelled",
    Invalid = "invalid",
    Failed = "failed",
    RateLimited = "rate-limited",
    Busy = "busy",
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssistModelClass {
    Chat,
    Fast,
}

pub const ASSIST_LABEL_MAX: usize = 80;
pub const ASSIST_PROVIDERS_MAX: usize = 16;
pub const ASSIST_PROVIDER_MODELS_MAX: usize = 32;
pub const ASSIST_PROVIDER_NAME_MAX: usize = 60;
pub const ASSIST_PROVIDER_URL_MAX: usize = 2048;
pub const ASSIST_KINDS_MAX: usize = 16;
pub const ASSIST_ERROR_MAX: usize = 240;
pub const ASSIST_MODELS_MAX: usize = 64;
pub const ASSIST_MODEL_ID_MAX: usize = 200;
pub const ASSIST_MODEL_DESCRIPTION_MAX: usize = 400;
pub const TERMINAL_LINE_MAX: usize = 1000;
pub const TERMINAL_HISTORY_MAX: usize = 10;
pub const TERMINAL_HISTORY_COMMAND_MAX: usize = 500;
pub const TERMINAL_CONTEXT_MAX: usize = 6;
pub const TERMINAL_CONTEXT_TEXT_MAX: usize = 200;
pub const TERMINAL_COMPLETION_MAX: usize = 500;
pub const INPUT_TEXT_MAX: usize = 8000;
pub const COMMAND_QUERY_MAX: usize = 1000;
pub const COMPLETION_PREFIX_MAX: usize = 6000;
pub const COMPLETION_SUFFIX_MAX: usize = 2000;
pub const COMPLETION_NEIGHBORS_MAX: usize = 3;
pub const COMPLETION_NEIGHBOR_TEXT_MAX: usize = 2000;
pub const COMPLETION_TEXT_MAX: usize = 2000;
pub const CHAT_MESSAGES_MAX: usize = 40;
pub const CHAT_MESSAGE_MAX: usize = 20_000;
pub const CHAT_CONTEXT_MAX: usize = 6;
pub const CHAT_CONTEXT_TEXT_MAX: usize = 20_000;
pub const CHAT_REPLY_MAX: usize = 100_000;
pub const CHAT_STREAM_MAX: usize = 1_000_000;
pub const CHAT_TOOLS_MAX: usize = 64;
pub const CHAT_TOOL_DESCRIPTION_MAX: usize = 8000;
pub const CHAT_TOOL_SCHEMA_MAX: usize = 16_384;
pub const CHAT_TOOL_CALLS_MAX: usize = 16;
pub const CHAT_TOOL_CALL_ID_MAX: usize = 128;
pub const CHAT_TOOL_INPUT_MAX: usize = 131_072;
pub const CHAT_TOOL_OUTPUT_MAX: usize = 32_000;
pub const CHAT_TOOL_ERROR_MAX: usize = 1000;
pub const REVIEW_NOTES_MAX: usize = 5;
pub const REVIEW_NOTE_MAX: usize = 240;
pub const COMMAND_SUGGESTIONS_MAX: usize = 3;
pub const COMMAND_TEXT_MAX: usize = 2000;

pub static ASSIST_PROVIDER_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z0-9][a-z0-9-]{0,31}$"));
pub static CHAT_TOOL_NAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9_-]{1,64}$"));
pub static ASSIST_REQUEST_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9_-]{1,64}$"));

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistModelRef {
    pub ext_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistFeatureState {
    pub id: &'static str,
    pub setting: String,
    pub on: bool,
    pub ready: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistProviderKind {
    pub id: String,
    pub title: String,
    pub base_url: String,
    pub key: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AssistCatalogModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistProviderState {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub setup: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub lifecycle: bool,
    pub models: Vec<AssistCatalogModel>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistProviderConfig {
    pub id: String,
    pub ext_id: String,
    pub kind: String,
    pub name: String,
    pub base_url: String,
    pub enabled: bool,
    pub models: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistModelSettings {
    pub providers: Vec<AssistProviderConfig>,
    pub fast_model: Option<AssistModelRef>,
    pub chat_model: Option<AssistModelRef>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct AssistProviderEntry {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub base_url: String,
    pub models: Vec<String>,
    pub api_key: Option<String>,
}

impl std::fmt::Debug for AssistProviderEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AssistProviderEntry")
            .field("id", &self.id)
            .field("kind", &self.kind)
            .field("name", &self.name)
            .field("base_url", &self.base_url)
            .field("models", &self.models)
            .field("api_key", &self.api_key.as_ref().map(|_| "<hidden>"))
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AssistModelChoice {
    #[serde(rename = "ref")]
    pub model_ref: AssistModelRef,
    pub group: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<&'static str>,
    pub points: Vec<&'static str>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct AssistCatalog {
    pub models: Vec<AssistModelChoice>,
    pub chat: Option<AssistModelRef>,
    pub fast: Option<AssistModelRef>,
}

pub fn same_model_ref(left: Option<&AssistModelRef>, right: Option<&AssistModelRef>) -> bool {
    left == right
}

pub fn model_ref_key(model_ref: &AssistModelRef) -> String {
    json!([model_ref.ext_id, model_ref.provider, model_ref.model]).to_string()
}

pub fn feature_model_class(id: AssistFeatureId) -> AssistModelClass {
    match id {
        AssistFeatureId::Chat | AssistFeatureId::ExplainError => AssistModelClass::Chat,
        _ => AssistModelClass::Fast,
    }
}

pub fn model_class_of(point: AssistPoint) -> AssistModelClass {
    match point {
        AssistPoint::Chat => AssistModelClass::Chat,
        _ => AssistModelClass::Fast,
    }
}

pub fn choice_label(group: &str, label: &str) -> String {
    if group == label {
        label.to_string()
    } else {
        format!("{group} · {label}")
    }
}

pub fn is_assist_point(text: &str) -> bool {
    <AssistPoint as crate::string_enum::StringEnum>::parse(text).is_some()
}

pub fn is_chat_tool_mode(text: &str) -> bool {
    <ChatToolMode as crate::string_enum::StringEnum>::parse(text).is_some()
}
