use std::sync::LazyLock;

use ostia_base::PRODUCT_NAME;
use ostia_base::js::{js_trim, static_regex};
use regex::Regex;
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::utf16_prefix::utf16_prefix;

pub const AGENT_PLUGIN_CAPABILITY: &str = "agent-plugin";

pub const HOOK_AGENTS: [&str; 2] = ["claude", "codex"];

pub const AGENT_HOOK_EVENTS: [&str; 7] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionEnd",
    "Notification",
];

pub const AGENT_HOOK_CONTEXT_EVENTS: [&str; 2] = ["SessionStart", "UserPromptSubmit"];

const CLAUDE_ONLY_EVENTS: [&str; 1] = ["Notification"];

pub static AGENT_SKILL_NAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z][a-z0-9-]{0,39}$"));
pub static AGENT_SKILL_FILE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,59}\.(md|txt)$"));

pub const AGENT_SKILL_ENTRY: &str = "SKILL.md";
pub const MAX_AGENT_SKILLS: usize = 8;
pub const MAX_AGENT_SKILL_FILES: usize = 16;
pub const MAX_AGENT_HOOKS: usize = 16;
pub const AGENT_SKILL_FILE_MAX_BYTES: usize = 256 * 1024;
pub const AGENT_SKILL_MAX_BYTES: usize = 1024 * 1024;
pub const AGENT_SKILL_DESCRIPTION_MAX: usize = 1024;
pub const AGENT_HOOK_INPUT_MAX: usize = 1024 * 1024;
pub const AGENT_HOOK_CONTEXT_MAX: usize = 10_000;

pub const RESERVED_SKILL_IDS: [&str; 2] = [PRODUCT_NAME, "ostia-manager"];

static LINE_BREAK: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"\r\n|[\n\r\x{0085}\x{2028}\x{2029}]"));
static INLINE_INJECTION: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"[!\x{01c3}][`\x{02cb}\x{02f4}\x{2035}$]"));
static FENCED_INJECTION: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?:[`\x{02cb}\x{02f4}\x{2035}]{3,}|~{3,})[ \t]*[!\x{01c3}$]"));

pub fn hook_agents_for(event: &str) -> Vec<&'static str> {
    if CLAUDE_ONLY_EVENTS.contains(&event) {
        vec!["claude"]
    } else {
        HOOK_AGENTS.to_vec()
    }
}

pub fn is_hook_agent(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|name| HOOK_AGENTS.contains(&name))
}

pub fn is_agent_hook_event(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|name| AGENT_HOOK_EVENTS.contains(&name))
}

pub fn agent_skill_id(extension_id: &str, name: &str) -> String {
    format!("{extension_id}-{name}")
}

pub fn agent_hook_output(event: &str, text: Option<&str>) -> Option<String> {
    if !AGENT_HOOK_CONTEXT_EVENTS.contains(&event) {
        return None;
    }
    let context = utf16_prefix(js_trim(text.unwrap_or_default()), AGENT_HOOK_CONTEXT_MAX);
    if context.is_empty() {
        return None;
    }
    Some(
        json!({
            "hookSpecificOutput": {
                "hookEventName": event,
                "additionalContext": context,
            }
        })
        .to_string(),
    )
}

pub fn skill_directive(text: &str) -> Option<String> {
    LINE_BREAK
        .split(text)
        .enumerate()
        .find_map(|(index, line)| {
            let flat: String = line.nfkc().collect();
            (INLINE_INJECTION.is_match(&flat) || FENCED_INJECTION.is_match(&flat)).then(|| {
                format!(
                    "line {}: shell injection (!` or a ```! block) is not allowed",
                    index + 1
                )
            })
        })
}
