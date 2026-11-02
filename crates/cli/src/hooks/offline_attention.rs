use ostia_base::Host;
use ostia_base::js::js_trim;
use ostia_base::js_json::parse_js_json;
use ostia_contract::attention::KeptAttentionState;
use ostia_contract::claude_attention::{ClaudeAttentionEvent, claude_attention};
use ostia_contract::codex_attention::{CodexAttentionEvent, codex_attention};
use ostia_terminal::attention_file::{SavedAttention, attention_file_for, write_saved_attention};
use serde_json::Value;

use crate::common::args::{FlagError, FlagSpec, UnknownFlags, parse_args};

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
    let Ok(parsed) = parse_js_json(text) else {
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
) -> Result<Option<OfflineAttention>, FlagError> {
    let Some((verb, rest)) = args.split_first() else {
        return Ok(None);
    };
    Ok(match *verb {
        "claude-hook" => rest
            .first()
            .and_then(|event| ClaudeAttentionEvent::parse(event))
            .map(|event| {
                saved_of(
                    claude_attention(event, &read_stdin())
                        .map(|attention| (attention.state, attention.message)),
                )
            }),
        "codex-hook" => rest
            .first()
            .and_then(|event| CodexAttentionEvent::parse(event))
            .map(|event| {
                saved_of(
                    codex_attention(event, &read_stdin())
                        .map(|attention| (attention.state, attention.message)),
                )
            }),
        "state" => state_attention(rest, read_stdin)?,
        _ => None,
    })
}

pub fn save_attention_offline(
    args: &[&str],
    read_stdin: &mut impl FnMut() -> String,
    host: &Host,
) -> Result<bool, FlagError> {
    let Some(token_file) = host.app_var("TOKEN_FILE") else {
        return Ok(false);
    };
    let Some(attention) = offline_attention(args, read_stdin)? else {
        return Ok(false);
    };
    let save = match attention {
        OfflineAttention::Silent => return Ok(true),
        OfflineAttention::Clear => None,
        OfflineAttention::Save(saved) => Some(saved),
    };
    Ok(write_saved_attention(&attention_file_for(token_file), save.as_ref()).is_ok())
}

fn saved_of(attention: Option<(KeptAttentionState, String)>) -> OfflineAttention {
    match attention {
        None => OfflineAttention::Silent,
        Some((state, message)) => OfflineAttention::Save(SavedAttention {
            state,
            message: (!message.is_empty()).then_some(message),
        }),
    }
}

fn state_attention(
    rest: &[&str],
    read_stdin: &mut impl FnMut() -> String,
) -> Result<Option<OfflineAttention>, FlagError> {
    let parsed = parse_args(rest, &STATE_FLAGS)?;
    let pane_given = parsed
        .values
        .get("pane")
        .is_some_and(|pane| !pane.is_empty());
    let state = parsed.positional.first().map_or("", String::as_str);
    if pane_given || state.is_empty() || !STATE_VERBS.contains(&state) {
        return Ok(None);
    }
    let Some(kept) = KeptAttentionState::parse(state) else {
        return Ok(Some(OfflineAttention::Clear));
    };
    let message = match parsed.positional.get(1).map(String::as_str) {
        Some("-") => message_from_stdin(&read_stdin()),
        raw => raw.unwrap_or("").to_owned(),
    };
    Ok(Some(OfflineAttention::Save(SavedAttention {
        state: kept,
        message: (!message.is_empty()).then_some(message),
    })))
}
