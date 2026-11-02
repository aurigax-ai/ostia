#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::Path;
use std::process::Command;

use ostia_contract::agent_skills::{
    AgentPluginContent, AgentSkillFile, ExtensionAgentHook, LoadedAgentSkill,
};
use ostia_terminal::claude_integration::{
    AGENT_SKILL_NAME, CLAUDE_FOLD_DIR, CLAUDE_FOLD_SOURCE, CLAUDE_MOD_FILE, CLAUDE_MOD_SOURCE,
    ClaudePluginDeps, PlaybookSkill, PlaybookSkillFile, claude_fold_manifest, claude_hook_settings,
    claude_plugin_manifest, claude_wrapper, write_claude_fold_plugin, write_claude_plugin,
    write_playbook_file, write_skill_files,
};
use serde_json::{Value, json};
use tempfile::tempdir;

fn hook(ext_id: &str, event: &str, command: &str) -> ExtensionAgentHook {
    ExtensionAgentHook {
        ext_id: ext_id.to_owned(),
        event: event.to_owned(),
        command: command.to_owned(),
    }
}

fn fixture_hooks() -> Vec<ExtensionAgentHook> {
    vec![
        hook("acme.notes", "Stop", "check"),
        hook("acme.notes", "Notification", "ping"),
        hook("acme.lint", "PreToolUse", "lint"),
    ]
}

const FAKE_CORE_FILES: [(&str, &str); 2] =
    [("SKILL.md", "core skill"), ("ref/notes.md", "core notes")];

fn write_fake_core_skill(dir: &Path) -> ostia_base::Result<()> {
    for (path, text) in FAKE_CORE_FILES {
        let target = dir.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, text).unwrap();
    }
    Ok(())
}

fn deps(playbooks: &[PlaybookSkill]) -> ClaudePluginDeps<'_> {
    ClaudePluginDeps {
        write_core_skill: &write_fake_core_skill,
        playbooks,
    }
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap()
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn without_version(manifest: &Value) -> Value {
    let mut copy = manifest.clone();
    copy.as_object_mut().unwrap().remove("version");
    copy
}

fn commands(group: &Value) -> Vec<String> {
    group["hooks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hook| hook["command"].as_str().unwrap().to_owned())
        .collect()
}

fn groups<'a>(settings: &'a Value, event: &str) -> &'a Vec<Value> {
    settings["hooks"][event].as_array().unwrap()
}

#[test]
fn names_the_plugin_file_the_fold_folder_and_the_skill() {
    assert_eq!(CLAUDE_MOD_FILE, "register.ts");
    assert_eq!(CLAUDE_FOLD_DIR, "claude-fold");
    assert_eq!(AGENT_SKILL_NAME, "ostia");
}

#[test]
fn writes_the_hook_settings_the_ts_app_wrote() {
    let expected = ostia_testkit::fixture_text("rust/claude-hook-settings.json").unwrap();
    assert_eq!(pretty(&claude_hook_settings(&[])), expected);
}

#[test]
fn writes_the_hook_settings_with_extension_hooks_the_ts_app_wrote() {
    let expected =
        ostia_testkit::fixture_text("rust/claude-hook-settings-extensions.json").unwrap();
    assert_eq!(pretty(&claude_hook_settings(&fixture_hooks())), expected);
}

#[test]
fn puts_the_question_tool_matcher_group_before_the_extension_group_for_tool_events() {
    let settings = claude_hook_settings(&fixture_hooks());
    let pre = groups(&settings, "PreToolUse");
    assert_eq!(pre.len(), 2);
    assert_eq!(pre[0]["matcher"], "AskUserQuestion|ExitPlanMode");
    assert!(pre[1].get("matcher").is_none());
    assert_eq!(commands(&pre[1]).len(), 1);
    assert!(commands(&pre[1])[0].contains("agent-hook acme.lint lint claude PreToolUse"));
    let post = groups(&settings, "PostToolUse");
    assert_eq!(post[0]["matcher"], "AskUserQuestion|ExitPlanMode");
    assert!(commands(&post[0])[0].contains("claude-hook PostToolUse"));
    assert!(commands(&post[1])[0].contains("turn-hook PostToolUse"));
}

#[test]
fn keeps_own_commands_before_extension_commands_in_one_group() {
    let settings = claude_hook_settings(&fixture_hooks());
    let stop = groups(&settings, "Stop");
    assert_eq!(stop.len(), 1);
    let stop_commands = commands(&stop[0]);
    assert_eq!(stop_commands.len(), 3);
    assert!(stop_commands[0].contains("claude-hook Stop"));
    assert!(stop_commands[1].contains("turn-hook Stop"));
    assert!(stop_commands[2].contains("agent-hook acme.notes check claude Stop"));
}

#[test]
fn adds_the_claude_only_notification_extension_hook_after_the_own_notification_hook() {
    let settings = claude_hook_settings(&fixture_hooks());
    let notification = commands(&groups(&settings, "Notification")[0]);
    assert_eq!(notification.len(), 2);
    assert!(notification[0].contains("claude-hook Notification"));
    assert!(notification[1].contains("agent-hook acme.notes ping claude Notification"));
}

#[test]
fn leaves_out_an_event_that_has_no_command() {
    let settings = claude_hook_settings(&[]);
    let hooks = settings["hooks"].as_object().unwrap();
    assert!(!hooks.contains_key("SessionEnd"));
    assert!(hooks.values().all(|groups| {
        groups
            .as_array()
            .unwrap()
            .iter()
            .all(|group| !group["hooks"].as_array().unwrap().is_empty())
    }));
}

#[test]
fn registers_the_permission_hook_and_the_failure_and_subagent_hooks_for_claude() {
    let settings = claude_hook_settings(&[]);
    assert!(
        commands(&groups(&settings, "PermissionRequest")[0])[0].contains("permission-hook claude")
    );
    for event in [
        "PermissionDenied",
        "StopFailure",
        "SubagentStart",
        "SubagentStop",
    ] {
        let only = commands(&groups(&settings, event)[0]);
        assert_eq!(only.len(), 1, "{event}");
        assert!(only[0].contains(&format!("claude-hook {event}")), "{event}");
    }
}

#[test]
fn sends_the_resume_token_and_the_working_state_from_the_start_and_prompt_events() {
    let settings = claude_hook_settings(&[]);
    let start = commands(&groups(&settings, "SessionStart")[0]);
    assert!(start[0].contains("resume-token claude -"));
    assert!(start[1].contains("bus hook SessionStart"));
    let prompt = commands(&groups(&settings, "UserPromptSubmit")[0]);
    assert!(prompt[0].contains("state working"));
    assert!(prompt[1].contains("bus hook UserPromptSubmit"));
    assert!(prompt[2].contains("turn-hook UserPromptSubmit"));
}

#[test]
fn writes_the_wrapper_the_ts_app_wrote() {
    let expected = ostia_testkit::fixture_text("rust/claude-wrapper.sh").unwrap();
    assert_eq!(claude_wrapper(), expected);
}

#[test]
fn writes_a_wrapper_that_bash_accepts() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("wrapper.sh");
    fs::write(&file, claude_wrapper()).unwrap();
    let status = Command::new("bash").arg("-n").arg(&file).status().unwrap();
    assert!(status.success());
}

#[test]
fn describes_the_claude_plugin_and_the_fold_plugin_as_the_ts_app_does() {
    let plugin = claude_plugin_manifest();
    let fold = claude_fold_manifest();
    let expected_plugin: Value = serde_json::from_str(
        &ostia_testkit::fixture_text("rust/claude-plugin-manifest.json").unwrap(),
    )
    .unwrap();
    let expected_fold: Value = serde_json::from_str(
        &ostia_testkit::fixture_text("rust/claude-fold-manifest.json").unwrap(),
    )
    .unwrap();
    assert_eq!(without_version(&plugin), without_version(&expected_plugin));
    assert_eq!(without_version(&fold), without_version(&expected_fold));
    assert!(!plugin["version"].as_str().unwrap().is_empty());
    assert!(!fold["version"].as_str().unwrap().is_empty());
    let keys: Vec<&String> = plugin.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["name", "version", "description"]);
}

#[test]
fn writes_the_claude_plugin_manifest_hooks_module_and_core_skill() {
    let dir = tempdir().unwrap();
    let plugin = dir.path().join("claude-plugin");
    write_claude_plugin(&plugin, &AgentPluginContent::default(), &deps(&[])).unwrap();
    assert_eq!(
        read(&plugin.join(".claude-plugin/plugin.json")),
        format!("{}\n", pretty(&claude_plugin_manifest()))
    );
    let mut settings = claude_hook_settings(&[]);
    settings
        .as_object_mut()
        .unwrap()
        .insert("modules".to_owned(), json!(["./register.ts"]));
    assert_eq!(
        read(&plugin.join("hooks/hooks.json")),
        format!("{}\n", pretty(&settings))
    );
    assert_eq!(read(&plugin.join("hooks/register.ts")), CLAUDE_MOD_SOURCE);
    for (path, text) in FAKE_CORE_FILES {
        assert_eq!(
            read(&plugin.join("skills").join(AGENT_SKILL_NAME).join(path)),
            text,
            "{path}"
        );
    }
}

#[test]
fn writes_extension_hooks_into_the_plugin_hooks_json() {
    let dir = tempdir().unwrap();
    let plugin = dir.path().join("claude-plugin");
    let content = AgentPluginContent {
        skills: Vec::new(),
        hooks: fixture_hooks(),
    };
    write_claude_plugin(&plugin, &content, &deps(&[])).unwrap();
    let written: Value = serde_json::from_str(&read(&plugin.join("hooks/hooks.json"))).unwrap();
    assert_eq!(
        written["hooks"],
        claude_hook_settings(&fixture_hooks())["hooks"]
    );
    assert_eq!(written["modules"], json!(["./register.ts"]));
    let keys: Vec<&String> = written.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["hooks", "modules"]);
}

#[test]
fn writes_each_extension_skill_and_playbook_under_its_own_skills_folder() {
    let dir = tempdir().unwrap();
    let plugin = dir.path().join("claude-plugin");
    let content = AgentPluginContent {
        skills: vec![LoadedAgentSkill {
            id: "acme-notes".to_owned(),
            description: "Notes".to_owned(),
            files: vec![
                AgentSkillFile {
                    name: "SKILL.md".to_owned(),
                    data: b"---\nname: acme-notes\n---\n".to_vec(),
                },
                AgentSkillFile {
                    name: "blob.bin".to_owned(),
                    data: vec![0, 159, 146, 150, 255],
                },
            ],
        }],
        hooks: Vec::new(),
    };
    let playbooks = vec![PlaybookSkill {
        id: "review".to_owned(),
        skill: "playbook skill".to_owned(),
        files: vec![PlaybookSkillFile {
            path: "notes/extra.md".to_owned(),
            text: "extra".to_owned(),
        }],
    }];
    write_claude_plugin(&plugin, &content, &deps(&playbooks)).unwrap();
    assert_eq!(
        read(&plugin.join("skills/acme-notes/SKILL.md")),
        "---\nname: acme-notes\n---\n"
    );
    assert_eq!(
        fs::read(plugin.join("skills/acme-notes/blob.bin")).unwrap(),
        vec![0, 159, 146, 150, 255]
    );
    assert_eq!(
        read(&plugin.join("skills/review/SKILL.md")),
        "playbook skill"
    );
    assert_eq!(read(&plugin.join("skills/review/notes/extra.md")), "extra");
}

#[test]
fn writes_a_playbook_skill_and_its_nested_files_creating_the_folders() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("deep").join("playbook");
    let playbook = PlaybookSkill {
        id: "p".to_owned(),
        skill: "skill text".to_owned(),
        files: vec![
            PlaybookSkillFile {
                path: "a/b/c.md".to_owned(),
                text: "c".to_owned(),
            },
            PlaybookSkillFile {
                path: "top.md".to_owned(),
                text: "top".to_owned(),
            },
        ],
    };
    write_playbook_file(&target, &playbook).unwrap();
    assert_eq!(read(&target.join("SKILL.md")), "skill text");
    assert_eq!(read(&target.join("a/b/c.md")), "c");
    assert_eq!(read(&target.join("top.md")), "top");
}

#[test]
fn writes_the_bytes_of_every_skill_file_creating_the_folder() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("skills").join("one");
    let skill = LoadedAgentSkill {
        id: "one".to_owned(),
        description: "d".to_owned(),
        files: vec![AgentSkillFile {
            name: "data.bin".to_owned(),
            data: vec![1, 2, 3, 255],
        }],
    };
    write_skill_files(&target, &skill).unwrap();
    assert_eq!(
        fs::read(target.join("data.bin")).unwrap(),
        vec![1, 2, 3, 255]
    );
}

#[test]
fn writes_the_fold_plugin_manifest_an_empty_hooks_list_and_its_module() {
    let dir = tempdir().unwrap();
    let plugin = dir.path().join(CLAUDE_FOLD_DIR);
    write_claude_fold_plugin(&plugin).unwrap();
    assert_eq!(
        read(&plugin.join(".claude-plugin/plugin.json")),
        format!("{}\n", pretty(&claude_fold_manifest()))
    );
    assert_eq!(
        read(&plugin.join("hooks/hooks.json")),
        format!(
            "{}\n",
            pretty(&json!({"hooks": {}, "modules": ["./register.ts"]}))
        )
    );
    assert_eq!(read(&plugin.join("hooks/register.ts")), CLAUDE_FOLD_SOURCE);
}

#[test]
fn bundles_a_non_empty_mod_source_and_fold_source() {
    assert!(!CLAUDE_MOD_SOURCE.is_empty());
    assert!(!CLAUDE_FOLD_SOURCE.is_empty());
    assert_ne!(CLAUDE_MOD_SOURCE, CLAUDE_FOLD_SOURCE);
}

#[test]
fn does_not_write_a_skills_folder_into_the_fold_plugin() {
    let dir = tempdir().unwrap();
    let plugin = dir.path().join(CLAUDE_FOLD_DIR);
    write_claude_fold_plugin(&plugin).unwrap();
    assert!(!plugin.join("skills").exists());
}
