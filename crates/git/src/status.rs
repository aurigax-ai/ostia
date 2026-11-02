use std::collections::BTreeSet;
use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex, utf16_len};
use regex::Regex;

use crate::git::{
    BranchInfo, ChangeArea, FileChange, LineChanges, RepoStatus, StatusSummary, js_number,
};

const BRANCH_MAX: usize = 40;
const CHIP_BRANCH_MAX: usize = 28;
const MAX_TRACKING_COUNT: i64 = 999;

static AHEAD_BEHIND: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^\+([0-9]+) -([0-9]+)$"));
static FILES_CHANGED: LazyLock<Regex> = LazyLock::new(|| static_regex(r"([0-9]+) files? changed"));
static INSERTIONS: LazyLock<Regex> = LazyLock::new(|| static_regex(r"([0-9]+) insertions?\(\+\)"));
static DELETIONS: LazyLock<Regex> = LazyLock::new(|| static_regex(r"([0-9]+) deletions?\(-\)"));

fn split_fields(line: &str, count: usize) -> Option<Vec<&str>> {
    let fields: Vec<&str> = line.splitn(count, ' ').collect();
    (fields.len() == count).then_some(fields)
}

fn apply_header(branch: &mut BranchInfo, header: &str) {
    let (key, value) = header.split_once(' ').unwrap_or((header, ""));
    match key {
        "branch.oid" => {
            branch.oid = (value != "(initial)").then(|| value.to_owned());
        }
        "branch.head" => {
            branch.head = (value != "(detached)").then(|| value.to_owned());
        }
        "branch.upstream" => branch.upstream = Some(value.to_owned()),
        "branch.ab" => {
            if let Some(counts) = AHEAD_BEHIND.captures(value) {
                branch.ahead = js_number(&counts[1]);
                branch.behind = js_number(&counts[2]);
            }
        }
        _ => {}
    }
}

fn tracked(xy: &str, path: &str, orig_path: Option<&str>) -> Vec<FileChange> {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    let mut out = Vec::new();
    if x != '.' {
        out.push(FileChange {
            path: path.to_owned(),
            orig_path: orig_path.map(str::to_owned),
            area: ChangeArea::Staged,
            code: x.to_string(),
        });
    }
    if y != '.' {
        out.push(FileChange {
            path: path.to_owned(),
            orig_path: None,
            area: ChangeArea::Unstaged,
            code: y.to_string(),
        });
    }
    out
}

pub fn parse_porcelain_v2(output: &str) -> RepoStatus {
    let mut branch = BranchInfo::default();
    let mut changes = Vec::new();
    let records: Vec<&str> = output.split('\0').collect();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        match record.chars().next() {
            Some('#') => apply_header(&mut branch, record.get(2..).unwrap_or_default()),
            Some('1') => {
                if let Some(f) = split_fields(record, 9) {
                    changes.extend(tracked(f[1], f[8], None));
                }
            }
            Some('2') => {
                let orig_path = records.get(index).copied().filter(|orig| !orig.is_empty());
                index += 1;
                if let Some(f) = split_fields(record, 10) {
                    changes.extend(tracked(f[1], f[9], orig_path));
                }
            }
            Some('u') => {
                if let Some(f) = split_fields(record, 11) {
                    changes.push(FileChange {
                        path: f[10].to_owned(),
                        orig_path: None,
                        area: ChangeArea::Conflicted,
                        code: "U".to_owned(),
                    });
                }
            }
            Some('?') => changes.push(FileChange {
                path: record.get(2..).unwrap_or_default().to_owned(),
                orig_path: None,
                area: ChangeArea::Untracked,
                code: "?".to_owned(),
            }),
            _ => {}
        }
    }
    RepoStatus { branch, changes }
}

pub fn summarize(status: &RepoStatus) -> StatusSummary {
    let mut summary = StatusSummary::default();
    let mut added = BTreeSet::new();
    let mut changed = BTreeSet::new();
    for change in &status.changes {
        match change.area {
            ChangeArea::Staged => summary.staged += 1,
            ChangeArea::Unstaged => summary.unstaged += 1,
            ChangeArea::Untracked => summary.untracked += 1,
            ChangeArea::Conflicted => summary.conflicted += 1,
        }
        if change.area == ChangeArea::Untracked
            || (change.area == ChangeArea::Staged && change.code == "A")
        {
            added.insert(change.path.as_str());
        }
    }
    for change in &status.changes {
        if !added.contains(change.path.as_str()) {
            changed.insert(change.path.as_str());
        }
    }
    summary.added = i64::try_from(added.len()).unwrap_or(i64::MAX);
    summary.changed = i64::try_from(changed.len()).unwrap_or(i64::MAX);
    summary
}

fn non_empty(text: Option<&str>) -> Option<&str> {
    text.filter(|value| !value.is_empty())
}

fn short_sha(oid: &str) -> &str {
    oid.get(..7).unwrap_or(oid)
}

fn clipped(name: &str, max: usize) -> String {
    if utf16_len(name) <= max {
        return name.to_owned();
    }
    let mut units = 0;
    let mut kept = String::new();
    for ch in name.chars() {
        let width = ch.len_utf16();
        if units + width > max - 1 {
            break;
        }
        units += width;
        kept.push(ch);
    }
    format!("{kept}…")
}

pub fn branch_label(branch: &BranchInfo) -> String {
    if let Some(head) = non_empty(branch.head.as_deref()) {
        return clipped(head, BRANCH_MAX);
    }
    match non_empty(branch.oid.as_deref()) {
        Some(oid) => format!("({})", short_sha(oid)),
        None => "(no commits)".to_owned(),
    }
}

fn tracking_count(count: i64) -> String {
    if count > MAX_TRACKING_COUNT {
        format!("{MAX_TRACKING_COUNT}+")
    } else {
        count.to_string()
    }
}

pub fn branch_chip_text(branch: &BranchInfo, lines: &str) -> String {
    let full = match &branch.head {
        Some(head) => head.clone(),
        None => non_empty(branch.oid.as_deref())
            .map(|oid| short_sha(oid).to_owned())
            .unwrap_or_default(),
    };
    if full.is_empty() {
        return String::new();
    }
    let name = clipped(&full, CHIP_BRANCH_MAX);
    let mut tracking = Vec::new();
    if non_empty(branch.upstream.as_deref()).is_some() {
        if branch.ahead != 0 {
            tracking.push(format!("↑{}", tracking_count(branch.ahead)));
        }
        if branch.behind != 0 {
            tracking.push(format!("↓{}", tracking_count(branch.behind)));
        }
    }
    [name.as_str(), lines, tracking.join(" ").as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

pub fn parse_shortstat(output: &str) -> Option<LineChanges> {
    let line = js_trim(output);
    if line.is_empty() {
        return None;
    }
    let files = FILES_CHANGED.captures(line)?;
    let added = INSERTIONS.captures(line);
    let removed = DELETIONS.captures(line);
    Some(LineChanges {
        files: js_number(&files[1]),
        added: added.map_or(0, |caps| js_number(&caps[1])),
        removed: removed.map_or(0, |caps| js_number(&caps[1])),
    })
}

pub fn text_line_count(buf: &[u8], sniff: usize) -> i64 {
    let head = &buf[..sniff.min(buf.len())];
    if buf.is_empty() || head.contains(&0) {
        return 0;
    }
    let lines = buf.iter().filter(|&&byte| byte == b'\n').count();
    let lines = i64::try_from(lines).unwrap_or(i64::MAX);
    if buf.last() == Some(&b'\n') {
        lines
    } else {
        lines + 1
    }
}

pub fn with_untracked(tracked: Option<&LineChanges>, untracked_lines: &[i64]) -> LineChanges {
    let base = tracked.cloned().unwrap_or(LineChanges {
        files: 0,
        added: 0,
        removed: 0,
    });
    LineChanges {
        files: base.files + i64::try_from(untracked_lines.len()).unwrap_or(i64::MAX),
        added: base.added + untracked_lines.iter().sum::<i64>(),
        removed: base.removed,
    }
}

pub fn diff_stats_chip_text(changes: Option<&LineChanges>) -> String {
    let Some(changes) = changes else {
        return String::new();
    };
    let mut parts = Vec::new();
    if changes.added != 0 {
        parts.push(format!("+{}", changes.added));
    }
    if changes.removed != 0 {
        parts.push(format!("−{}", changes.removed));
    }
    parts.join(" ")
}
