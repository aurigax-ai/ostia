use serde::Serialize;
use serde_json::Value;

use crate::js_text::js_round;
use ostia_base::js::JsNumber;

const RESPONSIVE: &str = "responsive";
const SIZE_MIN: f64 = 50.0;
const SIZE_MAX: f64 = 9999.0;
const DEVICE_DPRS: [f64; 3] = [1.0, 2.0, 3.0];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceZoom {
    Fit,
    Actual,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BrowserDevice {
    pub preset: String,
    pub width: i64,
    pub height: i64,
    pub dpr: JsNumber,
    pub zoom: DeviceZoom,
}

struct Preset {
    id: &'static str,
    width: i64,
    height: i64,
    dpr: f64,
}

const PRESETS: &[Preset] = &[
    Preset {
        id: "iphone-se",
        width: 375,
        height: 667,
        dpr: 2.0,
    },
    Preset {
        id: "iphone-16",
        width: 393,
        height: 852,
        dpr: 3.0,
    },
    Preset {
        id: "pixel-9",
        width: 412,
        height: 924,
        dpr: 2.625,
    },
    Preset {
        id: "samsung-galaxy-s20-ultra",
        width: 412,
        height: 915,
        dpr: 3.5,
    },
    Preset {
        id: "ipad-mini",
        width: 768,
        height: 1024,
        dpr: 2.0,
    },
    Preset {
        id: "ipad-pro-13",
        width: 1032,
        height: 1376,
        dpr: 2.0,
    },
    Preset {
        id: "galaxy-tab-s4",
        width: 712,
        height: 1138,
        dpr: 2.25,
    },
];

fn find_preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|preset| preset.id == id)
}

fn size_of(value: Option<&Value>) -> Option<i64> {
    let size = value?.as_f64()?;
    Some(js_round(size).clamp(SIZE_MIN, SIZE_MAX) as i64)
}

fn preset_sized(preset: &Preset, landscape: bool, zoom: DeviceZoom) -> BrowserDevice {
    let (width, height) = if landscape {
        (preset.height, preset.width)
    } else {
        (preset.width, preset.height)
    };
    BrowserDevice {
        preset: preset.id.to_owned(),
        width,
        height,
        dpr: JsNumber(preset.dpr),
        zoom,
    }
}

pub fn parse_browser_device(raw: &Value) -> Option<BrowserDevice> {
    let fields = raw.as_object()?;
    let width = size_of(fields.get("width"))?;
    let height = size_of(fields.get("height"))?;
    let zoom = if fields.get("zoom").and_then(Value::as_str) == Some("actual") {
        DeviceZoom::Actual
    } else {
        DeviceZoom::Fit
    };
    if let Some(preset) = fields
        .get("preset")
        .and_then(Value::as_str)
        .and_then(find_preset)
    {
        return Some(preset_sized(preset, width > height, zoom));
    }
    let dpr = fields
        .get("dpr")
        .and_then(Value::as_f64)
        .filter(|dpr| DEVICE_DPRS.contains(dpr))
        .unwrap_or(1.0);
    Some(BrowserDevice {
        preset: RESPONSIVE.to_owned(),
        width,
        height,
        dpr: JsNumber(dpr),
        zoom,
    })
}
