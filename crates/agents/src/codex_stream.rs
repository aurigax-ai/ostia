use serde_json::{Map, Number, Value};

use ostia_contract::agent_stream::{EditChange, PlanItem, PlanStatus, StreamEvent, TurnEnd};
use ostia_contract::turn_hook::TurnStepKind;

const FAILED: [&str; 2] = ["failed", "declined"];

fn field<'a>(object: &'a Map<String, Value>, key: &str) -> &'a str {
    object.get(key).and_then(Value::as_str).unwrap_or("")
}

fn nested_field<'a>(object: &'a Map<String, Value>, key: &str, inner: &str) -> &'a str {
    object
        .get(key)
        .and_then(Value::as_object)
        .map_or("", |child| field(child, inner))
}

fn is_failed(status: &str) -> bool {
    FAILED.contains(&status)
}

fn user_text(content: Option<&Value>) -> String {
    content
        .and_then(Value::as_array)
        .map_or_else(String::new, |parts| {
            parts
                .iter()
                .map(|part| {
                    part.as_object()
                        .filter(|part| field(part, "type") == "text")
                        .map_or("", |part| field(part, "text"))
                })
                .collect()
        })
}

fn json_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(part)
            if field(part, "type") == "text" && part.get("text").is_some_and(Value::is_string) =>
        {
            field(part, "text").to_owned()
        }
        other => other.to_string(),
    }
}

fn mcp_output(item: &Map<String, Value>) -> String {
    if let Some(error) = item.get("error").and_then(Value::as_object) {
        return field(error, "message").to_owned();
    }
    item.get("result")
        .and_then(Value::as_object)
        .and_then(|result| result.get("content"))
        .and_then(Value::as_array)
        .map_or_else(String::new, |parts| {
            parts.iter().map(json_text).collect::<Vec<_>>().join("\n")
        })
}

fn dynamic_output(item: &Map<String, Value>) -> String {
    item.get("contentItems")
        .and_then(Value::as_array)
        .map_or_else(String::new, |parts| {
            parts
                .iter()
                .map(|part| part.as_object().map_or("", |part| field(part, "text")))
                .collect()
        })
}

fn change_of(kind: Option<&Value>) -> EditChange {
    let kind_type = match kind {
        Some(Value::Object(object)) => object.get("type"),
        other => other,
    };
    match kind_type.and_then(Value::as_str) {
        Some("add") => EditChange::Add,
        Some("delete") => EditChange::Delete,
        _ => EditChange::Update,
    }
}

fn file_changes(item: &Map<String, Value>) -> Vec<&Map<String, Value>> {
    item.get("changes")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |list| {
            list.iter().filter_map(Value::as_object).collect()
        })
}

fn search_target(item: &Map<String, Value>) -> String {
    let action = item.get("action").and_then(Value::as_object);
    let url = action.map_or("", |action| field(action, "url"));
    let pattern = action.map_or("", |action| field(action, "pattern"));
    [field(item, "query"), url]
        .into_iter()
        .find(|candidate| !candidate.is_empty())
        .unwrap_or(pattern)
        .to_owned()
}

fn plan_status(status: &str) -> PlanStatus {
    match status {
        "inProgress" => PlanStatus::Active,
        "completed" => PlanStatus::Done,
        _ => PlanStatus::Pending,
    }
}

fn turn_end(status: &str) -> TurnEnd {
    match status {
        "interrupted" => TurnEnd::Interrupted,
        "failed" => TurnEnd::Failed,
        _ => TurnEnd::Done,
    }
}

fn tool(
    turn: &str,
    id: &str,
    kind: TurnStepKind,
    name: &str,
    target: Option<String>,
    input: Option<String>,
) -> StreamEvent {
    StreamEvent::Tool {
        turn: turn.to_owned(),
        id: id.to_owned(),
        kind,
        name: name.to_owned(),
        target,
        input,
        append: false,
    }
}

fn tool_result(
    turn: &str,
    id: &str,
    output: String,
    exit_code: Option<Number>,
    failed: bool,
) -> StreamEvent {
    StreamEvent::ToolResult {
        turn: turn.to_owned(),
        id: id.to_owned(),
        output,
        exit_code,
        is_error: failed,
        append: false,
    }
}

fn command_execution(
    item: &Map<String, Value>,
    turn: &str,
    id: &str,
    done: bool,
) -> Vec<StreamEvent> {
    let mut events = vec![tool(
        turn,
        id,
        TurnStepKind::Command,
        "shell",
        None,
        Some(field(item, "command").to_owned()),
    )];
    if done {
        let exit_code = item.get("exitCode").and_then(Value::as_number).cloned();
        let failed = is_failed(field(item, "status"))
            || exit_code
                .as_ref()
                .is_some_and(|code| code.as_f64() != Some(0.0));
        events.push(tool_result(
            turn,
            id,
            field(item, "aggregatedOutput").to_owned(),
            exit_code,
            failed,
        ));
    }
    events
}

fn file_change(item: &Map<String, Value>, turn: &str, id: &str, done: bool) -> Vec<StreamEvent> {
    let changes = file_changes(item);
    let target = changes
        .iter()
        .map(|change| field(change, "path"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut events = vec![tool(
        turn,
        id,
        TurnStepKind::Edit,
        "apply_patch",
        Some(target),
        None,
    )];
    if done {
        let status = field(item, "status");
        let failed = is_failed(status);
        if !failed {
            for (index, change) in changes.iter().enumerate() {
                events.push(StreamEvent::Edit {
                    turn: turn.to_owned(),
                    id: format!("{id}:{index}"),
                    path: field(change, "path").to_owned(),
                    change: change_of(change.get("kind")),
                    diff: field(change, "diff").to_owned(),
                    append: false,
                });
            }
        }
        events.push(tool_result(turn, id, status.to_owned(), None, failed));
    }
    events
}

fn tool_call(
    item: &Map<String, Value>,
    turn: &str,
    id: &str,
    done: bool,
    name: &str,
    output: fn(&Map<String, Value>) -> String,
) -> Vec<StreamEvent> {
    let args = item
        .get("arguments")
        .map_or_else(String::new, |args| args.to_string());
    let input = (!args.is_empty() && args != "{}").then_some(args);
    let mut events = vec![tool(turn, id, TurnStepKind::Other, name, None, input)];
    if done {
        let failed = is_failed(field(item, "status"))
            || item.get("error").is_some_and(Value::is_object)
            || item.get("success") == Some(&Value::Bool(false));
        events.push(tool_result(turn, id, output(item), None, failed));
    }
    events
}

fn web_search(item: &Map<String, Value>, turn: &str, id: &str, done: bool) -> Vec<StreamEvent> {
    let mut events = vec![tool(
        turn,
        id,
        TurnStepKind::Web,
        "web_search",
        Some(search_target(item)),
        None,
    )];
    if done {
        events.push(tool_result(turn, id, String::new(), None, false));
    }
    events
}

fn codex_item(raw: &Value, turn: &str, done: bool) -> Vec<StreamEvent> {
    let Some(item) = raw.as_object() else {
        return Vec::new();
    };
    let id = field(item, "id");
    if id.is_empty() {
        return Vec::new();
    }
    match item.get("type").and_then(Value::as_str) {
        Some("userMessage") => {
            let text = user_text(item.get("content"));
            if done && !text.is_empty() {
                vec![StreamEvent::Prompt {
                    turn: turn.to_owned(),
                    id: id.to_owned(),
                    text,
                    append: false,
                }]
            } else {
                Vec::new()
            }
        }
        Some("agentMessage") => {
            let text = field(item, "text");
            if done && !text.is_empty() {
                vec![StreamEvent::Text {
                    turn: turn.to_owned(),
                    id: id.to_owned(),
                    text: text.to_owned(),
                    append: false,
                }]
            } else {
                Vec::new()
            }
        }
        Some("commandExecution") => command_execution(item, turn, id, done),
        Some("fileChange") => file_change(item, turn, id, done),
        Some("mcpToolCall") => {
            let name = format!("{}/{}", field(item, "server"), field(item, "tool"));
            tool_call(item, turn, id, done, &name, mcp_output)
        }
        Some("dynamicToolCall") => {
            tool_call(item, turn, id, done, field(item, "tool"), dynamic_output)
        }
        Some("webSearch") => web_search(item, turn, id, done),
        _ => Vec::new(),
    }
}

fn plan_event(params: &Map<String, Value>, turn: &str) -> Vec<StreamEvent> {
    let items: Vec<PlanItem> =
        params
            .get("plan")
            .and_then(Value::as_array)
            .map_or_else(Vec::new, |steps| {
                steps
                    .iter()
                    .filter_map(Value::as_object)
                    .map(|step| PlanItem {
                        text: field(step, "step").to_owned(),
                        status: plan_status(field(step, "status")),
                    })
                    .collect()
            });
    vec![StreamEvent::Plan {
        turn: turn.to_owned(),
        id: format!("plan:{turn}"),
        items,
        append: false,
    }]
}

pub fn codex_notification(method: &str, raw: &Value) -> Vec<StreamEvent> {
    let empty = Map::new();
    let params = raw.as_object().unwrap_or(&empty);
    let turn_id = field(params, "turnId");
    match method {
        "turn/started" => {
            let id = nested_field(params, "turn", "id");
            if id.is_empty() {
                Vec::new()
            } else {
                vec![StreamEvent::TurnStarted {
                    turn: id.to_owned(),
                }]
            }
        }
        "turn/completed" => {
            let id = nested_field(params, "turn", "id");
            if id.is_empty() {
                Vec::new()
            } else {
                let status = nested_field(params, "turn", "status");
                vec![StreamEvent::TurnEnded {
                    turn: id.to_owned(),
                    status: turn_end(status),
                }]
            }
        }
        "item/started" => codex_item(params.get("item").unwrap_or(&Value::Null), turn_id, false),
        "item/completed" => codex_item(params.get("item").unwrap_or(&Value::Null), turn_id, true),
        "item/agentMessage/delta" => {
            let delta = field(params, "delta");
            if delta.is_empty() {
                Vec::new()
            } else {
                vec![StreamEvent::Text {
                    turn: turn_id.to_owned(),
                    id: field(params, "itemId").to_owned(),
                    text: delta.to_owned(),
                    append: true,
                }]
            }
        }
        "item/commandExecution/outputDelta" => {
            let delta = field(params, "delta");
            if delta.is_empty() {
                Vec::new()
            } else {
                vec![StreamEvent::ToolResult {
                    turn: turn_id.to_owned(),
                    id: field(params, "itemId").to_owned(),
                    output: delta.to_owned(),
                    exit_code: None,
                    is_error: false,
                    append: true,
                }]
            }
        }
        "turn/plan/updated" => plan_event(params, turn_id),
        _ => Vec::new(),
    }
}

pub fn codex_turn(raw: &Value) -> Vec<StreamEvent> {
    let Some(turn) = raw.as_object() else {
        return Vec::new();
    };
    let id = field(turn, "id");
    if id.is_empty() {
        return Vec::new();
    }
    let mut events = vec![StreamEvent::TurnStarted {
        turn: id.to_owned(),
    }];
    for item in turn
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        events.extend(codex_item(item, id, true));
    }
    let status = field(turn, "status");
    if status != "inProgress" {
        events.push(StreamEvent::TurnEnded {
            turn: id.to_owned(),
            status: turn_end(status),
        });
    }
    events
}
