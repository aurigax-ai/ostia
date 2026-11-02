use std::path::Path;
use std::sync::LazyLock;

use ostia_base::js::{JS_DOT, js_trim, static_regex, utf16_len};
use ostia_base::node_path::normalize;
use ostia_base::path_guard::{expand_home, is_inside_path};
use ostia_contract::sandbox::SANDBOX_PATH_MAX;
use regex::Regex;

use crate::srt_config::{real_path, touches};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathCheckReason {
    NotAbsolute,
    TooLong,
    Pattern,
    TooBroad,
    OstiaData,
    Protected,
    Missing,
}

impl PathCheckReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAbsolute => "not-absolute",
            Self::TooLong => "too-long",
            Self::Pattern => "pattern",
            Self::TooBroad => "too-broad",
            Self::OstiaData => "ostia-data",
            Self::Protected => "protected",
            Self::Missing => "missing",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxPathEnv {
    pub home: String,
    pub data_dirs: Vec<String>,
    pub protected_dirs: Vec<String>,
    pub protected_files: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxEditError {
    pub value: String,
    pub reason: String,
}

const OPENING_KINDS: [&str; 3] = ["allowRead", "allowWrite", "allowSockets"];

static PATTERN_CHARS: LazyLock<Regex> = LazyLock::new(|| static_regex(r"[*?\[\]{}]"));
static TRAILING_SLASHES: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"({JS_DOT})/+$")));

fn trim_slashes(path: &str) -> String {
    TRAILING_SLASHES.replace(path, "${1}").into_owned()
}

fn is_inside(base: &str, path: &str) -> bool {
    is_inside_path(Path::new(base), Path::new(path))
}

pub fn check_sandbox_path(
    kind: &str,
    input: &str,
    env: &SandboxPathEnv,
) -> Result<String, PathCheckReason> {
    let trimmed = js_trim(input);
    if utf16_len(trimmed) > SANDBOX_PATH_MAX {
        return Err(PathCheckReason::TooLong);
    }
    let expanded = expand_home(trimmed, Path::new(&env.home));
    if !expanded.has_root() {
        return Err(PathCheckReason::NotAbsolute);
    }
    let expanded_text = expanded.to_string_lossy();
    if PATTERN_CHARS.is_match(&expanded_text) {
        return Err(PathCheckReason::Pattern);
    }
    let path = trim_slashes(&normalize(&expanded).to_string_lossy());
    if path == "/" {
        return Err(PathCheckReason::TooBroad);
    }
    let opens = OPENING_KINDS.contains(&kind);
    if opens && is_inside(&real_path(&path), &real_path(&env.home)) {
        return Err(PathCheckReason::TooBroad);
    }
    if opens && touches(&path, &env.data_dirs) {
        return Err(PathCheckReason::OstiaData);
    }
    if opens && touches(&path, &env.protected_dirs) {
        return Err(PathCheckReason::Protected);
    }
    if kind == "allowWrite"
        && env
            .protected_files
            .iter()
            .any(|file| is_inside(file, &real_path(&path)))
    {
        return Err(PathCheckReason::Protected);
    }
    if !Path::new(&path).exists() {
        return Err(PathCheckReason::Missing);
    }
    Ok(trim_slashes(trimmed))
}

pub fn check_sandbox_paths(
    kind: &str,
    inputs: &[&str],
    env: &SandboxPathEnv,
) -> Result<Vec<String>, Vec<SandboxEditError>> {
    let mut paths = Vec::new();
    let mut errors = Vec::new();
    for value in inputs {
        match check_sandbox_path(kind, value, env) {
            Ok(path) => paths.push(path),
            Err(reason) => errors.push(SandboxEditError {
                value: (*value).to_owned(),
                reason: reason.as_str().to_owned(),
            }),
        }
    }
    if errors.is_empty() {
        Ok(paths)
    } else {
        Err(errors)
    }
}
