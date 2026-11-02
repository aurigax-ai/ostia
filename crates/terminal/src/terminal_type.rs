use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::Duration;

use ostia_base::discrete_gpu::{Env, without_gpu_launch_env};
use ostia_base::js::{js_trim, non_empty};
use ostia_base::node_path;
use serde_json::Value;

use crate::pane_launcher::with_launcher_on_path;

pub const PTY_TERM_NAME: &str = "xterm-256color";

const ENV_PREFIX: &str = "OSTIA_";

const LOCALE_ENV_NAMES: [&str; 3] = ["LANG", "LC_ALL", "LC_CTYPE"];

const DEFAULT_REGIONS: [(&str, &str); 25] = [
    ("ar", "SA"),
    ("cs", "CZ"),
    ("da", "DK"),
    ("de", "DE"),
    ("el", "GR"),
    ("en", "US"),
    ("es", "ES"),
    ("fi", "FI"),
    ("fr", "FR"),
    ("he", "IL"),
    ("hi", "IN"),
    ("hu", "HU"),
    ("it", "IT"),
    ("ja", "JP"),
    ("ko", "KR"),
    ("nb", "NO"),
    ("nl", "NL"),
    ("pl", "PL"),
    ("pt", "BR"),
    ("ro", "RO"),
    ("ru", "RU"),
    ("sv", "SE"),
    ("tr", "TR"),
    ("uk", "UA"),
    ("zh", "CN"),
];

const CHINESE_SCRIPT_REGIONS: [(&str, &str); 2] = [("hant", "TW"), ("hans", "CN")];

const FALLBACK_LANG: &str = "en_US.UTF-8";

const LOCALE_LIST_TIMEOUT: Duration = Duration::from_millis(2000);

const ARTIFACTS_ENV: &str = "ARTIFACTS";

const PAD_ENV: &str = "PAD";

const PAD_FILE: &str = "PAD.md";

const WORKSPACE_DIR_ENV: &str = "WORKSPACE_DIR";

const AGENT_HOOKS_OFF_ENV: [(&str, &str); 3] = [
    ("claude", "NO_CLAUDE_HOOKS"),
    ("codex", "NO_CODEX_HOOKS"),
    ("agy", "NO_AGY_HOOKS"),
];

pub type HasLocale<'a> = &'a dyn Fn(&str) -> bool;

fn app_env_name(name: &str) -> String {
    format!("{ENV_PREFIX}{name}")
}

fn app_env(values: impl IntoIterator<Item = (String, String)>) -> Env {
    values
        .into_iter()
        .map(|(name, value)| (app_env_name(&name), value))
        .collect()
}

fn without_app_env(mut env: Env, names: &[&str]) -> Env {
    for name in names {
        env.remove(&app_env_name(name));
    }
    env
}

fn agent_hooks_env(raw: &Value) -> Env {
    app_env(AGENT_HOOKS_OFF_ENV.iter().map(|(agent, name)| {
        let on = raw.get(agent) != Some(&Value::Bool(false));
        ((*name).to_owned(), if on { "" } else { "1" }.to_owned())
    }))
}

pub fn pty_color_env() -> Env {
    Env::from([("COLORTERM".to_owned(), "truecolor".to_owned())])
}

pub fn pty_identity_env(version: &str) -> Env {
    Env::from([
        ("TERM_PROGRAM".to_owned(), "ostia".to_owned()),
        ("TERM_PROGRAM_VERSION".to_owned(), version.to_owned()),
    ])
}

pub fn pty_hyperlink_env(parent: &Env) -> Env {
    if parent.contains_key("FORCE_HYPERLINK") {
        Env::new()
    } else {
        Env::from([("FORCE_HYPERLINK".to_owned(), "1".to_owned())])
    }
}

fn lookup<'a>(table: &'a [(&str, &str)], key: &str) -> Option<&'a str> {
    table
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| *value)
}

fn is_letters(part: &str, count: usize) -> bool {
    part.len() == count && part.bytes().all(|byte| byte.is_ascii_alphabetic())
}

fn locale_candidates(locale: Option<&str>) -> Vec<String> {
    let text = locale.unwrap_or("");
    let head = text.split('.').next().unwrap_or("");
    let head = head.split('@').next().unwrap_or("");
    let parts: Vec<&str> = head
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .collect();
    let Some(language) = parts.first().map(|part| part.to_lowercase()) else {
        return Vec::new();
    };
    if !(2..=3).contains(&language.len()) || !language.bytes().all(|byte| byte.is_ascii_lowercase())
    {
        return Vec::new();
    }
    let rest = &parts[1..];
    let region = rest
        .iter()
        .find(|part| is_letters(part, 2))
        .map(|part| part.to_uppercase());
    let script = rest
        .iter()
        .find(|part| is_letters(part, 4))
        .map(|part| part.to_lowercase());
    let script_region = match (&language[..], &script) {
        ("zh", Some(script)) => lookup(&CHINESE_SCRIPT_REGIONS, script).map(str::to_owned),
        _ => None,
    };
    let default_region = lookup(&DEFAULT_REGIONS, &language).map(str::to_owned);
    let mut regions: Vec<String> = Vec::new();
    for value in [region, script_region, default_region]
        .into_iter()
        .flatten()
    {
        if !value.is_empty() && !regions.contains(&value) {
            regions.push(value);
        }
    }
    regions
        .into_iter()
        .map(|value| format!("{language}_{value}.UTF-8"))
        .collect()
}

fn normalize_locale_name(name: &str) -> String {
    name.to_lowercase().replacen("utf-8", "utf8", 1)
}

fn list_installed_locales() -> Option<HashSet<String>> {
    let mut child = Command::new("locale")
        .arg("-a")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = std::io::Read::read_to_end(&mut stdout, &mut bytes);
        let _ = sender.send(read.map(|_| bytes));
    });
    let received = receiver.recv_timeout(LOCALE_LIST_TIMEOUT);
    let bytes = match received {
        Ok(Ok(bytes)) => bytes,
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let status = child.wait().ok()?;
    if !status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&bytes)
            .split('\n')
            .map(|line| normalize_locale_name(js_trim(line)))
            .collect(),
    )
}

fn system_has_locale(name: &str) -> bool {
    if cfg!(target_os = "macos") {
        return Path::new("/usr/share/locale").join(name).exists();
    }
    static INSTALLED: OnceLock<Option<HashSet<String>>> = OnceLock::new();
    match INSTALLED.get_or_init(list_installed_locales) {
        Some(installed) => installed.contains(&normalize_locale_name(name)),
        None => true,
    }
}

pub fn pty_locale_env(parent: &Env, locale: Option<&str>, has_locale: HasLocale<'_>) -> Env {
    if LOCALE_ENV_NAMES
        .iter()
        .any(|name| non_empty(parent.get(*name).map(String::as_str)).is_some())
    {
        return Env::new();
    }
    let lang = locale_candidates(locale)
        .into_iter()
        .chain([FALLBACK_LANG.to_owned(), "C.UTF-8".to_owned()])
        .find(|name| has_locale(name.as_str()))
        .unwrap_or_else(|| FALLBACK_LANG.to_owned());
    Env::from([("LANG".to_owned(), lang)])
}

pub struct PaneShellEnvParts<'a> {
    pub version: String,
    pub locale: Option<String>,
    pub has_locale: Option<HasLocale<'a>>,
    pub parent: Env,
    pub integration: Env,
    pub pane: Env,
    pub agent_hooks: Value,
    pub artifacts_dir: Option<String>,
    pub workspace_dir: Option<String>,
    pub launcher_dir: Option<String>,
}

fn artifacts_env(dir: Option<&str>) -> Env {
    let Some(dir) = non_empty(dir) else {
        return Env::new();
    };
    let pad = node_path::join(Path::new(dir), PAD_FILE);
    app_env([
        (ARTIFACTS_ENV.to_owned(), dir.to_owned()),
        (PAD_ENV.to_owned(), pad.to_string_lossy().into_owned()),
    ])
}

pub fn pane_shell_env(parts: &PaneShellEnvParts<'_>) -> Env {
    let mut env = without_app_env(
        without_gpu_launch_env(&parts.parent),
        &[ARTIFACTS_ENV, PAD_ENV, WORKSPACE_DIR_ENV],
    );
    env.extend(parts.integration.clone());
    env.extend(parts.pane.clone());
    env.extend(artifacts_env(parts.artifacts_dir.as_deref()));
    if let Some(dir) = non_empty(parts.workspace_dir.as_deref()) {
        env.extend(app_env([(WORKSPACE_DIR_ENV.to_owned(), dir.to_owned())]));
    }
    env.extend(agent_hooks_env(&parts.agent_hooks));
    let has_locale = parts.has_locale.unwrap_or(&system_has_locale);
    env.extend(pty_locale_env(
        &parts.parent,
        parts.locale.as_deref(),
        has_locale,
    ));
    env.extend(pty_hyperlink_env(&parts.parent));
    env.extend(pty_color_env());
    env.extend(pty_identity_env(&parts.version));
    match non_empty(parts.launcher_dir.as_deref()) {
        Some(dir) => {
            let current: HashMap<String, String> = env.into_iter().collect();
            with_launcher_on_path(&current, dir, ":")
                .into_iter()
                .collect()
        }
        None => env,
    }
}

pub fn with_pane_token(env: &Env, token: &str, token_file: Option<&str>) -> Env {
    let mut out = without_app_env(env.clone(), &["TOKEN", "TOKEN_FILE"]);
    let entry = match non_empty(token_file) {
        Some(file) => ("TOKEN_FILE".to_owned(), file.to_owned()),
        None => ("TOKEN".to_owned(), token.to_owned()),
    };
    out.extend(app_env([entry]));
    out
}
