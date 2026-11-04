use super::text_diff::diff_lines;

const CONTEXT_LINES: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HunkDecision {
    Accepted,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditHunk {
    pub index: usize,
    pub old_start: usize,
    pub removed: Vec<String>,
    pub added: Vec<String>,
    pub leading: Vec<String>,
    pub trailing: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HunkCounts {
    pub added: usize,
    pub removed: usize,
}

enum Piece {
    Same(String),
    Change { removed: String, added: String },
}

fn lines_of(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
        .into_iter()
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
        .collect()
}

fn pieces(before: &str, after: &str) -> Vec<Piece> {
    let mut out: Vec<Piece> = Vec::new();
    for change in diff_lines(before, after) {
        if !change.added && !change.removed {
            out.push(Piece::Same(change.value));
            continue;
        }
        if !matches!(out.last(), Some(Piece::Change { .. })) {
            out.push(Piece::Change {
                removed: String::new(),
                added: String::new(),
            });
        }
        if let Some(Piece::Change { removed, added }) = out.last_mut() {
            if change.removed {
                removed.push_str(&change.value);
            } else {
                added.push_str(&change.value);
            }
        }
    }
    out
}

pub fn edit_hunks(before: &str, after: &str) -> Vec<EditHunk> {
    let list = pieces(before, after);
    let mut hunks: Vec<EditHunk> = Vec::new();
    let mut line = 1;
    for (at, piece) in list.iter().enumerate() {
        let Piece::Change { removed, added } = piece else {
            if let Piece::Same(text) = piece {
                line += lines_of(text).len();
            }
            continue;
        };
        let previous = at.checked_sub(1).and_then(|prev| list.get(prev));
        let next = list.get(at + 1);
        let removed_lines = lines_of(removed);
        let leading = match previous {
            Some(Piece::Same(text)) => {
                let lines = lines_of(text);
                lines[lines.len().saturating_sub(CONTEXT_LINES)..].to_vec()
            }
            _ => Vec::new(),
        };
        let trailing = match next {
            Some(Piece::Same(text)) => lines_of(text).into_iter().take(CONTEXT_LINES).collect(),
            _ => Vec::new(),
        };
        let consumed = removed_lines.len();
        hunks.push(EditHunk {
            index: hunks.len(),
            old_start: line,
            removed: removed_lines,
            added: lines_of(added),
            leading,
            trailing,
        });
        line += consumed;
    }
    hunks
}

pub fn content_with(before: &str, after: &str, decisions: &[Option<HunkDecision>]) -> String {
    let mut hunk = 0;
    let mut out = String::new();
    for piece in pieces(before, after) {
        match piece {
            Piece::Same(text) => out.push_str(&text),
            Piece::Change { removed, added } => {
                let decision = decisions.get(hunk).copied().flatten();
                hunk += 1;
                out.push_str(if decision == Some(HunkDecision::Rejected) {
                    &removed
                } else {
                    &added
                });
            }
        }
    }
    out
}

pub fn hunk_counts(hunks: &[EditHunk], decisions: &[Option<HunkDecision>]) -> HunkCounts {
    let mut counts = HunkCounts {
        added: 0,
        removed: 0,
    };
    for hunk in hunks {
        if decisions.get(hunk.index).copied().flatten() == Some(HunkDecision::Rejected) {
            continue;
        }
        counts.added += hunk.added.len();
        counts.removed += hunk.removed.len();
    }
    counts
}

pub fn all_decided(count: usize, decisions: &[Option<HunkDecision>]) -> bool {
    (0..count).all(|at| decisions.get(at).copied().flatten().is_some())
}

pub fn settle(count: usize, decisions: &[Option<HunkDecision>]) -> Vec<HunkDecision> {
    (0..count)
        .map(|at| {
            decisions
                .get(at)
                .copied()
                .flatten()
                .unwrap_or(HunkDecision::Accepted)
        })
        .collect()
}
