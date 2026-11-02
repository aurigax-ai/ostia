use std::sync::LazyLock;

use ostia_base::js::{JS_DOT, static_regex};
use regex::Regex;
use serde_json::Value;

pub const DISCRETE_GPU_FEATURE: &str = "discrete-gpu";
pub const SOFTWARE_WEBGL_ARG: &str = "--ostia-software-webgl";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscreteGpuInfo {
    pub name: String,
    pub in_use: bool,
}

static ANGLE_RENDERER: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^ANGLE \([^,]+, ({JS_DOT}+), [^,]+\)$")));

pub fn parse_discrete_gpu(raw: &Value) -> bool {
    matches!(raw, Value::Bool(true))
}

pub fn renderer_device_name(renderer: &str) -> &str {
    ANGLE_RENDERER
        .captures(renderer)
        .and_then(|captures| captures.get(1))
        .map_or(renderer, |device| device.as_str())
}
