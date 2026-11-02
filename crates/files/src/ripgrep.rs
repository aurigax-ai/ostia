use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use ostia_base::js::{is_js_space, js_trim, static_regex, utf16_len};
use ostia_base::node_path;
use regex::Regex;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout, Command};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

use crate::search::{FileMatches, LineMatch};

pub const MATCH_LIMIT: usize = 2000;
pub const FILE_LIST_LIMIT: usize = 50_000;
pub const PREVIEW_CHARS: usize = 240;
const PREVIEW_LEAD: usize = 40;
const RG_TIMEOUT: Duration = Duration::from_millis(15_000);
const STDERR_MAX: usize = 4000;
const STDERR_LINES: usize = 8;
const STDERR_CHUNK: usize = 65_536;

const COMMON_ARGS: [&str; 5] = [
    "--no-config",
    "--hidden",
    "--glob",
    "!.git",
    "--no-messages",
];

static INVALID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i)regex parse error|error parsing glob|invalid glob"));

#[derive(Clone, Debug)]
pub struct TextQuery {
    pub text: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include_ignored: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextResults {
    pub files: Vec<FileMatches>,
    pub matches: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileList {
    pub paths: Vec<String>,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RgFailureCode {
    RgMissing,
    InvalidPattern,
    Failed,
    Cancelled,
}

impl RgFailureCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RgMissing => "rg-missing",
            Self::InvalidPattern => "invalid-pattern",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RgFailure {
    pub error: RgFailureCode,
    pub message: String,
}

impl RgFailure {
    fn of(error: RgFailureCode, message: impl Into<String>) -> Self {
        Self {
            error,
            message: message.into(),
        }
    }

    fn cancelled() -> Self {
        Self::of(RgFailureCode::Cancelled, "")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    pub text: String,
    pub ranges: Vec<(usize, usize)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchHit {
    pub path: String,
    pub line_match: LineMatch,
}

pub fn ripgrep_path(app_path: &str, platform: &str, arch: &str) -> String {
    let base = app_path.strip_suffix(".asar").map_or_else(
        || app_path.to_owned(),
        |stem| format!("{stem}.asar.unpacked"),
    );
    let binary = if platform == "win32" { "rg.exe" } else { "rg" };
    node_path::join(
        Path::new(&base),
        &format!("node_modules/@vscode/ripgrep-{platform}-{arch}/bin/{binary}"),
    )
    .to_string_lossy()
    .into_owned()
}

fn scope_args(include_ignored: bool) -> Vec<String> {
    let mut args: Vec<String> = COMMON_ARGS.iter().map(|arg| (*arg).to_owned()).collect();
    if include_ignored {
        args.push("--no-ignore".to_owned());
    }
    args
}

pub fn text_argv(query: &TextQuery) -> Vec<String> {
    let mut argv = vec!["--json".to_owned()];
    argv.extend(scope_args(query.include_ignored));
    argv.extend(["--max-filesize", "2M", "--iglob", "!*.pdf"].map(str::to_owned));
    argv.push(
        if query.case_sensitive {
            "--case-sensitive"
        } else {
            "--ignore-case"
        }
        .to_owned(),
    );
    if !query.regex {
        argv.push("--fixed-strings".to_owned());
    }
    if query.whole_word {
        argv.push("--word-regexp".to_owned());
    }
    argv.extend(["--".to_owned(), query.text.clone(), ".".to_owned()]);
    argv
}

pub fn files_argv(include_ignored: bool) -> Vec<String> {
    let mut argv = vec!["--files".to_owned()];
    argv.extend(scope_args(include_ignored));
    argv.push(".".to_owned());
    argv
}

pub fn relative_path(path: &str) -> &str {
    path.strip_prefix("./").unwrap_or(path)
}

fn utf16_units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn char_offset(bytes: &[u8], offset: f64) -> usize {
    let length = bytes.len() as f64;
    let whole = offset.trunc();
    let end = if whole.is_nan() {
        0.0
    } else if whole < 0.0 {
        (length + whole).max(0.0)
    } else {
        whole.min(length)
    };
    utf16_len(&String::from_utf8_lossy(&bytes[..end as usize]))
}

pub fn preview(line: &str, ranges: &[(usize, usize)]) -> Preview {
    let units = utf16_units(line);
    let indent = line.chars().take_while(|ch| is_js_space(*ch)).count();
    let first = ranges.first().map_or(indent, |range| range.0);
    let start = if first < indent {
        first
    } else {
        indent.max(first.saturating_sub(PREVIEW_LEAD))
    };
    let end = start + PREVIEW_CHARS;
    let mut shifted = Vec::new();
    for (from, to) in ranges {
        if *from >= end {
            break;
        }
        shifted.push((
            from.saturating_sub(start),
            (*to).min(end).saturating_sub(start),
        ));
    }
    let from = start.min(units.len());
    let to = end.min(units.len());
    Preview {
        text: String::from_utf16_lossy(&units[from..to]),
        ranges: shifted,
    }
}

fn strip_line_ending(text: &str) -> &str {
    match text.strip_suffix('\n') {
        Some(rest) => rest.strip_suffix('\r').unwrap_or(rest),
        None => text,
    }
}

fn submatch_offsets(sub: &Value) -> Option<(f64, f64)> {
    let start = sub.get("start")?.as_f64()?;
    let end = sub.get("end")?.as_f64()?;
    Some((start, end))
}

pub fn parse_match(raw: &str) -> Option<MatchHit> {
    let event: Value = serde_json::from_str(raw).ok()?;
    if event.get("type")?.as_str() != Some("match") {
        return None;
    }
    let data = event.get("data")?;
    let path = data.get("path")?.get("text")?.as_str()?;
    let text = data.get("lines")?.get("text")?.as_str()?;
    let line = data.get("line_number")?.as_u64()?;
    let full = strip_line_ending(text);
    let full_length = utf16_len(full);
    let bytes = text.as_bytes();
    let mut ranges = Vec::new();
    let subs = data
        .get("submatches")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    for sub in subs {
        let Some((start, end)) = submatch_offsets(sub) else {
            continue;
        };
        let from = char_offset(bytes, start).min(full_length);
        let to = char_offset(bytes, end).min(full_length);
        if to > from {
            ranges.push((from, to));
        }
    }
    let shown = preview(full, &ranges);
    Some(MatchHit {
        path: relative_path(path).to_owned(),
        line_match: LineMatch {
            line,
            column: ranges.first().map_or(0, |range| range.0) + 1,
            text: shown.text,
            ranges: shown.ranges,
        },
    })
}

fn failure_of(stderr: &str) -> RgFailure {
    let message = js_trim(stderr)
        .split('\n')
        .take(STDERR_LINES)
        .collect::<Vec<_>>()
        .join("\n");
    let code = if INVALID_PATTERN.is_match(stderr) {
        RgFailureCode::InvalidPattern
    } else {
        RgFailureCode::Failed
    };
    RgFailure::of(code, message)
}

fn trim_line_end(line: &mut Vec<u8>) {
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
}

async fn read_line(
    reader: &mut Option<BufReader<ChildStdout>>,
    line: &mut Vec<u8>,
) -> std::io::Result<usize> {
    match reader {
        Some(reader) => reader.read_until(b'\n', line).await,
        None => std::future::pending().await,
    }
}

async fn read_chunk(pipe: &mut Option<ChildStderr>, chunk: &mut [u8]) -> std::io::Result<usize> {
    match pipe {
        Some(pipe) => pipe.read(chunk).await,
        None => std::future::pending().await,
    }
}

async fn run_rg(
    bin: &Path,
    root: &Path,
    argv: &[String],
    mut on_line: impl FnMut(&str) -> bool,
    cancel: &CancellationToken,
) -> Result<bool, RgFailure> {
    if cancel.is_cancelled() {
        return Err(RgFailure::cancelled());
    }
    let mut child = Command::new(bin)
        .args(argv)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                RgFailure::of(
                    RgFailureCode::RgMissing,
                    "ripgrep is missing from this build",
                )
            } else {
                RgFailure::of(RgFailureCode::Failed, err.to_string())
            }
        })?;
    let timer = sleep(RG_TIMEOUT);
    tokio::pin!(timer);
    let mut stdout = child.stdout.take().map(BufReader::new);
    let mut stderr_pipe = child.stderr.take();
    let mut stderr = String::new();
    let mut stopped = false;
    let mut line: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; STDERR_CHUNK];
    while stdout.is_some() || stderr_pipe.is_some() {
        tokio::select! {
            () = cancel.cancelled(), if !stopped => {
                stopped = true;
                let _ = child.start_kill();
            }
            () = &mut timer, if !stopped => {
                stopped = true;
                let _ = child.start_kill();
            }
            read = read_line(&mut stdout, &mut line) => {
                match read {
                    Ok(0) | Err(_) if line.is_empty() => stdout = None,
                    Ok(_) | Err(_) => {
                        let mut complete = std::mem::take(&mut line);
                        trim_line_end(&mut complete);
                        if !stopped && !on_line(&String::from_utf8_lossy(&complete)) {
                            stopped = true;
                            let _ = child.start_kill();
                        }
                    }
                }
            }
            read = read_chunk(&mut stderr_pipe, &mut chunk) => {
                match read {
                    Ok(0) | Err(_) => stderr_pipe = None,
                    Ok(count) => {
                        if utf16_len(&stderr) < STDERR_MAX {
                            stderr.push_str(&String::from_utf8_lossy(&chunk[..count]));
                        }
                    }
                }
            }
        }
    }
    let status = child
        .wait()
        .await
        .map_err(|err| RgFailure::of(RgFailureCode::Failed, err.to_string()))?;
    if cancel.is_cancelled() {
        return Err(RgFailure::cancelled());
    }
    let code = status.code();
    if stopped || code == Some(0) || code == Some(1) || js_trim(&stderr).is_empty() {
        Ok(stopped)
    } else {
        Err(failure_of(&stderr))
    }
}

pub async fn search_text(
    bin: &Path,
    root: &Path,
    query: &TextQuery,
    cancel: &CancellationToken,
    limit: usize,
) -> Result<TextResults, RgFailure> {
    let mut by_path: HashMap<String, Vec<LineMatch>> = HashMap::new();
    let mut matches = 0usize;
    let mut truncated = false;
    let stopped = run_rg(
        bin,
        root,
        &text_argv(query),
        |line| {
            let Some(hit) = parse_match(line) else {
                return true;
            };
            by_path.entry(hit.path).or_default().push(hit.line_match);
            matches += 1;
            if matches < limit {
                return true;
            }
            truncated = true;
            false
        },
        cancel,
    )
    .await?;
    let mut grouped: Vec<(String, Vec<LineMatch>)> = by_path.into_iter().collect();
    grouped.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    let files = grouped
        .into_iter()
        .map(|(path, matches)| FileMatches { path, matches })
        .collect();
    Ok(TextResults {
        files,
        matches,
        truncated: truncated || stopped,
    })
}

pub async fn list_files(
    bin: &Path,
    root: &Path,
    include_ignored: bool,
    cancel: &CancellationToken,
) -> Result<FileList, RgFailure> {
    let mut paths: Vec<String> = Vec::new();
    let stopped = run_rg(
        bin,
        root,
        &files_argv(include_ignored),
        |line| {
            paths.push(relative_path(line).to_owned());
            paths.len() < FILE_LIST_LIMIT
        },
        cancel,
    )
    .await?;
    Ok(FileList {
        paths,
        truncated: stopped,
    })
}
