use std::fmt;

use ostia_base::js::utf16_len;
use ostia_contract::agent_stream::StreamEvent;
use serde::Serialize;
use serde_json::{Map, Value, json};

const BODY_FIELDS: [&str; 5] = ["text", "input", "output", "diff", "target"];
const LONE_SURROGATE_ESCAPE_BYTES: usize = 6;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameTooLarge {
    message: String,
}

impl FrameTooLarge {
    pub fn new(message: &str) -> Self {
        Self {
            message: message.to_owned(),
        }
    }
}

impl fmt::Display for FrameTooLarge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FrameTooLarge {}

#[derive(Clone, Debug, PartialEq)]
pub struct StreamPiece(Value);

impl StreamPiece {
    pub fn as_value(&self) -> &Value {
        &self.0
    }

    pub fn into_value(self) -> Value {
        self.0
    }
}

impl PartialEq<StreamEvent> for StreamPiece {
    fn eq(&self, other: &StreamEvent) -> bool {
        serde_json::to_value(other).is_ok_and(|value| value == self.0)
    }
}

fn bytes<T: Serialize>(value: &T) -> usize {
    serde_json::to_string(value).map_or(usize::MAX, |text| text.len())
}

fn record_of(event: &StreamEvent) -> Result<Map<String, Value>, FrameTooLarge> {
    match serde_json::to_value(event) {
        Ok(Value::Object(record)) => Ok(record),
        _ => Err(FrameTooLarge::new("event is not an object")),
    }
}

fn body_of(record: &Map<String, Value>) -> Option<&'static str> {
    let mut longest: Option<(&'static str, usize)> = None;
    for field in BODY_FIELDS {
        let Some(Value::String(value)) = record.get(field) else {
            continue;
        };
        let length = utf16_len(value);
        if longest.is_none_or(|(_, best)| length > best) {
            longest = Some((field, length));
        }
    }
    longest.map(|(field, _)| field)
}

fn json_char_bytes(ch: char) -> usize {
    match ch {
        '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
        '\u{0}'..='\u{1f}' => 6,
        other => other.len_utf8(),
    }
}

fn cumulative_bytes(text: &str, units: usize) -> Vec<usize> {
    let mut cumulative = Vec::with_capacity(units + 1);
    cumulative.push(0);
    let mut total = 0;
    for ch in text.chars() {
        if cumulative.len() > units {
            break;
        }
        let cost = json_char_bytes(ch);
        if ch.len_utf16() == 2 {
            cumulative.push(total + LONE_SURROGATE_ESCAPE_BYTES);
        }
        total += cost;
        cumulative.push(total);
    }
    cumulative.truncate(units + 1);
    cumulative
}

fn prefix_length(
    text: &str,
    units: usize,
    max_chars: usize,
    fits: impl Fn(usize) -> bool,
) -> usize {
    let mut low = 1;
    let mut high = units.min(max_chars);
    while low < high {
        let mid = (low + high).div_ceil(2);
        if fits(mid) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    let mut seen = 0;
    for ch in text.chars() {
        let width = ch.len_utf16();
        if seen + width > low {
            return if seen == 0 { width } else { seen };
        }
        seen += width;
        if seen == low {
            break;
        }
    }
    low
}

fn byte_offset(text: &str, units: usize) -> usize {
    let mut seen = 0;
    for (offset, ch) in text.char_indices() {
        if seen >= units {
            return offset;
        }
        seen += ch.len_utf16();
    }
    text.len()
}

fn with_field(record: &Map<String, Value>, field: &str, text: &str) -> Map<String, Value> {
    let mut copy = record.clone();
    copy.insert(field.to_owned(), Value::String(text.to_owned()));
    copy
}

fn continuation_shell(record: &Map<String, Value>) -> Map<String, Value> {
    let mut shell = Map::new();
    for key in ["type", "turn", "id"] {
        if let Some(value) = record.get(key) {
            shell.insert(key.to_owned(), value.clone());
        }
    }
    shell.insert("append".to_owned(), Value::Bool(true));
    shell
}

fn split_text(
    record: &Map<String, Value>,
    field: &str,
    budget: usize,
) -> Result<Vec<Map<String, Value>>, FrameTooLarge> {
    let text = record
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default();
    let emptied = with_field(record, field, "");
    let mut pieces = Vec::new();
    let mut head = true;
    if bytes(&emptied) > budget {
        if body_of(&emptied).is_none_or(|next| {
            emptied
                .get(next)
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        }) {
            return Err(FrameTooLarge::new("event does not fit a frame"));
        }
        pieces.extend(split_record(&emptied, budget)?);
        head = false;
    }
    let mut rest = text;
    let mut rest_units = utf16_len(text);
    while !rest.is_empty() {
        let mut shell = if head {
            emptied.clone()
        } else {
            continuation_shell(record)
        };
        shell.insert(field.to_owned(), Value::String(String::new()));
        let base = bytes(&shell);
        let cumulative = cumulative_bytes(rest, rest_units.min(budget));
        let take = prefix_length(rest, rest_units, budget, |units| {
            cumulative
                .get(units)
                .is_some_and(|cost| base + cost <= budget)
        });
        let offset = byte_offset(rest, take);
        pieces.push(with_field(&shell, field, &rest[..offset]));
        rest = &rest[offset..];
        rest_units -= take;
        head = false;
    }
    Ok(pieces)
}

fn split_plan(
    record: &Map<String, Value>,
    budget: usize,
) -> Result<Vec<Map<String, Value>>, FrameTooLarge> {
    let source: &[Value] = record
        .get("items")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    let mut shell_record = record.clone();
    shell_record.insert("items".to_owned(), Value::Array(Vec::new()));
    shell_record.insert("append".to_owned(), Value::Bool(true));
    let shell = bytes(&shell_record);
    let mut pieces: Vec<Map<String, Value>> = Vec::new();
    let mut items: Vec<Value> = Vec::new();
    let mut size = shell;
    let mut flush = |items: &mut Vec<Value>, size: &mut usize| {
        if items.is_empty() {
            return;
        }
        let mut piece = record.clone();
        piece.insert("items".to_owned(), Value::Array(std::mem::take(items)));
        if !pieces.is_empty() {
            piece.insert("append".to_owned(), Value::Bool(true));
        }
        pieces.push(piece);
        *size = shell;
    };
    for item in source {
        let item_bytes = bytes(item);
        let grown = size + item_bytes + usize::from(!items.is_empty());
        if !items.is_empty() && grown > budget {
            flush(&mut items, &mut size);
        }
        size += item_bytes + usize::from(!items.is_empty());
        items.push(item.clone());
    }
    flush(&mut items, &mut size);
    if pieces.iter().any(|piece| bytes(piece) > budget) {
        return Err(FrameTooLarge::new("plan item too large"));
    }
    Ok(pieces)
}

fn split_record(
    record: &Map<String, Value>,
    budget: usize,
) -> Result<Vec<Map<String, Value>>, FrameTooLarge> {
    if bytes(record) <= budget {
        return Ok(vec![record.clone()]);
    }
    if record.get("type").and_then(Value::as_str) == Some("plan") {
        return split_plan(record, budget);
    }
    match body_of(record) {
        Some(field) => split_text(record, field, budget),
        None => Err(FrameTooLarge::new("event has nothing to split")),
    }
}

pub fn split_event(event: &StreamEvent, budget: usize) -> Result<Vec<StreamPiece>, FrameTooLarge> {
    let pieces = split_record(&record_of(event)?, budget)?;
    Ok(pieces
        .into_iter()
        .map(|piece| StreamPiece(Value::Object(piece)))
        .collect())
}

fn envelope(pane_id: &str, seq: u64, backfill: bool, events: Vec<Map<String, Value>>) -> String {
    let mut payload = Map::new();
    payload.insert("paneId".to_owned(), json!(pane_id));
    payload.insert("seq".to_owned(), json!(seq));
    if backfill {
        payload.insert("backfill".to_owned(), Value::Bool(true));
    }
    payload.insert(
        "events".to_owned(),
        Value::Array(events.into_iter().map(Value::Object).collect()),
    );
    json!({
        "jsonrpc": "2.0",
        "method": "event",
        "params": {"type": "agent.stream", "payload": Value::Object(payload)},
    })
    .to_string()
}

pub fn pack_frames(
    pane_id: &str,
    first_seq: u64,
    backfill: bool,
    events: &[StreamEvent],
    max_bytes: usize,
) -> Result<Vec<String>, FrameTooLarge> {
    let empty = envelope(pane_id, first_seq + 9_999_999, backfill, Vec::new());
    let budget = max_bytes.saturating_sub(empty.len() + 2);
    let mut frames = Vec::new();
    let mut current: Vec<Map<String, Value>> = Vec::new();
    let mut used = 0usize;
    let mut seq = first_seq;
    for event in events {
        for piece in split_record(&record_of(event)?, budget)? {
            let size = bytes(&piece) + 1;
            if size - 1 > budget {
                return Err(FrameTooLarge::new("event does not fit a frame"));
            }
            if used + size > budget && !current.is_empty() {
                frames.push(envelope(
                    pane_id,
                    seq,
                    backfill,
                    std::mem::take(&mut current),
                ));
                seq += 1;
                used = 0;
            }
            current.push(piece);
            used += size;
        }
    }
    if !current.is_empty() {
        frames.push(envelope(pane_id, seq, backfill, current));
    }
    Ok(frames)
}
