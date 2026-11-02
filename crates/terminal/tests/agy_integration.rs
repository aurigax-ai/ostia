#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use ostia_terminal::agy_integration::{agy_hooks_json, agy_plugin_digest, install_agy_plugin};
use serde_json::Value;
use tempfile::{TempDir, tempdir};

struct Fixture {
    _guard: TempDir,
    config: PathBuf,
    args_log: PathBuf,
    stdin_log: PathBuf,
    cli: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let guard = tempdir().unwrap();
        let dir = fs::canonicalize(guard.path()).unwrap();
        let args_log = dir.join("args.log");
        let stdin_log = dir.join("stdin.log");
        let cli = dir.join("cli.sh");
        fs::write(
            &cli,
            format!(
                "printf '%s\\n' \"$*\" >> '{}'\nprintf '%s\\n' \"$(cat)\" >> '{}'\n",
                args_log.display(),
                stdin_log.display()
            ),
        )
        .unwrap();
        Self {
            config: dir.join("config"),
            args_log,
            stdin_log,
            cli,
            _guard: guard,
        }
    }

    fn plugin_dir(&self) -> PathBuf {
        let mut names: Vec<String> = fs::read_dir(self.config.join("plugins"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.starts_with("ostia-"))
            .collect();
        names.sort();
        self.config.join("plugins").join(&names[0])
    }

    fn fire(&self, event: &str, payload: &Value, env: &[(&str, &str)]) -> String {
        let hooks: Value = serde_json::from_str(
            &fs::read_to_string(self.plugin_dir().join("hooks.json")).unwrap(),
        )
        .unwrap();
        let mut stdout = String::new();
        for named in hooks.as_object().unwrap().values() {
            for handler in named
                .get(event)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let command = handler["command"].as_str().unwrap();
                let mut child = Command::new("sh");
                child
                    .arg("-c")
                    .arg(command)
                    .env_clear()
                    .env("PATH", std::env::var("PATH").unwrap_or_default())
                    .env("OSTIA_NODE", "sh")
                    .env("OSTIA_CLI", &self.cli)
                    .envs(env.iter().copied())
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());
                let mut running = child.spawn().unwrap();
                {
                    use std::io::Write;
                    let mut input = running.stdin.take().unwrap();
                    let _ = input.write_all(payload.to_string().as_bytes());
                }
                let output = running.wait_with_output().unwrap();
                stdout.push_str(&String::from_utf8(output.stdout).unwrap());
            }
        }
        stdout
    }

    fn calls(&self) -> Vec<(Vec<String>, String)> {
        if !self.args_log.exists() {
            return Vec::new();
        }
        let args = fs::read_to_string(&self.args_log).unwrap();
        let stdin = fs::read_to_string(&self.stdin_log).unwrap();
        args.lines()
            .zip(stdin.lines())
            .map(|(args, stdin)| {
                (
                    args.split(' ').map(str::to_owned).collect(),
                    stdin.to_owned(),
                )
            })
            .collect()
    }

    fn call_args(&self) -> Vec<Vec<String>> {
        self.calls().into_iter().map(|(args, _)| args).collect()
    }
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn writes_nothing_when_agy_has_no_config_folder() {
    let fx = Fixture::new();
    assert_eq!(install_agy_plugin(&fx.config).unwrap(), None);
    assert!(!fx.config.exists());
}

#[test]
fn installs_one_generation_under_agys_plugins_folder_and_leaves_other_plugins_alone() {
    let fx = Fixture::new();
    fs::create_dir_all(fx.config.join("plugins").join("mine")).unwrap();
    fs::write(fx.config.join("plugins/mine/plugin.json"), "{}").unwrap();
    let installed = install_agy_plugin(&fx.config).unwrap();
    assert_eq!(
        installed,
        Some(
            fx.config
                .join("plugins")
                .join(format!("ostia-{}", agy_plugin_digest()))
        )
    );
    let plugin: Value =
        serde_json::from_str(&fs::read_to_string(fx.plugin_dir().join("plugin.json")).unwrap())
            .unwrap();
    assert_eq!(plugin["name"], "ostia");
    assert_eq!(
        fs::read_to_string(fx.plugin_dir().join("hooks.json")).unwrap(),
        agy_hooks_json()
    );
    assert!(fx.config.join("plugins/mine/plugin.json").exists());
}

#[test]
fn never_rewrites_a_generation_in_place_and_removes_an_older_one() {
    let fx = Fixture::new();
    let older = fx.config.join("plugins").join("ostia-0000000000000000");
    fs::create_dir_all(&older).unwrap();
    fs::write(older.join("hooks.json"), "{}").unwrap();
    let first = install_agy_plugin(&fx.config).unwrap();
    fs::write(fx.plugin_dir().join("hooks.json"), "edited").unwrap();
    assert_eq!(install_agy_plugin(&fx.config).unwrap(), first);
    assert_eq!(
        fs::read_to_string(fx.plugin_dir().join("hooks.json")).unwrap(),
        "edited"
    );
    assert!(older.join("hooks.json").exists());
}

#[test]
fn lists_the_hook_events_agy_runs() {
    let hooks: Value = serde_json::from_str(&agy_hooks_json()).unwrap();
    let events: Vec<&String> = hooks["ostia"].as_object().unwrap().keys().collect();
    assert_eq!(events, ["SessionStart", "PreInvocation", "Stop"]);
}

#[test]
fn writes_the_plugin_files_plugin_json_and_hooks_json_only() {
    let fx = Fixture::new();
    fs::create_dir_all(&fx.config).unwrap();
    install_agy_plugin(&fx.config).unwrap();
    assert_eq!(
        names_in(&fx.plugin_dir())
            .into_iter()
            .filter(|name| !name.starts_with('.'))
            .collect::<Vec<_>>(),
        ["hooks.json", "plugin.json"]
    );
}

#[test]
fn writes_the_hooks_json_the_ts_app_wrote() {
    let expected = ostia_testkit::fixture_text("rust/agy-hooks.json").unwrap();
    assert_eq!(agy_hooks_json(), expected);
}

#[test]
fn names_the_generation_with_the_digest_the_ts_app_computed() {
    let expected = ostia_testkit::fixture_text("rust/agy-plugin-digest.txt").unwrap();
    assert_eq!(agy_plugin_digest(), expected);
    assert_eq!(agy_plugin_digest().len(), 16);
    assert!(agy_plugin_digest().bytes().all(|b| b.is_ascii_hexdigit()));
}

#[test]
fn session_start_stores_the_conversation_as_the_resume_token() {
    let fx = Fixture::new();
    fs::create_dir_all(&fx.config).unwrap();
    install_agy_plugin(&fx.config).unwrap();
    let session = serde_json::json!({"conversationId": "c-1", "invocationNum": 0});
    let in_pane = [("OSTIA_SOCKET", "/tmp/s.sock")];
    assert_eq!(fx.fire("SessionStart", &session, &in_pane), "{}\n");
    assert_eq!(
        fx.calls(),
        vec![(strings(&["resume-token", "agy", "-"]), session.to_string())]
    );
}

#[test]
fn pre_invocation_stores_the_token_and_reports_working() {
    let fx = Fixture::new();
    fs::create_dir_all(&fx.config).unwrap();
    install_agy_plugin(&fx.config).unwrap();
    let session = serde_json::json!({"conversationId": "c-1", "invocationNum": 0});
    let in_pane = [("OSTIA_SOCKET", "/tmp/s.sock")];
    assert_eq!(fx.fire("PreInvocation", &session, &in_pane), "{}\n{}\n");
    assert_eq!(
        fx.call_args(),
        vec![
            strings(&["resume-token", "agy", "-"]),
            strings(&["state", "working"]),
        ]
    );
}

#[test]
fn stop_reports_done_and_closes_the_turn() {
    let fx = Fixture::new();
    fs::create_dir_all(&fx.config).unwrap();
    install_agy_plugin(&fx.config).unwrap();
    let in_pane = [("OSTIA_SOCKET", "/tmp/s.sock")];
    assert_eq!(
        fx.fire(
            "Stop",
            &serde_json::json!({"conversationId": "c-1"}),
            &in_pane
        ),
        "{}\n"
    );
    assert_eq!(fx.call_args()[0], strings(&["state", "done", "--stop"]));
}

#[test]
fn does_nothing_outside_an_ostia_pane_but_still_answers_agy_with_an_empty_object() {
    let fx = Fixture::new();
    fs::create_dir_all(&fx.config).unwrap();
    install_agy_plugin(&fx.config).unwrap();
    let session = serde_json::json!({"conversationId": "c-1", "invocationNum": 0});
    for event in ["SessionStart", "PreInvocation", "Stop"] {
        let out = fx.fire(event, &session, &[]);
        assert!(
            out.split('\n')
                .filter(|line| !line.is_empty())
                .all(|line| line == "{}"),
            "{event}: {out:?}"
        );
    }
    assert!(fx.calls().is_empty());
}

#[test]
fn does_nothing_when_agents_hooks_agy_is_off() {
    let fx = Fixture::new();
    fs::create_dir_all(&fx.config).unwrap();
    install_agy_plugin(&fx.config).unwrap();
    let session = serde_json::json!({"conversationId": "c-1", "invocationNum": 0});
    for event in ["SessionStart", "PreInvocation", "Stop"] {
        fx.fire(
            event,
            &session,
            &[("OSTIA_SOCKET", "/tmp/s.sock"), ("OSTIA_NO_AGY_HOOKS", "1")],
        );
    }
    assert!(fx.calls().is_empty());
}
