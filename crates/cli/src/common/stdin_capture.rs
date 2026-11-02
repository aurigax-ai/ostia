use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use chrono::{Datelike, NaiveDateTime, Timelike};
use futures_util::pin_mut;
use futures_util::stream::{Stream, StreamExt};
use ostia_base::js::utf16_len;

use super::mebibytes::rounded_mebibytes;

pub const STDIN_MAX_BYTES: usize = 16 * 1024 * 1024;
const STDIN_NAME_MAX: usize = 200;
const FILE_MODE: u32 = 0o600;
pub const NO_ARTIFACT_FOLDER: &str = "ostia: stdin needs an artifact folder";
pub const TTY_NOTICE: &str = "ostia: reading from the terminal; end with Ctrl+D";

pub fn default_stdin_name(now: NaiveDateTime) -> String {
    format!(
        "stdin-{}{:02}{:02}-{:02}{:02}{:02}.txt",
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

pub fn stdin_file_name(name: Option<&str>, now: NaiveDateTime) -> Result<String, String> {
    let Some(name) = name else {
        return Ok(default_stdin_name(now));
    };
    let length = utf16_len(name);
    if length == 0 || length > STDIN_NAME_MAX {
        return Err(format!(
            "ostia: --name must be 1 to {STDIN_NAME_MAX} characters"
        ));
    }
    if name.contains(['/', '\\', '\0']) {
        return Err("ostia: --name is a file name, not a path".to_owned());
    }
    if name.starts_with('.') {
        return Err("ostia: --name cannot start with a dot".to_owned());
    }
    Ok(name.to_owned())
}

pub async fn read_capped<S>(stream: S, max: usize) -> io::Result<Option<Vec<u8>>>
where
    S: Stream<Item = io::Result<Vec<u8>>>,
{
    pin_mut!(stream);
    let mut content = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        if content.len().saturating_add(bytes.len()) > max {
            return Ok(None);
        }
        content.extend_from_slice(&bytes);
    }
    Ok(Some(content))
}

fn extension_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(at) if at > 0 => &name[at..],
        _ => "",
    }
}

fn numbered(name: &str, n: usize) -> String {
    if n == 1 {
        return name.to_owned();
    }
    let extension = extension_of(name);
    let stem = &name[..name.len() - extension.len()];
    format!("{stem}-{n}{extension}")
}

fn write_new_file(dir: &Path, name: &str, content: &[u8]) -> io::Result<PathBuf> {
    let mut n = 1;
    loop {
        let path = dir.join(numbered(name, n));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(FILE_MODE)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(content)?;
                return Ok(path);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        n += 1;
    }
}

pub struct CaptureInput<'a, S> {
    pub dir: Option<&'a Path>,
    pub name: Option<&'a str>,
    pub stream: S,
    pub now: NaiveDateTime,
    pub max: Option<usize>,
}

pub async fn capture_stdin<S>(input: CaptureInput<'_, S>) -> Result<PathBuf, String>
where
    S: Stream<Item = io::Result<Vec<u8>>>,
{
    let name = stdin_file_name(input.name, input.now)?;
    let dir = input
        .dir
        .filter(|dir| fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir()))
        .ok_or_else(|| NO_ARTIFACT_FOLDER.to_owned())?;
    let max = input.max.unwrap_or(STDIN_MAX_BYTES);
    let content = read_capped(input.stream, max)
        .await
        .map_err(|error| format!("ostia: {error}"))?
        .ok_or_else(|| {
            format!(
                "ostia: stdin is over {} MiB; nothing was written",
                rounded_mebibytes(max)
            )
        })?;
    write_new_file(dir, &name, &content).map_err(|error| format!("ostia: {error}"))
}
