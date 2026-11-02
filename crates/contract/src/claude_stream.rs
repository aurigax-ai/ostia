use std::collections::HashMap;

use serde_json::{Map, Number, Value};

use crate::agent_stream::{EditChange, PlanItem, PlanStatus, StreamEvent, TurnEnd};
use crate::turn_hook::TurnStepKind;
use ostia_base::js::{is_js_space, js_number, js_number_text, js_trim};

const NOT_A_PROMPT: [&str; 3] = ["<local-command", "<command-name", "<command-message"];
const EXIT_CODE_PREFIX: &str = "Exit code ";

struct ToolSpec {
    kind: TurnStepKind,
    target: &'static [&'static str],
    input: &'static [&'static str],
}

fn tool_spec(name: &str) -> Option<ToolSpec> {
    let (kind, target, input): (
        TurnStepKind,
        &'static [&'static str],
        &'static [&'static str],
    ) = match name {
        "Edit" | "MultiEdit" | "Write" => (TurnStepKind::Edit, &["file_path"], &[]),
        "NotebookEdit" => (TurnStepKind::Edit, &["notebook_path"], &[]),
        "Bash" => (TurnStepKind::Command, &[], &["command"]),
        "Grep" | "Glob" => (TurnStepKind::Search, &[], &["pattern"]),
        "Read" => (TurnStepKind::Read, &["file_path"], &[]),
        "Task" | "Agent" => (TurnStepKind::Subagent, &[], &["description", "prompt"]),
        "WebFetch" => (TurnStepKind::Web, &["url"], &[]),
        "WebSearch" => (TurnStepKind::Web, &[], &["query"]),
        _ => return None,
    };
    Some(ToolSpec {
        kind,
        target,
        input,
    })
}

fn plan_status(status: Option<&Value>) -> PlanStatus {
    let mut value = status;
    while let Some(Value::Array(items)) = value {
        if items.len() != 1 {
            return PlanStatus::Pending;
        }
        value = items.first();
    }
    match value.and_then(Value::as_str) {
        Some("in_progress") => PlanStatus::Active,
        Some("completed") => PlanStatus::Done,
        _ => PlanStatus::Pending,
    }
}

fn parse(line: &str) -> Option<Map<String, Value>> {
    if line.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(record)) => Some(record),
        _ => None,
    }
}

fn text_parts(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                let part = part.as_object()?;
                if part.get("type").and_then(Value::as_str) != Some("text") {
                    return None;
                }
                part.get("text").and_then(Value::as_str)
            })
            .collect(),
        _ => String::new(),
    }
}

fn js_display(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number
            .as_f64()
            .map_or_else(|| number.to_string(), js_number_text),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_display(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

fn first_string(input: &Map<String, Value>, fields: &[&str]) -> Option<String> {
    fields.iter().find_map(|field| {
        input
            .get(*field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn input_text(name: &str, input: &Map<String, Value>) -> Option<String> {
    if let Some(spec) = tool_spec(name) {
        return first_string(input, spec.input);
    }
    if input.is_empty() {
        return None;
    }
    serde_json::to_string(input).ok()
}

fn plan_items(input: &Map<String, Value>) -> Vec<PlanItem> {
    let Some(todos) = input.get("todos").and_then(Value::as_array) else {
        return Vec::new();
    };
    todos
        .iter()
        .filter_map(|todo| {
            let todo = todo.as_object()?;
            let content = todo.get("content")?.as_str()?;
            Some(PlanItem {
                text: content.to_owned(),
                status: plan_status(todo.get("status")),
            })
        })
        .collect()
}

fn patch_diff(path: &str, hunks: &[Value]) -> String {
    let mut lines = vec![format!("--- a/{path}"), format!("+++ b/{path}")];
    for hunk in hunks {
        let Some(hunk) = hunk.as_object() else {
            continue;
        };
        let Some(body) = hunk.get("lines").and_then(Value::as_array) else {
            continue;
        };
        lines.push(format!(
            "@@ -{},{} +{},{} @@",
            js_display(hunk.get("oldStart")),
            js_display(hunk.get("oldLines")),
            js_display(hunk.get("newStart")),
            js_display(hunk.get("newLines")),
        ));
        for line in body {
            lines.push(js_display(Some(line)));
        }
    }
    lines.join("\n")
}

fn create_diff(path: &str, content: &str) -> String {
    let body: Vec<&str> = content.split('\n').collect();
    let mut lines = vec![
        "--- /dev/null".to_owned(),
        format!("+++ b/{path}"),
        format!("@@ -0,0 +1,{} @@", body.len()),
    ];
    lines.extend(body.iter().map(|line| format!("+{line}")));
    lines.join("\n")
}

struct Edited {
    path: String,
    change: EditChange,
    diff: String,
}

fn edit_of(result: &Map<String, Value>) -> Option<Edited> {
    let path = result.get("filePath")?.as_str()?;
    if result.get("type").and_then(Value::as_str) == Some("create")
        && let Some(content) = result.get("content").and_then(Value::as_str)
    {
        return Some(Edited {
            path: path.to_owned(),
            change: EditChange::Add,
            diff: create_diff(path, content),
        });
    }
    let hunks = result.get("structuredPatch")?.as_array()?;
    Some(Edited {
        path: path.to_owned(),
        change: EditChange::Update,
        diff: patch_diff(path, hunks),
    })
}

fn exit_number(digits: &str) -> Option<Number> {
    let value = js_number(digits);
    if !value.is_finite() {
        return None;
    }
    if value.fract() == 0.0 && value.abs() < i64::MAX as f64 {
        Some(Number::from(value as i64))
    } else {
        Number::from_f64(value)
    }
}

fn exit_code_in(output: &str) -> Option<&str> {
    let rest = output.strip_prefix(EXIT_CODE_PREFIX)?;
    let end = rest
        .find(|ch: char| !ch.is_ascii_digit())
        .unwrap_or(rest.len());
    (end > 0).then(|| &rest[..end])
}

fn is_record_flag(entry: &Map<String, Value>, key: &str) -> bool {
    entry.get(key) == Some(&Value::Bool(true))
}

struct OpenTool {
    name: String,
    plan: bool,
}

#[derive(Default)]
pub struct ClaudeStream {
    turn: Option<String>,
    implicit: usize,
    tools: HashMap<String, OpenTool>,
}

impl ClaudeStream {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, lines: &[String]) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        for line in lines {
            if let Some(entry) = parse(line) {
                self.entry(&entry, &mut out);
            }
        }
        out
    }

    fn begin(&mut self, out: &mut Vec<StreamEvent>, id: String) {
        self.finish(out, TurnEnd::Interrupted);
        self.turn = Some(id.clone());
        out.push(StreamEvent::TurnStarted { turn: id });
    }

    fn finish(&mut self, out: &mut Vec<StreamEvent>, status: TurnEnd) {
        if let Some(turn) = self.turn.take() {
            out.push(StreamEvent::TurnEnded { turn, status });
        }
    }

    fn current(&mut self, out: &mut Vec<StreamEvent>) -> String {
        if let Some(turn) = &self.turn {
            return turn.clone();
        }
        self.implicit += 1;
        let turn = format!("t{}", self.implicit);
        self.turn = Some(turn.clone());
        out.push(StreamEvent::TurnStarted { turn: turn.clone() });
        turn
    }

    fn entry(&mut self, entry: &Map<String, Value>, out: &mut Vec<StreamEvent>) {
        let entry_type = entry.get("type").and_then(Value::as_str);
        if entry_type == Some("system")
            && entry.get("subtype").and_then(Value::as_str) == Some("turn_duration")
        {
            self.finish(out, TurnEnd::Done);
            return;
        }
        let Some(message) = entry.get("message").and_then(Value::as_object) else {
            return;
        };
        if is_record_flag(entry, "isSidechain") {
            return;
        }
        if entry_type == Some("user") && !is_record_flag(entry, "isMeta") {
            self.user(entry, message, out);
        } else if entry_type == Some("assistant") {
            self.assistant(entry, message, out);
        }
    }

    fn user(
        &mut self,
        entry: &Map<String, Value>,
        message: &Map<String, Value>,
        out: &mut Vec<StreamEvent>,
    ) {
        let content = message.get("content");
        let results: Vec<&Map<String, Value>> = content
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(Value::as_object)
                    .filter(|block| {
                        block.get("type").and_then(Value::as_str) == Some("tool_result")
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !results.is_empty() {
            for block in results {
                self.result(entry, block, out);
            }
            return;
        }
        let prompt = text_parts(content);
        if js_trim(&prompt).is_empty() {
            return;
        }
        let head = prompt.trim_start_matches(is_js_space);
        if NOT_A_PROMPT.iter().any(|prefix| head.starts_with(prefix)) {
            return;
        }
        let id = match entry.get("uuid").and_then(Value::as_str) {
            Some(uuid) => uuid.to_owned(),
            None => format!("p{}", self.implicit + 1),
        };
        self.begin(out, id.clone());
        out.push(StreamEvent::Prompt {
            turn: id.clone(),
            id,
            text: prompt,
            append: false,
        });
    }

    fn assistant(
        &mut self,
        entry: &Map<String, Value>,
        message: &Map<String, Value>,
        out: &mut Vec<StreamEvent>,
    ) {
        let uuid = entry.get("uuid").and_then(Value::as_str).unwrap_or("a");
        let empty = Vec::new();
        let blocks = message
            .get("content")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        for (index, block) in blocks.iter().enumerate() {
            let Some(block) = block.as_object() else {
                continue;
            };
            let block_type = block.get("type").and_then(Value::as_str);
            let text = block.get("text").and_then(Value::as_str);
            if block_type == Some("text")
                && let Some(text) = text.filter(|text| !js_trim(text).is_empty())
            {
                let turn = self.current(out);
                out.push(StreamEvent::Text {
                    turn,
                    id: format!("{uuid}:{index}"),
                    text: text.to_owned(),
                    append: false,
                });
            } else if block_type == Some("tool_use")
                && block.get("name").is_some_and(Value::is_string)
            {
                self.tool(block, out);
            }
        }
        if message.get("stop_reason").and_then(Value::as_str) == Some("end_turn") {
            self.finish(out, TurnEnd::Done);
        }
    }

    fn tool(&mut self, block: &Map<String, Value>, out: &mut Vec<StreamEvent>) {
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let id = match block.get("id").and_then(Value::as_str) {
            Some(id) => id.to_owned(),
            None => format!("{name}{}", self.tools.len()),
        };
        let empty = Map::new();
        let input = block
            .get("input")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let turn = self.current(out);
        if name == "TodoWrite" {
            self.tools.insert(id.clone(), OpenTool { name, plan: true });
            out.push(StreamEvent::Plan {
                turn,
                id,
                items: plan_items(input),
                append: false,
            });
            return;
        }
        let spec = tool_spec(&name);
        let target = spec
            .as_ref()
            .and_then(|spec| first_string(input, spec.target));
        let detail = input_text(&name, input);
        let kind = spec.map_or(TurnStepKind::Other, |spec| spec.kind);
        self.tools.insert(
            id.clone(),
            OpenTool {
                name: name.clone(),
                plan: false,
            },
        );
        out.push(StreamEvent::Tool {
            turn,
            id,
            kind,
            name,
            target,
            input: detail,
            append: false,
        });
    }

    fn result(
        &mut self,
        entry: &Map<String, Value>,
        block: &Map<String, Value>,
        out: &mut Vec<StreamEvent>,
    ) {
        let id = block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let Some(open) = self.tools.get(&id) else {
            return;
        };
        if open.plan {
            return;
        }
        let is_command =
            tool_spec(&open.name).is_some_and(|spec| spec.kind == TurnStepKind::Command);
        self.tools.remove(&id);
        let turn = self.current(out);
        let output = text_parts(block.get("content"));
        let is_error = is_record_flag(block, "is_error");
        let exit_code = if is_command {
            match exit_code_in(&output) {
                Some(digits) => exit_number(digits),
                None if is_error => None,
                None => Some(Number::from(0)),
            }
        } else {
            None
        };
        let edit = entry
            .get("toolUseResult")
            .and_then(Value::as_object)
            .and_then(edit_of);
        if let Some(edit) = edit
            && !is_error
        {
            out.push(StreamEvent::Edit {
                turn: turn.clone(),
                id: id.clone(),
                path: edit.path,
                change: edit.change,
                diff: edit.diff,
                append: false,
            });
        }
        out.push(StreamEvent::ToolResult {
            turn,
            id,
            output,
            exit_code,
            is_error,
            append: false,
        });
    }
}
