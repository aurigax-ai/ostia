use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex};
use regex::Regex;
use serde_json::{Map, Value};

pub const FORWARD_MAX: usize = 32;
pub const PORTS_POLL_MS: u64 = 2000;
pub const LOCAL_PORT_MIN: u16 = 1024;
pub const LOCAL_PORT_MAX: u16 = 65535;

static LOCAL_PORT_TEXT: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9]{1,5}$"));

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPort {
    pub port: u16,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortOp {
    List,
    Forward,
    Stop,
}

impl PortOp {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "list" => Some(Self::List),
            "forward" => Some(Self::Forward),
            "stop" => Some(Self::Stop),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Forward => "forward",
            Self::Stop => "stop",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardRow {
    pub remote: u16,
    pub name: Option<String>,
    pub local: Option<u16>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortsResult {
    Forwards(Vec<ForwardRow>),
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalPortInput {
    Unset,
    Port(u16),
    Bad,
}

impl HostPort {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("port".to_owned(), Value::from(self.port));
        if let Some(name) = &self.name {
            map.insert("name".to_owned(), Value::from(name.clone()));
        }
        Value::Object(map)
    }
}

impl ForwardRow {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("remote".to_owned(), Value::from(self.remote));
        if let Some(name) = &self.name {
            map.insert("name".to_owned(), Value::from(name.clone()));
        }
        if let Some(local) = self.local {
            map.insert("local".to_owned(), Value::from(local));
        }
        if let Some(error) = &self.error {
            map.insert("error".to_owned(), Value::from(error.clone()));
        }
        Value::Object(map)
    }
}

impl PortsResult {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        match self {
            Self::Forwards(rows) => {
                map.insert("ok".to_owned(), Value::Bool(true));
                map.insert(
                    "forwards".to_owned(),
                    Value::Array(rows.iter().map(ForwardRow::to_json).collect()),
                );
            }
            Self::Failed(error) => {
                map.insert("ok".to_owned(), Value::Bool(false));
                map.insert("error".to_owned(), Value::from(error.clone()));
            }
        }
        Value::Object(map)
    }
}

pub fn whole_number(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0).then_some(number)
}

pub fn port_in_range(value: &Value, min: u16) -> Option<u16> {
    let number = whole_number(value)?;
    if number < f64::from(min) || number > f64::from(u16::MAX) {
        return None;
    }
    Some(number as u16)
}

pub fn remote_port_of(value: &Value) -> Option<u16> {
    port_in_range(value, 1)
}

pub fn valid_local_port(value: &Value) -> bool {
    port_in_range(value, LOCAL_PORT_MIN).is_some()
}

pub fn valid_remote_port(value: &Value) -> bool {
    remote_port_of(value).is_some()
}

pub fn parse_local_port(text: &str) -> LocalPortInput {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return LocalPortInput::Unset;
    }
    if !LOCAL_PORT_TEXT.is_match(trimmed) {
        return LocalPortInput::Bad;
    }
    match trimmed.parse::<u16>() {
        Ok(port) if port >= LOCAL_PORT_MIN => LocalPortInput::Port(port),
        _ => LocalPortInput::Bad,
    }
}

pub fn ports_table(rows: &[ForwardRow]) -> String {
    rows.iter()
        .map(|row| {
            let local = row
                .local
                .map_or_else(|| "-".to_owned(), |port| port.to_string());
            let name = row.name.as_deref().unwrap_or("-");
            let error = row.error.as_deref().unwrap_or("-");
            format!("{}\t{local}\t{name}\t{error}", row.remote)
        })
        .collect::<Vec<_>>()
        .join("\n")
}
