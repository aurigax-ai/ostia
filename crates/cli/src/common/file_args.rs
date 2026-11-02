use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use ostia_base::js::{JS_DOT, static_regex};
use ostia_base::node_path::{join, resolve};
use ostia_contract::open_files::{FileTarget, OpenFileError};
use regex::Regex;

type PathPredicate = Box<dyn Fn(&Path) -> bool>;

pub struct FileProbe {
    pub cwd: PathBuf,
    pub home: PathBuf,
    pub is_file: PathPredicate,
    pub is_dir: Option<PathPredicate>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenTarget {
    Url(String),
    Stdin,
    Folder(PathBuf),
    File(FileTarget),
}

static POSITION_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^({JS_DOT}+?):([0-9]+)(?::([0-9]+))?$")));

static URL_PREFIX: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[hH][tT][tT][pP][sS]?://"));

fn plain(path: PathBuf) -> FileTarget {
    FileTarget {
        path,
        line: None,
        column: None,
    }
}

fn absolute(arg: &str, probe: &FileProbe) -> PathBuf {
    if arg == "~" {
        return probe.home.clone();
    }
    if let Some(rest) = arg.strip_prefix("~/") {
        return join(&probe.home, rest);
    }
    resolve(Path::new(arg), &probe.cwd)
}

pub fn parse_file_arg(arg: &str, probe: &FileProbe) -> FileTarget {
    let path = absolute(arg, probe);
    if (probe.is_file)(&path) {
        return plain(path);
    }
    let Some(position) = POSITION_SUFFIX.captures(arg) else {
        return plain(path);
    };
    let Ok(line) = position[2].parse::<u64>() else {
        return plain(path);
    };
    if line < 1 {
        return plain(path);
    }
    let column = match position.get(3).map(|digits| digits.as_str().parse::<u64>()) {
        None => None,
        Some(Ok(column)) => (column > 0).then_some(column),
        Some(Err(_)) => return plain(path),
    };
    FileTarget {
        path: absolute(&position[1], probe),
        line: Some(line),
        column,
    }
}

pub fn open_target(word: &str, probe: &FileProbe) -> OpenTarget {
    if word == "-" {
        return OpenTarget::Stdin;
    }
    if URL_PREFIX.is_match(word) {
        return OpenTarget::Url(word.to_owned());
    }
    let file = parse_file_arg(word, probe);
    if probe
        .is_dir
        .as_ref()
        .is_some_and(|is_dir| is_dir(&file.path))
    {
        OpenTarget::Folder(file.path)
    } else {
        OpenTarget::File(file)
    }
}

fn reveal_reason(error: &str) -> Option<&'static str> {
    match error {
        "outside-home" => Some("folders show only under the home folder"),
        "not-found" => Some("no such folder"),
        "not-a-directory" => Some("not a folder"),
        "outside-sandbox" => Some("a sandboxed workspace cannot show folders"),
        _ => None,
    }
}

pub fn reveal_refusal_line(path: &str, error: &str, message: Option<&str>) -> String {
    let reason = reveal_reason(error).or(message).unwrap_or(error);
    format!("ostia: {path}: {reason}")
}

fn open_file_reason(error: OpenFileError) -> &'static str {
    match error {
        OpenFileError::NotFound => "no such file",
        OpenFileError::Directory => "is a directory",
        OpenFileError::NotAFile => "not a regular file",
        OpenFileError::Unreadable => "permission denied",
        OpenFileError::OutsideSandbox => "outside what a sandboxed workspace may open",
    }
}

pub fn refusal_line(path: &str, error: OpenFileError) -> String {
    format!("ostia: {path}: {}", open_file_reason(error))
}

fn open_file_error(code: &str) -> Option<OpenFileError> {
    match code {
        "not-found" => Some(OpenFileError::NotFound),
        "directory" => Some(OpenFileError::Directory),
        "not-a-file" => Some(OpenFileError::NotAFile),
        "unreadable" => Some(OpenFileError::Unreadable),
        "outside-sandbox" => Some(OpenFileError::OutsideSandbox),
        _ => None,
    }
}

fn diff_reason(error: &str) -> Option<&'static str> {
    match error {
        "binary" => Some("is not a text file"),
        "too-large" => Some("is too large to compare"),
        other => open_file_error(other).map(open_file_reason),
    }
}

pub fn diff_refusal_line(path: Option<&str>, error: &str, message: Option<&str>) -> String {
    let reason = diff_reason(error).or(message).unwrap_or(error);
    match path.filter(|path| !path.is_empty()) {
        Some(path) => format!("ostia diff: {path}: {reason}"),
        None => format!("ostia diff: {reason}"),
    }
}
