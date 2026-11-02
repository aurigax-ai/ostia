use std::collections::HashMap;
use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex};
use regex::Regex;

use crate::git::{
    BlameLine, CommitFile, CommitRef, CommitSummary, GraphCommit, RefKind, is_sha, js_number,
};

pub const FIELD_SEP: &str = "\x1f";
pub const RECORD_SEP: &str = "\x1e";
pub const LOG_FORMAT: &str = concat!(
    "%H", "\x1f", "%an", "\x1f", "%ae", "\x1f", "%at", "\x1f", "%s", "\x1e"
);
pub const GRAPH_FORMAT: &str = concat!(
    "%H", "\x1f", "%P", "\x1f", "%an", "\x1f", "%ae", "\x1f", "%at", "\x1f", "%D", "\x1f", "%s",
    "\x1e"
);

const REF_PREFIXES: [(&str, RefKind); 3] = [
    ("refs/heads/", RefKind::Branch),
    ("refs/remotes/", RefKind::Remote),
    ("refs/tags/", RefKind::Tag),
];

static BLAME_HEADER: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^([0-9a-f]{40,64}) [0-9]+ ([0-9]+)"));

pub fn parse_log(output: &str) -> Vec<CommitSummary> {
    let mut commits = Vec::new();
    for record in output.split(RECORD_SEP) {
        let fields: Vec<&str> = record
            .strip_prefix('\n')
            .unwrap_or(record)
            .split(FIELD_SEP)
            .collect();
        if fields.len() != 5 || !is_sha(fields[0]) {
            continue;
        }
        commits.push(CommitSummary {
            sha: fields[0].to_owned(),
            author: fields[1].to_owned(),
            email: fields[2].to_owned(),
            time: js_number(fields[3]),
            subject: fields[4].to_owned(),
        });
    }
    commits
}

fn parse_ref(name: &str, current: bool) -> Option<CommitRef> {
    for (prefix, kind) in REF_PREFIXES {
        let Some(short) = name.strip_prefix(prefix) else {
            continue;
        };
        if kind == RefKind::Remote && short.ends_with("/HEAD") {
            return None;
        }
        return Some(CommitRef {
            kind,
            name: short.to_owned(),
            current,
        });
    }
    None
}

fn pointed_ref(part: &str) -> Option<&str> {
    let rest = part.strip_prefix("HEAD -> ")?;
    let has_line_end = rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    (!rest.is_empty() && !has_line_end).then_some(rest)
}

pub fn parse_decorations(decoration: &str) -> Vec<CommitRef> {
    let mut refs = Vec::new();
    for raw in decoration.split(", ") {
        let part = js_trim(raw);
        if part.is_empty() {
            continue;
        }
        if part == "HEAD" {
            refs.push(CommitRef {
                kind: RefKind::Head,
                name: "HEAD".to_owned(),
                current: false,
            });
            continue;
        }
        let parsed = match pointed_ref(part) {
            Some(name) => parse_ref(name, true),
            None => parse_ref(part.strip_prefix("tag: ").unwrap_or(part), false),
        };
        refs.extend(parsed);
    }
    refs.sort_by(|a, b| b.current.cmp(&a.current).then(a.kind.cmp(&b.kind)));
    refs
}

pub fn parse_graph_log(output: &str) -> Vec<GraphCommit> {
    let mut commits = Vec::new();
    for record in output.split(RECORD_SEP) {
        let fields: Vec<&str> = record
            .strip_prefix('\n')
            .unwrap_or(record)
            .split(FIELD_SEP)
            .collect();
        if fields.len() != 7 || !is_sha(fields[0]) {
            continue;
        }
        commits.push(GraphCommit {
            sha: fields[0].to_owned(),
            parents: fields[1]
                .split(' ')
                .filter(|parent| !parent.is_empty())
                .map(str::to_owned)
                .collect(),
            author: fields[2].to_owned(),
            email: fields[3].to_owned(),
            time: js_number(fields[4]),
            subject: fields[6].to_owned(),
            refs: parse_decorations(fields[5]),
        });
    }
    commits
}

pub fn parse_name_status(output: &str) -> Vec<CommitFile> {
    let mut files = Vec::new();
    let mut fields = output.split('\0');
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let code: String = status.chars().take(1).collect();
        if code == "R" || code == "C" {
            let orig_path = fields.next().filter(|orig| !orig.is_empty());
            let path = fields.next().filter(|path| !path.is_empty());
            if let (Some(orig_path), Some(path)) = (orig_path, path) {
                files.push(CommitFile {
                    path: path.to_owned(),
                    orig_path: Some(orig_path.to_owned()),
                    code,
                });
            }
        } else if let Some(path) = fields.next().filter(|path| !path.is_empty()) {
            files.push(CommitFile {
                path: path.to_owned(),
                orig_path: None,
                code,
            });
        }
    }
    files
}

#[derive(Clone, Default)]
struct BlameCommit {
    author: String,
    time: i64,
    summary: String,
}

pub fn parse_blame_porcelain(output: &str) -> Vec<BlameLine> {
    let mut lines = Vec::new();
    let mut commits: HashMap<String, BlameCommit> = HashMap::new();
    let mut sha = String::new();
    let mut final_line = 0;
    for raw in output.split('\n') {
        if let Some(text) = raw.strip_prefix('\t') {
            let info = commits.get(&sha).cloned().unwrap_or_default();
            lines.push(BlameLine {
                line: final_line,
                sha: sha.clone(),
                author: info.author,
                time: info.time,
                summary: info.summary,
                text: text.to_owned(),
            });
            continue;
        }
        if let Some(header) = BLAME_HEADER.captures(raw) {
            sha = header[1].to_owned();
            final_line = js_number(&header[2]);
            commits.entry(sha.clone()).or_default();
            continue;
        }
        let Some(info) = commits.get_mut(&sha) else {
            continue;
        };
        let (key, value) = raw.split_once(' ').unwrap_or((raw, ""));
        match key {
            "author" => info.author = value.to_owned(),
            "author-time" => info.time = js_number(value),
            "summary" => info.summary = value.to_owned(),
            _ => {}
        }
    }
    lines
}
