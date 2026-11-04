use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex, utf16_len};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use url::Url;

use crate::capabilities::Capability;
use crate::remote_folders::RemoteCwd;

pub const EXTENSION_MANIFEST_FILE: &str = "ostia.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionIcon {
    Puzzle,
    Kanban,
    BookOpen,
    GitBranch,
    Globe,
    Bell,
    Server,
    Terminal,
    Circle,
    Check,
    Alert,
    Shield,
    Chat,
    Plugs,
    MagnifyingGlass,
    Graph,
    Toolbox,
    Plus,
    Refresh,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument: Option<String>,
    pub palette: bool,
    pub stdin: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub interactive: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_playbook: bool,
    pub capabilities: Vec<Capability>,
}

pub const PANEL_TOOLBAR_MAX_TABS: usize = 6;
pub const PANEL_TOOLBAR_MAX_ACTIONS: usize = 6;
pub const PANEL_TOOLBAR_BACK_MAX: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelTabSurface {
    Inbox,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelToolbarTab {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<PanelTabSurface>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelToolbarAction {
    pub id: String,
    pub icon: ExtensionIcon,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PanelToolbarContribution {
    pub tabs: Vec<PanelToolbarTab>,
    pub actions: Vec<PanelToolbarAction>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct PanelToolbarState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub back: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badges: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelToolbarEntry {
    pub ext_id: String,
    pub workspace_id: String,
    pub state: PanelToolbarState,
}

pub const INBOX_ITEMS_MAX: usize = 50;
pub const INBOX_TEXT_MAX: usize = 500;
pub const INBOX_ACTION_EVENT: &str = "inbox.action";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub at: Number,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    pub ext_id: String,
    pub workspace_id: String,
    pub items: Vec<InboxItem>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxAction {
    Done,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxActionEvent {
    pub workspace_id: String,
    pub id: String,
    pub action: InboxAction,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ExtensionPanelContribution {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<ExtensionIcon>,
    pub entry: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toolbar: Option<PanelToolbarContribution>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionSettingsPageContribution {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<ExtensionIcon>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionChipContribution {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionSettingType {
    String,
    Number,
    Boolean,
    Enum,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExtensionSettingValue {
    Text(String),
    Number(Number),
    Flag(bool),
}

pub type ExtensionSettingValues = Map<String, Value>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionSettingUnit {
    Seconds,
    PerMinute,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSettingContribution {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: ExtensionSettingType,
    pub default: ExtensionSettingValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_titles: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<ExtensionSettingUnit>,
}

pub const EXTENSION_SETTING_STRING_MAX: usize = 1000;
pub const EXTENSION_SETTING_TITLE_MAX: usize = 80;
pub const PRODUCT_PLACEHOLDER: &str = "{product}";

pub fn valid_setting_value(setting: &ExtensionSettingContribution, value: &Value) -> bool {
    match setting.kind {
        ExtensionSettingType::String => value
            .as_str()
            .is_some_and(|text| utf16_len(text) <= EXTENSION_SETTING_STRING_MAX),
        ExtensionSettingType::Number => value.as_f64().is_some_and(|number| {
            number.is_finite()
                && setting
                    .minimum
                    .as_ref()
                    .and_then(Number::as_f64)
                    .is_none_or(|minimum| number >= minimum)
                && setting
                    .maximum
                    .as_ref()
                    .and_then(Number::as_f64)
                    .is_none_or(|maximum| number <= maximum)
        }),
        ExtensionSettingType::Boolean => value.is_boolean(),
        ExtensionSettingType::Enum => value.as_str().is_some_and(|text| {
            setting
                .values
                .as_deref()
                .is_some_and(|values| values.iter().any(|allowed| allowed == text))
        }),
    }
}

fn default_setting_json(value: &ExtensionSettingValue) -> Value {
    match value {
        ExtensionSettingValue::Text(text) => Value::String(text.clone()),
        ExtensionSettingValue::Number(number) => Value::Number(number.clone()),
        ExtensionSettingValue::Flag(flag) => Value::Bool(*flag),
    }
}

pub fn effective_setting_values(
    settings: &[ExtensionSettingContribution],
    stored: &Value,
) -> ExtensionSettingValues {
    let raw = stored.as_object();
    let mut out = ExtensionSettingValues::new();
    for setting in settings {
        let value = raw.and_then(|map| map.get(&setting.key));
        let chosen = match value {
            Some(candidate) if valid_setting_value(setting, candidate) => candidate.clone(),
            _ => default_setting_json(&setting.default),
        };
        out.insert(setting.key.clone(), chosen);
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionSecretContribution {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub description: String,
}

pub const EXTENSION_SECRET_MAX: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionCategory {
    Ai,
    Scm,
    Tools,
    Themes,
    Langpack,
    Completions,
    Languages,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionStatus {
    PendingApproval,
    Disabled,
    Idle,
    Starting,
    Running,
    Crashed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidebarTone {
    Neutral,
    Brand,
    Ok,
    Warn,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidebarKind {
    Location,
    Live,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSidebarItem {
    pub ext_id: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<ExtensionIcon>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    pub tone: SidebarTone,
    pub kind: SidebarKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

pub static SIDEBAR_BADGE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9]{1,6}$"));

pub const SIDEBAR_URL_MAX: usize = 2048;

pub const PANE_CHIP_TEXT_MAX: usize = 40;
pub const PANE_CHIP_TOOLTIP_MAX: usize = 200;
pub const PANE_CHIP_ITEMS_MAX: usize = 64;
pub const PANE_CHIP_ITEM_TEXT_MAX: usize = 80;

const CHIP_PORT_ERROR_MAX: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneChipItemPort {
    pub remote: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneChipItem {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<PaneChipItemPort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

fn chip_port_number(raw: &Value) -> Option<u16> {
    let number = raw.as_f64()?;
    if number.fract() != 0.0 || !(1.0..=65535.0).contains(&number) {
        return None;
    }
    u16::try_from(number as u32).ok()
}

fn chip_item_port(raw: &Value) -> Option<PaneChipItemPort> {
    let object = raw.as_object()?;
    let remote = chip_port_number(object.get("remote")?)?;
    let local = match object.get("local") {
        None => None,
        Some(value) => Some(chip_port_number(value)?),
    };
    let error = match object.get("error") {
        None => None,
        Some(value) => {
            let text = value.as_str()?;
            if utf16_len(text) > CHIP_PORT_ERROR_MAX {
                return None;
            }
            Some(text.to_owned())
        }
    };
    Some(PaneChipItemPort {
        remote,
        local,
        error,
    })
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionChip {
    pub ext_id: String,
    pub id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
    pub tone: SidebarTone,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<ExtensionIcon>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<PaneChipItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneChip {
    #[serde(flatten)]
    pub chip: ExtensionChip,
    pub pane_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChip {
    #[serde(flatten)]
    pub chip: ExtensionChip,
    pub workspace_id: String,
}

pub const COMMAND_ARGUMENT_LABEL_MAX: usize = 80;
pub const COMMAND_ARGUMENT_MAX: usize = 1000;

pub fn command_argument(raw: &Value) -> Option<String> {
    let value = js_trim(raw.as_str()?);
    if value.is_empty() || utf16_len(value) > COMMAND_ARGUMENT_MAX {
        return None;
    }
    if value.chars().any(|ch| ch < '\u{20}' || ch == '\u{7f}') {
        return None;
    }
    Some(value.to_owned())
}

pub const PANEL_PATH_MAX: usize = 2048;

pub fn panel_path(raw: &Value) -> Option<String> {
    let text = raw.as_str()?;
    if !text.starts_with('/') || text.starts_with("//") || utf16_len(text) > PANEL_PATH_MAX {
        return None;
    }
    if text
        .chars()
        .any(|ch| ch < '\u{21}' || ch == '\u{7f}' || ch == '\\')
    {
        return None;
    }
    Some(text.to_owned())
}

pub fn sidebar_item_url(raw: &Value) -> Option<String> {
    let text = raw.as_str()?;
    if text.is_empty() || utf16_len(text) > SIDEBAR_URL_MAX {
        return None;
    }
    let url = Url::parse(text).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.into())
}

fn cut_utf16(text: &str, max_units: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > max_units {
            return &text[..index];
        }
    }
    text
}

fn chip_item_line(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(|text| cut_utf16(js_trim(text), PANE_CHIP_ITEM_TEXT_MAX).to_owned())
        .unwrap_or_default()
}

pub fn pane_chip_items(raw: &Value) -> Option<Vec<PaneChipItem>> {
    let entries = raw.as_array()?;
    if entries.is_empty() || entries.len() > PANE_CHIP_ITEMS_MAX {
        return None;
    }
    let mut items = Vec::with_capacity(entries.len());
    for entry in entries {
        let object = entry.as_object();
        let field = |name: &str| object.and_then(|map| map.get(name));
        let text = chip_item_line(field("text"));
        if text.is_empty() {
            return None;
        }
        let detail = chip_item_line(field("detail"));
        let mut item = PaneChipItem {
            text,
            detail: (!detail.is_empty()).then_some(detail),
            port: None,
            url: None,
        };
        if let Some(port) = field("port") {
            item.port = Some(chip_item_port(port)?);
        }
        if let Some(url) = field("url") {
            item.url = Some(sidebar_item_url(url)?);
        }
        items.push(item);
    }
    Some(items)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionCallerKind {
    Pane,
    User,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCaller {
    pub kind: ExtensionCallerKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandboxed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<RemoteCwd>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_prompt: Option<String>,
    pub capabilities: Vec<Capability>,
}

pub const EXTENSION_EVENT_TYPES: [&str; 11] = [
    "pane.created",
    "pane.closed",
    "command.started",
    "command.finished",
    "cwd.changed",
    "focus.changed",
    "notification",
    "pane.attention",
    "pane.lifecycle",
    "bus.message",
    "workspace.closed",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneAttentionEventState {
    Working,
    Waiting,
    Done,
    Error,
    Cleared,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneLifecycleEventState {
    Hibernated,
    Woken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BusMessageKind {
    Message,
    Task,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BusMessagePhase {
    Queued,
    Delivered,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusEndpoint {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneEventPayload {
    pub pane_id: String,
    pub workspace_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStartedPayload {
    pub pane_id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandFinishedPayload {
    pub pane_id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdChangedPayload {
    pub pane_id: String,
    pub workspace_id: String,
    pub cwd: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneAttentionPayload {
    pub pane_id: String,
    pub workspace_id: String,
    pub state: PaneAttentionEventState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneLifecyclePayload {
    pub pane_id: String,
    pub workspace_id: String,
    pub state: PaneLifecycleEventState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusMessagePayload {
    pub id: String,
    pub from: BusEndpoint,
    pub to: BusEndpoint,
    pub kind: BusMessageKind,
    pub phase: BusMessagePhase,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FocusChangedPayload {
    pub focused: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationPayload {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub from: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceClosedPayload {
    pub workspace_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ExtensionEventPayload {
    #[serde(rename = "pane.created")]
    PaneCreated(PaneEventPayload),
    #[serde(rename = "pane.closed")]
    PaneClosed(PaneEventPayload),
    #[serde(rename = "command.started")]
    CommandStarted(CommandStartedPayload),
    #[serde(rename = "command.finished")]
    CommandFinished(CommandFinishedPayload),
    #[serde(rename = "cwd.changed")]
    CwdChanged(CwdChangedPayload),
    #[serde(rename = "pane.attention")]
    PaneAttention(PaneAttentionPayload),
    #[serde(rename = "pane.lifecycle")]
    PaneLifecycle(PaneLifecyclePayload),
    #[serde(rename = "bus.message")]
    BusMessage(BusMessagePayload),
    #[serde(rename = "focus.changed")]
    FocusChanged(FocusChangedPayload),
    #[serde(rename = "notification")]
    Notification(NotificationPayload),
    #[serde(rename = "workspace.closed")]
    WorkspaceClosed(WorkspaceClosedPayload),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum SandboxDomainsResult {
    Allowed {
        ok: bool,
        domains: Vec<String>,
    },
    Refused {
        ok: bool,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExtensionSettingsChangedPayload {
    pub values: ExtensionSettingValues,
}

pub const SETTINGS_CHANGED_EVENT: &str = "settings.changed";
pub const ASSIST_PROVIDERS_CHANGED_EVENT: &str = "assist.providers.changed";

pub const TARGET_PANE_PARAM: &str = "targetPaneId";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ExtensionResult {
    Done {
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
    },
    Failed {
        ok: bool,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum WireRuntimeResult {
    Started {
        ok: bool,
        socket: String,
        token: String,
        started: bool,
        mode: String,
        version: String,
    },
    Failed {
        ok: bool,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        contract: Option<Number>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

pub const DIFF_TEXT_MAX: usize = 5 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DiffContent {
    pub title: String,
    pub original: String,
    pub modified: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

pub const TERMINAL_COMMAND_MAX_ARGS: usize = 64;
pub const TERMINAL_ARG_MAX: usize = 4096;
pub const TERMINAL_TITLE_MAX: usize = 80;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalPlace {
    Tab,
    Horizontal,
    Vertical,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTerminalOptions {
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<TerminalPlace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_shell: Option<bool>,
}

pub const OPEN_TERMINAL_WAIT_MAX_MS: u64 = 10 * 60_000;

pub const EXTENSION_REDACT_TEXTS_MAX: usize = 16;
pub const EXTENSION_REDACT_TEXT_MAX: usize = 16_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalWaitOutcome {
    Finished,
    Closed,
    Timeout,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWait {
    pub outcome: TerminalWaitOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<Number>,
}

pub const AGENT_OFFER_TEXT_MAX: usize = 2000;
pub const AGENT_OFFER_LABEL_MAX: usize = 120;
pub const AGENT_PROMPT_MAX: usize = 16_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOfferOptions {
    pub workspace_id: String,
    pub text: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum AgentOfferResult {
    Sent {
        ok: bool,
        sent: bool,
        #[serde(default, rename = "paneId", skip_serializing_if = "Option::is_none")]
        pane_id: Option<String>,
    },
    Failed {
        ok: bool,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAgentOptions {
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continue_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_pane_id: Option<String>,
}

pub const EXEC_TIMEOUT_MAX_MS: u64 = 600_000;
pub const EXEC_OUTPUT_DEFAULT: usize = 64 * 1024;
pub const EXEC_OUTPUT_MAX: usize = 1024 * 1024;
pub const EXEC_ENV_MAX: usize = 16;
pub const EXEC_ENV_VALUE_MAX: usize = 4096;
pub const BUS_SEND_TEXT_MAX: usize = 16_000;
pub const WAKE_WAIT_MAX_MS: u64 = 120_000;
pub static EXTENSION_VERB_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z][a-z0-9-]{1,19}$"));
