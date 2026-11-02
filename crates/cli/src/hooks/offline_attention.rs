use ostia_base::Host;
use ostia_base::js::js_trim;
use serde_json::Value;

use crate::common::args::{FlagSpec, UnknownFlags, parse_args};

use super::agent_attention::{
    AgentAttention, ClaudeAttentionEvent, CodexAttentionEvent, claude_attention, codex_attention,
};
use super::saved_attention::{
    KeptAttentionState, SavedAttention, attention_file_for, write_saved_attention,
};

pub const STATE_VERBS: [&str; 5] = ["waiting", "done", "working", "error", "clear"];

const STATE_FLAGS: FlagSpec = FlagSpec {
    values: &[("pane", "--pane")],
    lists: &[],
    booleans: &[("stop", "--stop")],
    unknown: UnknownFlags::Keep,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OfflineAttention {
    Silent,
    Clear,
    Save(SavedAttention),
}

pub fn message_from_stdin(raw: &str) -> String {
    let text = js_trim(raw);
    if !text.starts_with('{') {
        return text.to_owned();
    }
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return text.to_owned();
    };
    if let Some(message) = parsed.get("message").and_then(Value::as_str) {
        return message.to_owned();
    }
    parsed
        .get("tool_name")
        .and_then(Value::as_str)
        .map_or_else(String::new, |tool| {
            format!("Needs your permission to use {tool}")
        })
}

pub fn offline_attention(
    args: &[&str],
    read_stdin: &mut impl FnMut() -> String,
) -> Option<OfflineAttention> {
    let (verb, rest) = args.split_first()?;
    match *verb {
        "claude-hook" => {
            let event = ClaudeAttentionEvent::parse(rest.first()?)?;
            Some(saved_of(claude_attention(event, &read_stdin())))
        }
        "codex-hook" => {
            let event = CodexAttentionEvent::parse(rest.first()?)?;
            Some(saved_of(codex_attention(event, &read_stdin())))
        }
        "state" => state_attention(rest, read_stdin),
        _ => None,
    }
}

pub fn save_attention_offline(
    args: &[&str],
    read_stdin: &mut impl FnMut() -> String,
    host: &Host,
) -> bool {
    let Some(token_file) = host.app_var("TOKEN_FILE") else {
        return false;
    };
    let Some(attention) = offline_attention(args, read_stdin) else {
        return false;
    };
    let save = match attention {
        OfflineAttention::Silent => return true,
        OfflineAttention::Clear => None,
        OfflineAttention::Save(saved) => Some(saved),
    };
    write_saved_attention(&attention_file_for(token_file), save.as_ref()).is_ok()
}

fn saved_of(attention: Option<AgentAttention>) -> OfflineAttention {
    match attention {
        None => OfflineAttention::Silent,
        Some(attention) => OfflineAttention::Save(SavedAttention {
            state: attention.state,
            message: (!attention.message.is_empty()).then_some(attention.message),
        }),
    }
}

fn state_attention(
    rest: &[&str],
    read_stdin: &mut impl FnMut() -> String,
) -> Option<OfflineAttention> {
    let parsed = parse_args(rest, &STATE_FLAGS).ok()?;
    let pane_given = parsed
        .values
        .get("pane")
        .is_some_and(|pane| !pane.is_empty());
    let state = parsed.positional.first().map_or("", String::as_str);
    if pane_given || state.is_empty() || !STATE_VERBS.contains(&state) {
        return None;
    }
    let Some(kept) = KeptAttentionState::parse(state) else {
        return Some(OfflineAttention::Clear);
    };
    let message = match parsed.positional.get(1).map(String::as_str) {
        Some("-") => message_from_stdin(&read_stdin()),
        raw => raw.unwrap_or("").to_owned(),
    };
    Some(OfflineAttention::Save(SavedAttention {
        state: kept,
        message: (!message.is_empty()).then_some(message),
    }))
}
