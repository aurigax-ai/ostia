use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{FileExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use ostia_base::{Error, Result, error::io_error};
use ostia_contract::agent_resume::{AgentResume, ResumableAgent};

const NEW_LINES_BYTES: u64 = 4 * 1024 * 1024;
const LONGEST_LINE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TailRead {
    pub lines: Vec<String>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TailWindow {
    pub lines: Vec<String>,
    pub truncated: bool,
    pub end: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewLines {
    pub lines: Vec<String>,
    pub end: u64,
    pub reset: bool,
}

struct Opened {
    file: File,
    size: u64,
}

fn open_regular(path: &Path) -> Result<Opened> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(io_error(path))?;
    let info = file.metadata().map_err(io_error(path))?;
    if !info.is_file() {
        return Err(Error::Io {
            path: path.to_path_buf(),
            source: std::io::Error::other("not a regular file"),
        });
    }
    Ok(Opened {
        file,
        size: info.len(),
    })
}

fn read_buffer(opened: &Opened, path: &Path, start: u64, length: u64) -> Result<Vec<u8>> {
    let length = usize::try_from(length).map_err(|error| Error::Io {
        path: path.to_path_buf(),
        source: std::io::Error::other(error),
    })?;
    let mut buffer = vec![0u8; length];
    let mut read = 0;
    while read < length {
        let count = opened
            .file
            .read_at(&mut buffer[read..], start + read as u64)
            .map_err(io_error(path))?;
        if count == 0 {
            break;
        }
        read += count;
    }
    Ok(buffer)
}

fn split_lines(buffer: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(buffer)
        .split('\n')
        .map(str::to_owned)
        .collect()
}

struct CompleteLines {
    lines: Vec<String>,
    end: u64,
}

fn complete_lines(buffer: &[u8], start: u64, skip_partial_head: bool) -> CompleteLines {
    let Some(last) = buffer.iter().rposition(|byte| *byte == b'\n') else {
        return CompleteLines {
            lines: Vec::new(),
            end: start,
        };
    };
    let from = if skip_partial_head {
        buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(0, |first| first + 1)
    } else {
        0
    };
    let text = if from > last {
        String::new()
    } else {
        String::from_utf8_lossy(&buffer[from..last]).into_owned()
    };
    let lines = if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').map(str::to_owned).collect()
    };
    CompleteLines {
        lines,
        end: start + last as u64 + 1,
    }
}

fn is_plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|stat| stat.is_file())
}

fn list_dir(path: &Path) -> Vec<String> {
    fs::read_dir(path).map_or_else(
        |_| Vec::new(),
        |entries| {
            entries
                .filter_map(std::result::Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        },
    )
}

fn claude_project_dir(cwd: &str) -> String {
    let mut name = String::with_capacity(cwd.len());
    for ch in cwd.chars() {
        if ch.is_ascii_alphanumeric() {
            name.push(ch);
        } else {
            for _ in 0..ch.len_utf16() {
                name.push('-');
            }
        }
    }
    name
}

fn claude_transcript(home: &Path, id: &str, cwd: Option<&str>) -> Option<PathBuf> {
    let root = home.join(".claude").join("projects");
    let file_name = format!("{id}.jsonl");
    if let Some(cwd) = cwd {
        let path = root.join(claude_project_dir(cwd)).join(file_name);
        return is_plain_file(&path).then_some(path);
    }
    list_dir(&root)
        .into_iter()
        .map(|project| root.join(project).join(&file_name))
        .find(|path| is_plain_file(path))
}

fn newest_first(dir: &Path) -> Vec<String> {
    let mut names = list_dir(dir);
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    names.reverse();
    names
}

fn codex_transcript(home: &Path, id: &str) -> Option<PathBuf> {
    let root = home.join(".codex").join("sessions");
    let suffix = format!("-{id}.jsonl");
    for year in newest_first(&root) {
        for month in newest_first(&root.join(&year)) {
            for day in newest_first(&root.join(&year).join(&month)) {
                let dir = root.join(&year).join(&month).join(&day);
                let name = list_dir(&dir)
                    .into_iter()
                    .find(|file| file.ends_with(&suffix));
                if let Some(name) = name {
                    let path = dir.join(name);
                    if is_plain_file(&path) {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

pub fn transcript_path(resume: &AgentResume, home: &Path) -> Option<PathBuf> {
    match resume.agent {
        ResumableAgent::Claude => claude_transcript(home, &resume.id, resume.cwd.as_deref()),
        ResumableAgent::Codex | ResumableAgent::Agy => codex_transcript(home, &resume.id),
    }
}

pub fn read_range(path: &Path, from_end: bool, bytes: u64) -> Result<Vec<String>> {
    let opened = open_regular(path)?;
    let length = bytes.min(opened.size);
    let start = if from_end { opened.size - length } else { 0 };
    let buffer = read_buffer(&opened, path, start, length)?;
    let mut lines = split_lines(&buffer);
    if from_end && start > 0 {
        lines.remove(0);
    }
    if !from_end && length < opened.size {
        lines.pop();
    }
    Ok(lines)
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|error| Error::Task(error.to_string()))?
}

pub async fn read_tail(path: &Path, bytes: u64) -> Result<TailRead> {
    let path = path.to_path_buf();
    blocking(move || {
        let opened = open_regular(&path)?;
        let length = bytes.min(opened.size);
        let start = opened.size - length;
        let buffer = read_buffer(&opened, &path, start, length)?;
        let mut lines = split_lines(&buffer);
        if start > 0 {
            lines.remove(0);
        }
        Ok(TailRead {
            lines,
            truncated: start > 0,
        })
    })
    .await
}

pub async fn read_tail_window(path: &Path, bytes: u64) -> Result<TailWindow> {
    let path = path.to_path_buf();
    blocking(move || {
        let opened = open_regular(&path)?;
        let length = bytes.min(opened.size);
        let start = opened.size - length;
        let buffer = read_buffer(&opened, &path, start, length)?;
        let read = complete_lines(&buffer, start, start > 0);
        Ok(TailWindow {
            lines: read.lines,
            truncated: start > 0,
            end: read.end,
        })
    })
    .await
}

pub async fn read_new_lines(path: &Path, offset: u64) -> Result<NewLines> {
    read_new_lines_with(path, offset, NEW_LINES_BYTES, LONGEST_LINE_BYTES).await
}

pub async fn read_new_lines_with(
    path: &Path,
    offset: u64,
    chunk: u64,
    longest: u64,
) -> Result<NewLines> {
    let path = path.to_path_buf();
    blocking(move || {
        let opened = open_regular(&path)?;
        if opened.size < offset {
            return Ok(NewLines {
                lines: Vec::new(),
                end: 0,
                reset: true,
            });
        }
        let remaining = opened.size - offset;
        let mut cap = chunk;
        loop {
            let length = remaining.min(cap);
            if length == 0 {
                return Ok(NewLines {
                    lines: Vec::new(),
                    end: offset,
                    reset: false,
                });
            }
            let buffer = read_buffer(&opened, &path, offset, length)?;
            let read = complete_lines(&buffer, offset, false);
            let stuck = read.lines.is_empty() && length == cap && length < remaining;
            if !stuck {
                return Ok(NewLines {
                    lines: read.lines,
                    end: read.end,
                    reset: false,
                });
            }
            if cap >= longest {
                return Ok(NewLines {
                    lines: Vec::new(),
                    end: offset + length,
                    reset: false,
                });
            }
            cap *= 2;
        }
    })
    .await
}
