use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use ostia_base::js::{JS_SPACE_CLASS, static_regex};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value};

pub const LOG_FILE_NAME: &str = "main.log";
pub const LOG_FIELD_MAX_CHARS: usize = 4000;
const LOG_MAX_BYTES: u64 = 1024 * 1024;
const LOG_KEEP_FILES: usize = 3;
const REDACTED: &str = "[redacted]";

pub type LogFields = Map<String, Value>;

pub trait AppLog: Send + Sync {
    fn info(&self, event: &str, fields: &LogFields);
    fn warn(&self, event: &str, fields: &LogFields);
    fn error(&self, event: &str, fields: &LogFields);
}

fn ascii_insensitive(word: &str) -> String {
    word.chars()
        .map(|ch| {
            if ch.is_ascii_alphabetic() {
                format!("[{}{}]", ch.to_ascii_lowercase(), ch.to_ascii_uppercase())
            } else {
                ch.to_string()
            }
        })
        .collect()
}

static SCHEME_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    let schemes = ["Bearer", "Basic", "Token"]
        .map(ascii_insensitive)
        .join("|");
    static_regex(&format!(
        r"(?-u:\b)({schemes})[{JS_SPACE_CLASS}]+[A-Za-z0-9._~+/=-]{{8,}}"
    ))
});

static KEY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    let passw = format!(
        "{}(?:{})?{}",
        ascii_insensitive("passw"),
        ascii_insensitive("or"),
        ascii_insensitive("d")
    );
    let api_key = format!(
        "{}[_-]?{}",
        ascii_insensitive("api"),
        ascii_insensitive("key")
    );
    let keywords = [
        ascii_insensitive("token"),
        ascii_insensitive("secret"),
        passw,
        api_key,
        ascii_insensitive("auth"),
        ascii_insensitive("credential"),
        ascii_insensitive("cookie"),
    ]
    .join("|");
    static_regex(&format!(
        r#"(?-u:\b)([A-Za-z0-9_-]*(?:{keywords})[A-Za-z0-9_-]*)(["']?[{JS_SPACE_CLASS}]*[=:][{JS_SPACE_CLASS}]*)("[^"]*"|'[^']*'|[^{JS_SPACE_CLASS}&,;"']+)"#
    ))
});

static SK_KEY: LazyLock<Regex> = LazyLock::new(|| static_regex(r"(?-u:\b)sk-[A-Za-z0-9_-]{12,}"));
static GITHUB_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?-u:\b)gh[pousr]_[A-Za-z0-9]{20,}"));
static LONG_OPAQUE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?-u:\b)[A-Za-z0-9+/_-]{40,}={0,2}"));
static PLAIN_VALUE: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[A-Za-z0-9._:/@+-]+$"));

pub fn redact_secrets(text: &str) -> String {
    let out = SCHEME_TOKEN.replace_all(text, format!("${{1}} {REDACTED}"));
    let out = KEY_VALUE.replace_all(&out, format!("${{1}}${{2}}{REDACTED}"));
    let out = SK_KEY.replace_all(&out, REDACTED);
    let out = GITHUB_TOKEN.replace_all(&out, REDACTED);
    LONG_OPAQUE.replace_all(&out, REDACTED).into_owned()
}

fn clip(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_owned();
    }
    format!(
        "{}…({} more)",
        String::from_utf16_lossy(&units[..max]),
        units.len() - max
    )
}

fn render_value(value: &Value) -> String {
    let Value::String(text) = value else {
        return match value {
            Value::Number(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            other => other.to_string(),
        };
    };
    let safe = clip(&redact_secrets(text), LOG_FIELD_MAX_CHARS);
    if PLAIN_VALUE.is_match(&safe) {
        safe
    } else {
        Value::String(safe).to_string()
    }
}

pub fn format_entry(event: &str, fields: &LogFields) -> String {
    let mut parts = vec![event.to_owned()];
    for (key, value) in fields {
        if value.is_null() {
            continue;
        }
        parts.push(format!("{key}={}", render_value(value)));
    }
    parts.join(" ")
}

pub fn rotated_name(file: &Path, index: usize) -> PathBuf {
    let stem = file
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = file
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    file.with_file_name(format!("{stem}.{index}{ext}"))
}

fn remove_if_exists(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

pub fn rotate_log_files(file: &Path, keep: usize) -> std::io::Result<()> {
    let archives = keep.saturating_sub(1);
    if archives < 1 {
        return remove_if_exists(file);
    }
    remove_if_exists(&rotated_name(file, archives))?;
    for index in (1..archives).rev() {
        let from = rotated_name(file, index);
        if from.exists() {
            fs::rename(&from, rotated_name(file, index + 1))?;
        }
    }
    if file.exists() {
        fs::rename(file, rotated_name(file, 1))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AppLogOptions {
    pub max_bytes: Option<u64>,
    pub keep: Option<usize>,
}

pub struct FileAppLog {
    file: PathBuf,
    max_bytes: u64,
    keep: usize,
    write_lock: Mutex<()>,
}

impl FileAppLog {
    pub fn create(file: PathBuf, options: AppLogOptions) -> Self {
        Self {
            file,
            max_bytes: options.max_bytes.unwrap_or(LOG_MAX_BYTES),
            keep: options.keep.unwrap_or(LOG_KEEP_FILES),
            write_lock: Mutex::new(()),
        }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    fn write(&self, level: &str, event: &str, fields: &LogFields) {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let line = format!("[{stamp}] [{level}] {}\n", format_entry(event, fields));
        let _guard = self.write_lock.lock();
        let _ = self.append(&line);
    }

    fn append(&self, line: &str) -> std::io::Result<()> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        let size = fs::metadata(&self.file).map_or(0, |meta| meta.len());
        let overflows = size > 0 && size + line.len() as u64 > self.max_bytes;
        if overflows && rotate_log_files(&self.file, self.keep).is_err() {
            let _ = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&self.file);
        }
        let mut handle = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(&self.file)?;
        handle.write_all(line.as_bytes())
    }
}

impl AppLog for FileAppLog {
    fn info(&self, event: &str, fields: &LogFields) {
        self.write("info", event, fields);
    }

    fn warn(&self, event: &str, fields: &LogFields) {
        self.write("warn", event, fields);
    }

    fn error(&self, event: &str, fields: &LogFields) {
        self.write("error", event, fields);
    }
}
