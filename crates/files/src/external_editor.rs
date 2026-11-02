use std::path::Path;
use std::process::Stdio;
use std::sync::LazyLock;

use ostia_base::Host;
use ostia_base::js::{js_number_text, js_trim, static_regex};
use ostia_base::path_lookup::find_on_path;
use ostia_contract::argv::split_args;
use regex::{Captures, Regex};
use rustix::fs::{Access, access};
use tokio::process::Command;

const AUTO_EDITOR: &str = "auto";

const KNOWN_EDITORS: [(&str, &str); 3] = [
    ("code", "code -g {file}:{line}:{column}"),
    ("cursor", "cursor -g {file}:{line}:{column}"),
    ("zed", "zed {file}:{line}:{column}"),
];

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\{(file|line|column)\}"));

#[derive(Clone, Debug, PartialEq)]
pub struct EditorTarget {
    pub file: String,
    pub line: Option<f64>,
    pub column: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExternalEditorRequest {
    pub template: Option<String>,
    pub file: String,
    pub line: Option<f64>,
    pub column: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExternalEditorResult {
    Ok { argv: Vec<String> },
    InvalidPath,
    NoEditor,
    InvalidTemplate,
    SpawnFailed { message: String },
}

fn position(value: Option<f64>) -> String {
    match value {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n > 0.0 => js_number_text(n),
        _ => "1".to_owned(),
    }
}

pub fn expand_template(template: &str, target: &EditorTarget) -> Option<Vec<String>> {
    let tokens = split_args(template)?;
    if tokens.is_empty() {
        return None;
    }
    let line = position(target.line);
    let column = position(target.column);
    let has_file = tokens.iter().any(|token| token.contains("{file}"));
    let mut argv: Vec<String> = tokens
        .iter()
        .map(|token| {
            PLACEHOLDER
                .replace_all(token, |captures: &Captures| match &captures[1] {
                    "file" => target.file.clone(),
                    "line" => line.clone(),
                    _ => column.clone(),
                })
                .into_owned()
        })
        .collect();
    if !has_file {
        argv.push(target.file.clone());
    }
    Some(argv)
}

pub fn resolve_editor_template(
    setting: &str,
    path_env: &str,
    is_executable: impl Fn(&Path) -> bool,
) -> Option<String> {
    let trimmed = js_trim(setting);
    if trimmed.is_empty() {
        return None;
    }
    if trimmed != AUTO_EDITOR {
        return Some(trimmed.to_owned());
    }
    KNOWN_EDITORS
        .iter()
        .find(|(bin, _)| find_on_path(bin, path_env, &is_executable).is_some())
        .map(|(_, template)| (*template).to_owned())
}

fn is_executable_file(path: &Path) -> bool {
    access(path, Access::EXEC_OK).is_ok()
}

pub async fn open_in_external_editor(
    request: &ExternalEditorRequest,
    host: &Host,
) -> ExternalEditorResult {
    if !Path::new(&request.file).is_absolute() {
        return ExternalEditorResult::InvalidPath;
    }
    let setting = request.template.as_deref().unwrap_or(AUTO_EDITOR);
    let path_env = host.env.get("PATH").map_or("", String::as_str);
    let Some(template) = resolve_editor_template(setting, path_env, is_executable_file) else {
        return ExternalEditorResult::NoEditor;
    };
    let target = EditorTarget {
        file: request.file.clone(),
        line: request.line,
        column: request.column,
    };
    let Some(argv) = expand_template(&template, &target) else {
        return ExternalEditorResult::InvalidTemplate;
    };
    let spawned = Command::new(&argv[0])
        .args(&argv[1..])
        .env_clear()
        .envs(host.child_env())
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match spawned {
        Ok(_child) => ExternalEditorResult::Ok { argv },
        Err(error) => ExternalEditorResult::SpawnFailed {
            message: error.to_string(),
        },
    }
}
