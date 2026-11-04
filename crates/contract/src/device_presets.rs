use std::sync::LazyLock;

use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresetAgentMetadata {
    pub platform: String,
    pub platform_version: String,
    pub architecture: String,
    pub model: String,
    pub mobile: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DevicePreset {
    pub id: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub dpr: f64,
    pub mobile: bool,
    pub touch: bool,
    pub user_agent: String,
    pub metadata: PresetAgentMetadata,
}

fn record(raw: Option<&Value>) -> Option<&Map<String, Value>> {
    raw.and_then(Value::as_object)
}

fn positive(raw: Option<&Value>) -> Option<f64> {
    raw.and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number > 0.0)
}

fn text<'a>(raw: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    raw.get(key).and_then(Value::as_str)
}

fn preset_id(title: &str) -> String {
    let mut id = String::new();
    for ch in title.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            id.push(ch);
        } else if !id.ends_with('-') {
            id.push('-');
        }
    }
    id.trim_matches('-').to_owned()
}

fn parse_metadata(raw: Option<&Value>) -> Option<PresetAgentMetadata> {
    let meta = record(raw)?;
    let mobile = meta.get("mobile").and_then(Value::as_bool)?;
    Some(PresetAgentMetadata {
        platform: text(meta, "platform")?.to_owned(),
        platform_version: text(meta, "platformVersion")?.to_owned(),
        architecture: text(meta, "architecture")?.to_owned(),
        model: text(meta, "model")?.to_owned(),
        mobile,
    })
}

fn has_capability(capabilities: &[Value], name: &str) -> bool {
    capabilities.iter().any(|item| item.as_str() == Some(name))
}

fn parse_preset(raw: &Value) -> Option<DevicePreset> {
    let device = raw.as_object()?;
    let screen = record(device.get("screen"))?;
    let vertical = record(screen.get("vertical"))?;
    let title = text(device, "title").filter(|title| !title.is_empty())?;
    let user_agent = text(device, "user-agent").filter(|agent| !agent.is_empty())?;
    let width = positive(vertical.get("width"))?;
    let height = positive(vertical.get("height"))?;
    let dpr = positive(screen.get("device-pixel-ratio"))?;
    let metadata = parse_metadata(device.get("user-agent-metadata"))?;
    let capabilities = device
        .get("capabilities")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    Some(DevicePreset {
        id: preset_id(title),
        title: title.to_owned(),
        width,
        height,
        dpr,
        mobile: has_capability(capabilities, "mobile"),
        touch: has_capability(capabilities, "touch"),
        user_agent: user_agent.to_owned(),
        metadata,
    })
}

pub fn parse_device_presets(raw: &Value) -> Vec<DevicePreset> {
    let Some(devices) = raw.get("devices").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut presets: Vec<DevicePreset> = Vec::new();
    for entry in devices {
        if let Some(preset) = parse_preset(entry)
            && !presets.iter().any(|known| known.id == preset.id)
        {
            presets.push(preset);
        }
    }
    presets
}

static DEVICE_PRESETS: LazyLock<Vec<DevicePreset>> = LazyLock::new(|| {
    let data: Value =
        serde_json::from_str(include_str!("../data/devicePresets.json")).unwrap_or_default();
    parse_device_presets(&data)
});

pub fn device_presets() -> &'static [DevicePreset] {
    &DEVICE_PRESETS
}

pub fn device_preset(id: &str) -> Option<&'static DevicePreset> {
    DEVICE_PRESETS.iter().find(|preset| preset.id == id)
}

pub fn preset_user_agent(preset: &DevicePreset, chrome_version: &str) -> String {
    let major = chrome_version.split('.').next().unwrap_or("");
    preset
        .user_agent
        .replacen("%s", &format!("{major}.0.0.0"), 1)
}
