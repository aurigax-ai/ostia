use ostia_base::js::utf16_len;
use serde_json::{Map, Number, Value};

use crate::remote_ports::{
    ForwardRow, HostPort, PortOp, PortsResult, remote_port_of, whole_number,
};

pub const LINK_FRAME_MAX: usize = 1024 * 1024;
pub const LINK_HEARTBEAT_MS: u64 = 15_000;
pub const LINK_DEAD_MS: u64 = 45_000;

const PORTS_FRAME_MAX: usize = 4096;
const ID_MAX: usize = 100;
const VERSION_MAX: usize = 64;
const REASON_MAX: usize = 64;
const PORT_NAME_MAX: usize = 64;
const FORWARD_ERROR_MAX: usize = 200;
const RESULT_ERROR_MAX: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub enum LinkFrame {
    Hello {
        version: String,
    },
    HelloOk {
        version: String,
    },
    Incompatible {
        version: String,
    },
    Mail {
        id: String,
        from: String,
        to: String,
        text: String,
    },
    Stored {
        id: String,
    },
    Refused {
        id: String,
        reason: String,
    },
    Hb,
    Ports {
        ports: Vec<HostPort>,
    },
    PortsReq {
        id: String,
        op: PortOp,
        remote: Option<u16>,
        local: Option<Number>,
    },
    PortsRes {
        id: String,
        result: PortsResult,
    },
}

fn text(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    let units = utf16_len(text);
    (units > 0 && units <= max).then(|| text.to_owned())
}

fn optional_text(item: &Map<String, Value>, key: &str, max: usize) -> Option<Option<String>> {
    match item.get(key) {
        None => Some(None),
        Some(value) => text(Some(value), max).map(Some),
    }
}

fn host_ports(value: Option<&Value>) -> Option<Vec<HostPort>> {
    let items = value?.as_array()?;
    if items.len() > PORTS_FRAME_MAX {
        return None;
    }
    items
        .iter()
        .map(|item| {
            let object = item.as_object()?;
            let port = remote_port_of(object.get("port")?)?;
            let name = optional_text(object, "name", PORT_NAME_MAX)?;
            Some(HostPort { port, name })
        })
        .collect()
}

fn forward_rows(value: Option<&Value>) -> Option<Vec<ForwardRow>> {
    let items = value?.as_array()?;
    if items.len() > PORTS_FRAME_MAX {
        return None;
    }
    items
        .iter()
        .map(|item| {
            let object = item.as_object()?;
            let remote = remote_port_of(object.get("remote")?)?;
            let name = optional_text(object, "name", PORT_NAME_MAX)?;
            let local = match object.get("local") {
                None => None,
                Some(value) => Some(remote_port_of(value)?),
            };
            let error = optional_text(object, "error", FORWARD_ERROR_MAX)?;
            Some(ForwardRow {
                remote,
                name,
                local,
                error,
            })
        })
        .collect()
}

fn ports_result(value: Option<&Value>) -> Option<PortsResult> {
    let raw = value?.as_object()?;
    match raw.get("ok") {
        Some(Value::Bool(true)) => forward_rows(raw.get("forwards")).map(PortsResult::Forwards),
        Some(Value::Bool(false)) => {
            text(raw.get("error"), RESULT_ERROR_MAX).map(PortsResult::Failed)
        }
        _ => None,
    }
}

fn whole_local(value: &Value) -> Option<Number> {
    let number = whole_number(value)?;
    if number.abs() < 9.0e15 {
        Some(Number::from(number as i64))
    } else {
        Number::from_f64(number)
    }
}

fn ports_request(raw: &Map<String, Value>) -> Option<LinkFrame> {
    let id = text(raw.get("id"), ID_MAX)?;
    let op = PortOp::parse(raw.get("op")?.as_str()?)?;
    let remote = match raw.get("remote") {
        None => None,
        Some(value) => Some(remote_port_of(value)?),
    };
    let local = match raw.get("local") {
        None => None,
        Some(value) => Some(whole_local(value)?),
    };
    Some(LinkFrame::PortsReq {
        id,
        op,
        remote,
        local,
    })
}

pub fn parse_frame(line: &str) -> Option<LinkFrame> {
    let parsed: Value = serde_json::from_str(line).ok()?;
    let raw = parsed.as_object()?;
    match raw.get("t")?.as_str()? {
        "hb" => Some(LinkFrame::Hb),
        "hello" => {
            text(raw.get("version"), VERSION_MAX).map(|version| LinkFrame::Hello { version })
        }
        "hello-ok" => {
            text(raw.get("version"), VERSION_MAX).map(|version| LinkFrame::HelloOk { version })
        }
        "incompatible" => {
            text(raw.get("version"), VERSION_MAX).map(|version| LinkFrame::Incompatible { version })
        }
        "stored" => text(raw.get("id"), ID_MAX).map(|id| LinkFrame::Stored { id }),
        "refused" => Some(LinkFrame::Refused {
            id: text(raw.get("id"), ID_MAX)?,
            reason: text(raw.get("reason"), REASON_MAX)?,
        }),
        "mail" => Some(LinkFrame::Mail {
            id: text(raw.get("id"), ID_MAX)?,
            from: text(raw.get("from"), ID_MAX)?,
            to: text(raw.get("to"), ID_MAX)?,
            text: text(raw.get("text"), LINK_FRAME_MAX)?,
        }),
        "ports" => host_ports(raw.get("ports")).map(|ports| LinkFrame::Ports { ports }),
        "ports-req" => ports_request(raw),
        "ports-res" => {
            let result = ports_result(raw.get("result"))?;
            Some(LinkFrame::PortsRes {
                id: text(raw.get("id"), ID_MAX)?,
                result,
            })
        }
        _ => None,
    }
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

impl LinkFrame {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Hello { version } => object(vec![
                ("t", "hello".into()),
                ("version", version.clone().into()),
            ]),
            Self::HelloOk { version } => object(vec![
                ("t", "hello-ok".into()),
                ("version", version.clone().into()),
            ]),
            Self::Incompatible { version } => object(vec![
                ("t", "incompatible".into()),
                ("version", version.clone().into()),
            ]),
            Self::Mail { id, from, to, text } => object(vec![
                ("t", "mail".into()),
                ("id", id.clone().into()),
                ("from", from.clone().into()),
                ("to", to.clone().into()),
                ("text", text.clone().into()),
            ]),
            Self::Stored { id } => object(vec![("t", "stored".into()), ("id", id.clone().into())]),
            Self::Refused { id, reason } => object(vec![
                ("t", "refused".into()),
                ("id", id.clone().into()),
                ("reason", reason.clone().into()),
            ]),
            Self::Hb => object(vec![("t", "hb".into())]),
            Self::Ports { ports } => object(vec![
                ("t", "ports".into()),
                (
                    "ports",
                    Value::Array(ports.iter().map(HostPort::to_json).collect()),
                ),
            ]),
            Self::PortsReq {
                id,
                op,
                remote,
                local,
            } => {
                let mut entries: Vec<(&str, Value)> = vec![
                    ("t", "ports-req".into()),
                    ("id", id.clone().into()),
                    ("op", op.as_str().into()),
                ];
                if let Some(remote) = remote {
                    entries.push(("remote", (*remote).into()));
                }
                if let Some(local) = local {
                    entries.push(("local", Value::Number(local.clone())));
                }
                object(entries)
            }
            Self::PortsRes { id, result } => object(vec![
                ("t", "ports-res".into()),
                ("id", id.clone().into()),
                ("result", result.to_json()),
            ]),
        }
    }
}

pub fn frame_line(frame: &LinkFrame) -> String {
    format!("{}\n", frame.to_json())
}
