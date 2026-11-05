use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use ostia_base::host::Host;
use ostia_base::js::{js_to_number, js_trim, locale_compare, utf16_len};
use ostia_base::node_path::{dirname, normal_parts, resolve};
use ostia_base::path_guard::{expand_home, is_inside_path, resolve_safe};
use ostia_contract::assist::CHAT_TOOL_OUTPUT_MAX;
pub use ostia_contract::chat_edits::CHAT_EDITS_MAX;
use ostia_contract::chat_edits::{ChatEdit, ChatEditError, apply_edits};
pub use ostia_contract::chat_tools::{
    CHAT_DIRTY_PATHS_MAX, CHAT_LIST_MAX, CHAT_QUERY_MAX, CHAT_READ_FILE_MAX, CHAT_READ_LINES_MAX,
    CHAT_SEARCH_FILE_MAX, CHAT_SEARCH_FILES_MAX, CHAT_SEARCH_MATCHES_MAX, CHAT_WRITE_MAX,
};
use ostia_contract::utf16_prefix::utf16_prefix;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const PATH_MAX: usize = 4096;
const READ_TEXT_MAX: usize = CHAT_TOOL_OUTPUT_MAX - 2000;
const SEARCH_LINE_MAX: usize = 200;
const BINARY_SNIFF: usize = 8192;
const SKIPPED_DIRS: [&str; 2] = [".git", "node_modules"];

pub fn version_of(content: &[u8]) -> String {
    hex::encode(Sha256::digest(content).as_slice())
}

fn fail(error: &str, path: Option<&Path>) -> Value {
    match path {
        Some(path) => json!({"ok": false, "error": error, "path": path_text(path)}),
        None => json!({"ok": false, "error": error}),
    }
}

fn fail_text(error: &str, path: &str) -> Value {
    if path.is_empty() {
        fail(error, None)
    } else {
        json!({"ok": false, "error": error, "path": path})
    }
}

fn io_fail(err: &std::io::Error, path: &Path) -> Value {
    if err.kind() == ErrorKind::NotFound {
        fail("not-found", Some(path))
    } else {
        fail("failed", Some(path))
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn real_or_none(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn real_of_nearest(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    loop {
        if current.exists() {
            return real_or_none(&current);
        }
        let parent = dirname(&current);
        if parent == current {
            return None;
        }
        current = parent;
    }
}

fn nearest_existing(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    while !current.exists() {
        let parent = dirname(&current);
        if parent == current {
            break;
        }
        current = parent;
    }
    current
}

fn real_roots(roots: &[&str], host: &Host) -> Vec<PathBuf> {
    roots
        .iter()
        .filter_map(|root| real_or_none(&resolve(&expand_home(root, &host.home), &host.cwd)))
        .collect()
}

fn inside_real_roots(real: &Path, roots: &[&str], host: &Host) -> bool {
    real_roots(roots, host)
        .iter()
        .any(|root| is_inside_path(root, real))
}

fn through_symlink(path: &Path, real: &Path, folder: Option<&Path>) -> bool {
    let nearest = nearest_existing(path);
    let real_folder = folder.and_then(real_or_none);
    if let (Some(folder), Some(real_folder)) = (folder, real_folder.as_deref())
        && is_inside_path(folder, &nearest)
    {
        let skip = normal_parts(folder).len();
        let mut expected = real_folder.to_path_buf();
        for part in normal_parts(&nearest).into_iter().skip(skip) {
            expected.push(part);
        }
        return real != expected;
    }
    real != nearest
}

struct Located {
    path: PathBuf,
    real: PathBuf,
    outside: bool,
    symlink: bool,
}

fn string_field<'a>(req: &'a Value, key: &str) -> Option<&'a str> {
    req.get(key).and_then(Value::as_str)
}

fn flag(req: &Value, key: &str) -> bool {
    req.get(key) == Some(&Value::Bool(true))
}

fn truthy(req: &Value, key: &str) -> bool {
    match req.get(key) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

fn locate(req: &Value, roots: &[&str], host: &Host) -> Result<Located, Value> {
    let raw = match string_field(req, "path") {
        Some(raw) if !raw.is_empty() && utf16_len(raw) <= PATH_MAX => raw,
        _ => return Err(fail("invalid", None)),
    };
    if !expand_home(raw, &host.home).is_absolute() {
        return Err(fail_text("invalid", raw));
    }
    let Some(path) = resolve_safe(raw, roots, host) else {
        return Err(fail_text("not-allowed", raw));
    };
    let real = real_of_nearest(&path);
    let Some(real) = real.filter(|real| inside_real_roots(real, roots, host)) else {
        return Err(fail("not-allowed", Some(&path)));
    };
    let folder = string_field(req, "root").and_then(|root| resolve_safe(root, roots, host));
    let real_folder = folder.as_deref().and_then(real_or_none);
    let outside = real_folder
        .as_deref()
        .is_none_or(|real_folder| !is_inside_path(real_folder, &real));
    if outside && !flag(req, "outside") {
        return Err(fail("outside-folder", Some(&path)));
    }
    let symlink = through_symlink(&path, &real, folder.as_deref());
    Ok(Located {
        path,
        real,
        outside,
        symlink,
    })
}

fn open_unsaved(dirty: Option<&Value>, real: &Path, roots: &[&str], host: &Host) -> bool {
    let Some(Value::Array(dirty)) = dirty else {
        return false;
    };
    dirty.iter().take(CHAT_DIRTY_PATHS_MAX).any(|raw| {
        let Some(raw) = raw.as_str() else {
            return false;
        };
        if raw.is_empty() || utf16_len(raw) > PATH_MAX {
            return false;
        }
        resolve_safe(raw, roots, host)
            .is_some_and(|path| real_or_none(&path).unwrap_or(path) == real)
    })
}

fn open_regular(path: &Path) -> std::io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if file.metadata()?.is_file() {
        Ok(file)
    } else {
        Err(ErrorKind::InvalidInput.into())
    }
}

fn looks_binary(buf: &[u8]) -> bool {
    buf[..buf.len().min(BINARY_SNIFF)].contains(&0)
}

fn clamp_int(value: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    let Some(value) = value else {
        return fallback;
    };
    let number = js_to_number(value);
    if !number.is_finite() {
        return fallback;
    }
    (number.floor().max(min as f64)).min(max as f64) as i64
}

fn put(result: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    result.insert(key.to_owned(), value.into());
}

pub fn read_tool(req: &Value, roots: &[&str], host: &Host) -> Value {
    let at = match locate(req, roots, host) {
        Ok(at) => at,
        Err(failure) => return failure,
    };
    let info = match fs::metadata(&at.path) {
        Ok(info) => info,
        Err(err) => return io_fail(&err, &at.path),
    };
    if !info.is_file() {
        return fail("not-a-file", Some(&at.path));
    }
    let mut file = match open_regular(&at.real) {
        Ok(file) => file,
        Err(err) => return io_fail(&err, &at.path),
    };
    match file.metadata() {
        Ok(opened) if opened.len() > CHAT_READ_FILE_MAX as u64 => {
            return fail("too-large", Some(&at.path));
        }
        Ok(_) => {}
        Err(err) => return io_fail(&err, &at.path),
    }
    let mut buf = Vec::new();
    if let Err(err) = file.read_to_end(&mut buf) {
        return io_fail(&err, &at.path);
    }
    if looks_binary(&buf) {
        return fail("binary", Some(&at.path));
    }
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.split('\n').collect();
    let total_lines = lines.len() as i64;
    let start_line = clamp_int(req.get("offset"), 1, total_lines.max(1), 1);
    let limit = clamp_int(
        req.get("limit"),
        1,
        CHAT_READ_LINES_MAX as i64,
        CHAT_READ_LINES_MAX as i64,
    );
    let mut picked: Vec<&str> = Vec::new();
    let mut size = 0usize;
    let mut truncated = false;
    let mut index = (start_line - 1) as usize;
    while index < lines.len() && (picked.len() as i64) < limit {
        let line = lines[index];
        if size + utf16_len(line) + 1 > READ_TEXT_MAX {
            truncated = true;
            break;
        }
        picked.push(line);
        size += utf16_len(line) + 1;
        index += 1;
    }
    let end_line = start_line + picked.len() as i64 - 1;
    if end_line < total_lines {
        truncated = true;
    }
    json!({
        "ok": true,
        "path": path_text(&at.path),
        "text": picked.join("\n"),
        "startLine": start_line,
        "endLine": end_line,
        "totalLines": total_lines,
        "truncated": truncated,
        "version": version_of(&buf),
    })
}

struct ListedEntry {
    name: String,
    kind: EntryKind,
}

#[derive(Clone, Copy, PartialEq)]
enum EntryKind {
    Dir,
    File,
    Other,
}

fn kind_of(entry: &fs::DirEntry) -> EntryKind {
    match entry.file_type() {
        Ok(kind) if kind.is_dir() => EntryKind::Dir,
        Ok(kind) if kind.is_file() => EntryKind::File,
        _ => EntryKind::Other,
    }
}

pub fn list_tool(req: &Value, roots: &[&str], host: &Host) -> Value {
    let at = match locate(req, roots, host) {
        Ok(at) => at,
        Err(failure) => return failure,
    };
    let info = match fs::metadata(&at.path) {
        Ok(info) => info,
        Err(err) => return io_fail(&err, &at.path),
    };
    if !info.is_dir() {
        return fail("not-a-directory", Some(&at.path));
    }
    let dir = match fs::read_dir(&at.path) {
        Ok(dir) => dir,
        Err(err) => return io_fail(&err, &at.path),
    };
    let mut listed: Vec<ListedEntry> = Vec::new();
    for entry in dir {
        match entry {
            Ok(entry) => listed.push(ListedEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                kind: kind_of(&entry),
            }),
            Err(err) => return io_fail(&err, &at.path),
        }
    }
    listed.sort_by(|left, right| {
        let rank = |entry: &ListedEntry| u8::from(entry.kind != EntryKind::Dir);
        rank(left)
            .cmp(&rank(right))
            .then_with(|| locale_compare(&left.name, &right.name))
    });
    let truncated = listed.len() > CHAT_LIST_MAX;
    let entries: Vec<Value> = listed
        .iter()
        .take(CHAT_LIST_MAX)
        .map(|entry| match entry.kind {
            EntryKind::Dir => json!({"name": entry.name, "kind": "dir"}),
            EntryKind::File => match fs::symlink_metadata(at.path.join(&entry.name)) {
                Ok(info) => json!({"name": entry.name, "kind": "file", "size": info.len()}),
                Err(_) => json!({"name": entry.name, "kind": "file"}),
            },
            EntryKind::Other => json!({"name": entry.name, "kind": "other"}),
        })
        .collect();
    json!({
        "ok": true,
        "path": path_text(&at.path),
        "entries": entries,
        "truncated": truncated,
    })
}

struct SearchMatch {
    path: PathBuf,
    line: Option<(usize, String)>,
}

fn search_file(file: &Path, needle: &str, out: &mut Vec<SearchMatch>) -> std::io::Result<()> {
    let mut handle = open_regular(file)?;
    let info = handle.metadata()?;
    if info.len() > CHAT_SEARCH_FILE_MAX as u64 {
        return Ok(());
    }
    let mut buf = Vec::new();
    handle.read_to_end(&mut buf)?;
    if looks_binary(&buf) {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&buf);
    for (index, line) in text.split('\n').enumerate() {
        if out.len() >= CHAT_SEARCH_MATCHES_MAX {
            break;
        }
        if line.to_lowercase().contains(needle) {
            out.push(SearchMatch {
                path: file.to_path_buf(),
                line: Some((
                    index + 1,
                    utf16_prefix(js_trim(line), SEARCH_LINE_MAX).to_owned(),
                )),
            });
        }
    }
    Ok(())
}

fn sorted_children(dir: &Path) -> Vec<(String, EntryKind)> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut children: Vec<(String, EntryKind)> = read
        .filter_map(Result::ok)
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                kind_of(&entry),
            )
        })
        .collect();
    children.sort_by(|left, right| locale_compare(&left.0, &right.0));
    children
}

pub fn search_tool(req: &Value, roots: &[&str], host: &Host) -> Value {
    let query = string_field(req, "query").map_or("", js_trim);
    if query.is_empty() || utf16_len(query) > CHAT_QUERY_MAX {
        return fail("invalid", None);
    }
    let at = match locate(req, roots, host) {
        Ok(at) => at,
        Err(failure) => return failure,
    };
    let needle = query.to_lowercase();
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut files = 0usize;
    let mut truncated = false;
    let mut queue = VecDeque::from([at.path.clone()]);
    match fs::metadata(&at.path) {
        Ok(info) if info.is_dir() => {}
        Ok(_) => return fail("not-a-directory", Some(&at.path)),
        Err(err) => return io_fail(&err, &at.path),
    }
    while let Some(dir) = queue.pop_front() {
        for (name, kind) in sorted_children(&dir) {
            if matches.len() >= CHAT_SEARCH_MATCHES_MAX || files >= CHAT_SEARCH_FILES_MAX {
                truncated = true;
                break;
            }
            let full = dir.join(&name);
            match kind {
                EntryKind::Dir => {
                    if !SKIPPED_DIRS.contains(&name.as_str()) {
                        queue.push_back(full);
                    }
                    continue;
                }
                EntryKind::Other => continue,
                EntryKind::File => {}
            }
            files += 1;
            if name.to_lowercase().contains(&needle) {
                matches.push(SearchMatch {
                    path: full.clone(),
                    line: None,
                });
            }
            let _ = search_file(&full, &needle, &mut matches);
        }
        if truncated {
            break;
        }
    }
    let shown: Vec<Value> = matches
        .iter()
        .map(|found| {
            let relative = found
                .path
                .strip_prefix(&at.path)
                .ok()
                .filter(|relative| !relative.as_os_str().is_empty())
                .unwrap_or(&found.path);
            match &found.line {
                Some((line, text)) => {
                    json!({"path": path_text(relative), "line": line, "text": text})
                }
                None => json!({"path": path_text(relative)}),
            }
        })
        .collect();
    json!({
        "ok": true,
        "path": path_text(&at.path),
        "matches": shown,
        "truncated": truncated,
    })
}

enum Existing {
    Text {
        text: String,
        version: String,
        file: File,
    },
    Missing,
    Refused(Value),
}

fn open_existing(path: &Path, for_write: bool) -> std::io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(for_write)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if file.metadata()?.is_file() {
        Ok(file)
    } else {
        Err(ErrorKind::InvalidInput.into())
    }
}

fn existing_text(path: &Path, for_write: bool) -> Existing {
    let mut file = match open_existing(path, for_write) {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::NotFound => return Existing::Missing,
        Err(_) => {
            return Existing::Refused(match fs::symlink_metadata(path) {
                Ok(info) if !info.is_file() => fail("not-a-file", Some(path)),
                _ => fail("failed", Some(path)),
            });
        }
    };
    match file.metadata() {
        Ok(info) if info.len() > CHAT_WRITE_MAX as u64 => {
            return Existing::Refused(fail("too-large", Some(path)));
        }
        Ok(_) => {}
        Err(_) => return Existing::Refused(fail("failed", Some(path))),
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return Existing::Refused(fail("failed", Some(path)));
    }
    if looks_binary(&buf) {
        return Existing::Refused(fail("binary", Some(path)));
    }
    let version = version_of(&buf);
    match String::from_utf8(buf) {
        Ok(text) => Existing::Text {
            text,
            version,
            file,
        },
        Err(_) => Existing::Refused(fail("binary", Some(path))),
    }
}

fn version_json(existing: &Existing) -> Value {
    match existing {
        Existing::Text { version, .. } => Value::String(version.clone()),
        _ => Value::Null,
    }
}

pub fn preview_tool(req: &Value, roots: &[&str], host: &Host) -> Value {
    let target = json!({
        "path": req.get("path").cloned().unwrap_or(Value::Null),
        "root": req.get("root").cloned().unwrap_or(Value::Null),
        "outside": true,
    });
    let at = match locate(&target, roots, host) {
        Ok(at) => at,
        Err(failure) => return failure,
    };
    let current = existing_text(&at.path, false);
    if let Existing::Refused(failure) = current {
        return failure;
    }
    let version = version_json(&current);
    let (exists, text) = match current {
        Existing::Text { text, .. } => (true, text),
        _ => (false, String::new()),
    };
    json!({
        "ok": true,
        "path": path_text(&at.path),
        "exists": exists,
        "text": text,
        "version": version,
        "outside": at.outside,
        "symlink": at.symlink,
        "unsaved": open_unsaved(req.get("dirty"), &at.real, roots, host),
    })
}

fn chat_edit_of(raw: &Value) -> Option<ChatEdit> {
    let old_text = raw.get("oldText")?.as_str()?;
    let new_text = raw.get("newText")?.as_str()?;
    if old_text.is_empty() {
        return None;
    }
    Some(ChatEdit {
        old_text: old_text.to_owned(),
        new_text: new_text.to_owned(),
        replace_all: truthy(raw, "replaceAll"),
    })
}

fn edit_error_name(error: ChatEditError) -> &'static str {
    match error {
        ChatEditError::NoMatch => "no-match",
        ChatEditError::Ambiguous => "ambiguous",
        ChatEditError::NoChange => "no-change",
    }
}

pub fn plan_edit_tool(req: &Value, roots: &[&str], host: &Host) -> Value {
    let raw_edits: &[Value] = match req.get("edits") {
        Some(Value::Array(list)) => list,
        _ => &[],
    };
    let edits: Option<Vec<ChatEdit>> = raw_edits.iter().map(chat_edit_of).collect();
    let edits = match edits {
        Some(edits) if !edits.is_empty() && edits.len() <= CHAT_EDITS_MAX => edits,
        _ => return fail("invalid", None),
    };
    let target = json!({
        "path": req.get("path").cloned().unwrap_or(Value::Null),
        "root": req.get("root").cloned().unwrap_or(Value::Null),
        "outside": flag(req, "outside"),
    });
    let at = match locate(&target, roots, host) {
        Ok(at) => at,
        Err(failure) => return failure,
    };
    let (before, version) = match existing_text(&at.path, false) {
        Existing::Refused(failure) => return failure,
        Existing::Missing => return fail("not-found", Some(&at.path)),
        Existing::Text { text, version, .. } => (text, version),
    };
    let after = match apply_edits(&before, &edits) {
        Ok(after) => after,
        Err(problem) => {
            let mut result = Map::new();
            put(&mut result, "ok", false);
            put(&mut result, "path", path_text(&at.path));
            put(&mut result, "error", edit_error_name(problem.error));
            put(&mut result, "edit", problem.edit);
            if let Some(count) = problem.count {
                put(&mut result, "count", count);
            }
            return Value::Object(result);
        }
    };
    if after.len() > CHAT_WRITE_MAX {
        return fail("too-large", Some(&at.path));
    }
    json!({
        "ok": true,
        "path": path_text(&at.path),
        "before": before,
        "after": after,
        "version": version,
        "outside": at.outside,
        "symlink": at.symlink,
        "unsaved": open_unsaved(req.get("dirty"), &at.real, roots, host),
    })
}

fn parent_inside_roots(path: &Path, roots: &[&str], host: &Host) -> std::io::Result<bool> {
    let parent = dirname(path);
    fs::create_dir_all(&parent)?;
    Ok(real_or_none(&parent).is_some_and(|parent| inside_real_roots(&parent, roots, host)))
}

fn writable(req: &Value, roots: &[&str], host: &Host) -> Result<Located, Value> {
    let at = locate(req, roots, host)?;
    if at.symlink && !flag(req, "symlinks") {
        return Err(fail("through-symlink", Some(&at.path)));
    }
    Ok(at)
}

fn create_content(path: &Path, content: &str) -> std::io::Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?
        .write_all(content.as_bytes())
}

fn rewrite_content(file: &mut File, content: &str) -> std::io::Result<()> {
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(content.as_bytes())
}

fn store_content(current: Existing, path: &Path, content: &str) -> std::io::Result<()> {
    match current {
        Existing::Text { mut file, .. } => rewrite_content(&mut file, content),
        Existing::Missing => create_content(path, content),
        Existing::Refused(_) => Err(ErrorKind::InvalidInput.into()),
    }
}

pub fn write_tool(req: &Value, roots: &[&str], host: &Host) -> Value {
    let content = match string_field(req, "content") {
        Some(content) if content.len() <= CHAT_WRITE_MAX => content,
        _ => return fail("too-large", None),
    };
    let at = match writable(req, roots, host) {
        Ok(at) => at,
        Err(failure) => return failure,
    };
    let current = existing_text(&at.path, true);
    if let Existing::Refused(failure) = current {
        return failure;
    }
    let base = string_field(req, "base");
    let current_version = match &current {
        Existing::Text { version, .. } => Some(version.as_str()),
        _ => None,
    };
    if current_version != base {
        return fail("changed", Some(&at.path));
    }
    let created = matches!(current, Existing::Missing);
    match parent_inside_roots(&at.path, roots, host) {
        Ok(true) => {}
        Ok(false) => return fail("not-allowed", Some(&at.path)),
        Err(_) => return fail("failed", Some(&at.path)),
    }
    if store_content(current, &at.path, content).is_err() {
        return fail("failed", Some(&at.path));
    }
    json!({
        "ok": true,
        "path": path_text(&at.path),
        "created": created,
        "bytes": content.len(),
        "version": version_of(content.as_bytes()),
    })
}

pub fn restore_tool(req: &Value, roots: &[&str], host: &Host) -> Value {
    let content = match req.get("content") {
        None | Some(Value::Null) => None,
        Some(Value::String(content)) if content.len() <= CHAT_WRITE_MAX => Some(content.as_str()),
        Some(_) => return fail("too-large", None),
    };
    let expected = string_field(req, "expected");
    let at = match writable(req, roots, host) {
        Ok(at) => at,
        Err(failure) => return failure,
    };
    if open_unsaved(req.get("dirty"), &at.real, roots, host) {
        return fail("unsaved", Some(&at.path));
    }
    let current = existing_text(&at.path, content.is_some());
    if let Existing::Refused(failure) = current {
        return failure;
    }
    let current_version = match &current {
        Existing::Text { version, .. } => Some(version.as_str()),
        _ => None,
    };
    if current_version != expected {
        return fail("changed", Some(&at.path));
    }
    let version = content.map_or(Value::Null, |content| {
        Value::String(version_of(content.as_bytes()))
    });
    let removed = content.is_none();
    let done = json!({
        "ok": true,
        "path": path_text(&at.path),
        "removed": removed,
        "version": version,
    });
    if flag(req, "check") {
        return done;
    }
    let Some(content) = content else {
        if matches!(current, Existing::Text { .. }) && fs::remove_file(&at.path).is_err() {
            return fail("failed", Some(&at.path));
        }
        return done;
    };
    match parent_inside_roots(&at.path, roots, host) {
        Ok(true) => {}
        Ok(false) => return fail("not-allowed", Some(&at.path)),
        Err(_) => return fail("failed", Some(&at.path)),
    }
    if store_content(current, &at.path, content).is_err() {
        return fail("failed", Some(&at.path));
    }
    done
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod handle_tests;
