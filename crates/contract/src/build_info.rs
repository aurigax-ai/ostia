use std::fmt;

use serde_json::Value;

#[derive(Clone, PartialEq, Eq)]
pub struct TelemetryStamp {
    pub key: String,
    pub host: String,
}

impl fmt::Debug for TelemetryStamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TelemetryStamp")
            .field("host", &self.host)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildInfo {
    pub version: String,
    pub built_at: String,
    pub telemetry: Option<TelemetryStamp>,
    pub server: Option<String>,
}

pub fn release_version(version: &str) -> &str {
    version
        .split_once('+')
        .map_or(version, |(release, _)| release)
}

pub fn is_dirty_build(version: &str) -> bool {
    version.ends_with(".dirty")
}

pub fn parse_build_info(raw: &Value) -> Option<BuildInfo> {
    let object = raw.as_object()?;
    let version = object.get("version")?.as_str()?;
    let built_at = object.get("builtAt")?.as_str()?;
    Some(BuildInfo {
        version: version.to_owned(),
        built_at: built_at.to_owned(),
        telemetry: object.get("telemetry").and_then(parse_telemetry_stamp),
        server: object
            .get("server")
            .and_then(Value::as_str)
            .filter(|server| !server.is_empty())
            .map(str::to_owned),
    })
}

pub fn parse_telemetry_stamp(raw: &Value) -> Option<TelemetryStamp> {
    let object = raw.as_object()?;
    let key = object.get("key")?.as_str().filter(|key| !key.is_empty())?;
    let host = object
        .get("host")?
        .as_str()
        .filter(|host| !host.is_empty())?;
    Some(TelemetryStamp {
        key: key.to_owned(),
        host: host.to_owned(),
    })
}

pub fn same_build(a: &BuildInfo, b: &BuildInfo) -> bool {
    a.version == b.version && a.built_at == b.built_at
}
