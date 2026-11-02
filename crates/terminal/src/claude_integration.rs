use std::fs;
use std::path::Path;

use ostia_base::atomic_write::{AtomicWriteOptions, write_file_atomic};
use ostia_base::error::io_error;
use ostia_base::{PRODUCT_NAME, Result, node_path};
use ostia_contract::agent_plugins::AGENT_HOOK_EVENTS;
use ostia_contract::agent_skills::{AgentPluginContent, ExtensionAgentHook, LoadedAgentSkill};
use ostia_contract::claude_attention::CLAUDE_QUESTION_TOOLS;
use serde_json::{Map, Value, json};

use crate::agent_hook_commands::{
    AGENT_DIR, CLI_PATH, CLI_RUN, IN_PANE, bus_hook_command, command_hook, hook_command, hooks_for,
    permission_hook_command, turn_hook_command,
};

pub const CLAUDE_MOD_SOURCE: &str =
    include_str!("../../../src/main/terminal/claudeMod/register.ts");
pub const CLAUDE_FOLD_SOURCE: &str = include_str!("../../../src/main/terminal/claudeMod/fold.ts");

const CLAUDE_HOOKS_OFF: &str = "${OSTIA_NO_CLAUDE_HOOKS}";
const CLAUDE_ARGS: &str = "OSTIA_CLAUDE_ARGS";
const CLAUDE_SUBAGENT_EVENTS: [&str; 2] = ["SubagentStart", "SubagentStop"];
const AGENT_SKILL_ENTRY: &str = "SKILL.md";

pub const CLAUDE_MOD_FILE: &str = "register.ts";
pub const CLAUDE_FOLD_DIR: &str = "claude-fold";
const CLAUDE_PLUGIN_DIR: &str = "claude-plugin";
pub const AGENT_SKILL_NAME: &str = PRODUCT_NAME;

fn own_commands(event: &str) -> Vec<String> {
    match event {
        "SessionStart" => vec![
            hook_command("resume-token claude -"),
            bus_hook_command("SessionStart"),
        ],
        "UserPromptSubmit" => vec![
            hook_command("state working"),
            bus_hook_command("UserPromptSubmit"),
            turn_hook_command("UserPromptSubmit"),
        ],
        "PostToolUse" => vec![turn_hook_command("PostToolUse")],
        "Notification" => vec![hook_command("claude-hook Notification")],
        "Stop" => vec![hook_command("claude-hook Stop"), turn_hook_command("Stop")],
        _ => Vec::new(),
    }
}

fn plain_group(command: &str) -> Value {
    json!({"hooks": [command_hook(command)]})
}

pub fn claude_hook_settings(extension_hooks: &[ExtensionAgentHook]) -> Value {
    let mut hooks = Map::new();
    for event in AGENT_HOOK_EVENTS {
        let mut commands = own_commands(event);
        commands.extend(hooks_for(extension_hooks, "claude", event));
        if commands.is_empty() {
            continue;
        }
        let group = json!({"hooks": commands.iter().map(|command| command_hook(command)).collect::<Vec<_>>()});
        hooks.insert(event.to_owned(), json!([group]));
    }
    let matcher = CLAUDE_QUESTION_TOOLS.join("|");
    for (event, cli_args) in [
        ("PreToolUse", "claude-hook PreToolUse"),
        ("PostToolUse", "claude-hook PostToolUse"),
    ] {
        let mut groups = vec![json!({
            "matcher": matcher,
            "hooks": [command_hook(&hook_command(cli_args))],
        })];
        if let Some(Value::Array(existing)) = hooks.get(event) {
            groups.extend(existing.iter().cloned());
        }
        hooks.insert(event.to_owned(), Value::Array(groups));
    }
    hooks.insert(
        "PermissionDenied".to_owned(),
        json!([plain_group(&hook_command("claude-hook PermissionDenied"))]),
    );
    hooks.insert(
        "StopFailure".to_owned(),
        json!([plain_group(&hook_command("claude-hook StopFailure"))]),
    );
    for event in CLAUDE_SUBAGENT_EVENTS {
        hooks.insert(
            event.to_owned(),
            json!([plain_group(&hook_command(&format!("claude-hook {event}")))]),
        );
    }
    hooks.insert(
        "PermissionRequest".to_owned(),
        json!([plain_group(&permission_hook_command("claude"))]),
    );
    json!({"hooks": hooks})
}

fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn claude_plugin_manifest() -> Value {
    json!({
        "name": AGENT_SKILL_NAME,
        "version": version(),
        "description": format!(
            "{PRODUCT_NAME} integration: the {PRODUCT_NAME} CLI skill plus hooks for the agent's resume token and attention state."
        ),
    })
}

pub fn claude_fold_manifest() -> Value {
    json!({
        "name": format!("{PRODUCT_NAME}-fold"),
        "version": version(),
        "description": format!("{PRODUCT_NAME} display plugin: draws a bus message turn as one row."),
    })
}

fn make_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).map_err(io_error(dir))
}

fn write_text(path: &Path, text: &str) -> Result<()> {
    write_file_atomic(path, text.as_bytes(), AtomicWriteOptions::default())
}

fn pretty_line(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybookSkillFile {
    pub path: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybookSkill {
    pub id: String,
    pub skill: String,
    pub files: Vec<PlaybookSkillFile>,
}

pub type CoreSkillWriter<'a> = &'a dyn Fn(&Path) -> Result<()>;

pub struct ClaudePluginDeps<'a> {
    pub write_core_skill: CoreSkillWriter<'a>,
    pub playbooks: &'a [PlaybookSkill],
}

pub fn write_playbook_file(dir: &Path, playbook: &PlaybookSkill) -> Result<()> {
    make_dir(dir)?;
    write_text(&dir.join(AGENT_SKILL_ENTRY), &playbook.skill)?;
    for file in &playbook.files {
        let target = node_path::join(dir, &file.path);
        if let Some(parent) = target.parent() {
            make_dir(parent)?;
        }
        write_text(&target, &file.text)?;
    }
    Ok(())
}

pub fn write_skill_files(dir: &Path, skill: &LoadedAgentSkill) -> Result<()> {
    make_dir(dir)?;
    for file in &skill.files {
        let target = dir.join(&file.name);
        write_file_atomic(&target, &file.data, AtomicWriteOptions::default())?;
    }
    Ok(())
}

pub fn write_claude_plugin(
    dir: &Path,
    content: &AgentPluginContent,
    deps: &ClaudePluginDeps<'_>,
) -> Result<()> {
    make_dir(&dir.join(".claude-plugin"))?;
    make_dir(&dir.join("hooks"))?;
    write_text(
        &dir.join(".claude-plugin").join("plugin.json"),
        &pretty_line(&claude_plugin_manifest()),
    )?;
    let mut settings = claude_hook_settings(&content.hooks);
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            "modules".to_owned(),
            json!([format!("./{CLAUDE_MOD_FILE}")]),
        );
    }
    write_text(
        &dir.join("hooks").join("hooks.json"),
        &pretty_line(&settings),
    )?;
    write_text(&dir.join("hooks").join(CLAUDE_MOD_FILE), CLAUDE_MOD_SOURCE)?;
    let skills = dir.join("skills");
    (deps.write_core_skill)(&skills.join(AGENT_SKILL_NAME))?;
    for skill in &content.skills {
        write_skill_files(&node_path::join(&skills, &skill.id), skill)?;
    }
    for playbook in deps.playbooks {
        write_playbook_file(&node_path::join(&skills, &playbook.id), playbook)?;
    }
    Ok(())
}

pub fn write_claude_fold_plugin(dir: &Path) -> Result<()> {
    make_dir(&dir.join(".claude-plugin"))?;
    make_dir(&dir.join("hooks"))?;
    write_text(
        &dir.join(".claude-plugin").join("plugin.json"),
        &pretty_line(&claude_fold_manifest()),
    )?;
    write_text(
        &dir.join("hooks").join("hooks.json"),
        &pretty_line(&json!({"hooks": {}, "modules": [format!("./{CLAUDE_MOD_FILE}")]})),
    )?;
    write_text(&dir.join("hooks").join(CLAUDE_MOD_FILE), CLAUDE_FOLD_SOURCE)
}

pub fn claude_wrapper() -> String {
    let hooks_on = format!(r#"[ -z "{CLAUDE_HOOKS_OFF}" ]"#);
    let plugin_dir = format!("{AGENT_DIR}/{CLAUDE_PLUGIN_DIR}");
    let fold_dir = format!("{AGENT_DIR}/{CLAUDE_FOLD_DIR}");
    [
        String::new(),
        "# Run claude with the Ostia plugins (CLI skill, extension skills and hooks, resume token,"
            .to_owned(),
        "# attention hooks, bus row display) and on the Claude account Ostia picks for this start."
            .to_owned(),
        "# `command claude` skips both.".to_owned(),
        format!(r#"if [ -n "{CLI_PATH}" ]; then"#),
        "  __ostia_claude() {".to_owned(),
        r"    local IFS=$'\037'".to_owned(),
        format!(
            r#"    if {hooks_on} && [ -n "{AGENT_DIR}" ] && [ -d "{plugin_dir}" ] && [ -d "{fold_dir}" ]; then"#
        ),
        format!(
            r#"      {CLAUDE_ARGS}="$*" command claude --plugin-dir "{plugin_dir}" --plugin-dir "{fold_dir}" "$@""#
        ),
        format!("    elif {hooks_on}; then"),
        format!(r#"      {CLAUDE_ARGS}="$*" command claude "$@""#),
        "    else".to_owned(),
        r#"      command claude "$@""#.to_owned(),
        "    fi".to_owned(),
        "  }".to_owned(),
        "  claude() {".to_owned(),
        r"    local IFS=$'\037' account= answer= memory=".to_owned(),
        format!(r#"    if [ -z "${{CLAUDE_CONFIG_DIR-}}" ] && {IN_PANE}; then"#),
        format!("      answer=$({CLI_RUN} claude-account start 2>/dev/null)"),
        r"      account=${answer%%$'\n'*}".to_owned(),
        r#"      memory=${answer#"$account"}"#.to_owned(),
        r"      memory=${memory#$'\n'}".to_owned(),
        "    fi".to_owned(),
        r#"    if [ -n "$account" ]; then"#.to_owned(),
        r#"      CLAUDE_CONFIG_DIR="$account" CLAUDE_CODE_REMOTE_MEMORY_DIR="$memory" __ostia_claude "$@""#
            .to_owned(),
        "    else".to_owned(),
        r#"      __ostia_claude "$@""#.to_owned(),
        "    fi".to_owned(),
        "  }".to_owned(),
        "fi".to_owned(),
        String::new(),
    ]
    .join("\n")
}
