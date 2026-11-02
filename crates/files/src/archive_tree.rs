use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use ostia_base::js::static_regex;
use ostia_contract::file_browse::BrowseLimits;
use ostia_contract::files_api::FsEntry;
use regex::{Captures, Regex};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawEntry {
    pub name: String,
    pub index: usize,
    pub dir: bool,
    pub size: u64,
    pub encrypted: bool,
    pub link: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryRef {
    pub index: usize,
    pub size: u64,
    pub encrypted: bool,
    pub link: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveTree {
    pub dirs: HashMap<String, Vec<FsEntry>>,
    pub files: HashMap<String, EntryRef>,
    pub cut: bool,
}

static ESCAPED: LazyLock<Regex> = LazyLock::new(|| static_regex(r"[\p{Cc}\p{Cf}]"));

fn escape_char(found: &Captures<'_>) -> String {
    let code = found[0].chars().next().map_or(0, u32::from);
    if code > 0xffff {
        format!("\\u{{{code:x}}}")
    } else {
        format!("\\u{code:04x}")
    }
}

fn shown_text(text: &str, limit: usize) -> String {
    let escaped = ESCAPED.replace_all(text, |found: &Captures<'_>| escape_char(found));
    let units: Vec<u16> = escaped.encode_utf16().collect();
    if units.len() > limit {
        format!("{}…", String::from_utf16_lossy(&units[..limit]))
    } else {
        escaped.into_owned()
    }
}

pub fn segments_of(name: &str, limits: &BrowseLimits) -> Vec<String> {
    let mut parts: Vec<String> = name
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .map(|part| shown_text(part, limits.name_length))
        .collect();
    if parts.len() <= limits.depth {
        return parts;
    }
    let tail = parts.split_off(limits.depth.saturating_sub(1)).join("／");
    parts.push(tail);
    parts
}

fn joined(parts: &[String]) -> String {
    parts.join("/")
}

fn ensure_dir(dirs: &mut HashMap<String, Vec<FsEntry>>, parts: &[String]) {
    for i in 1..=parts.len() {
        let path = joined(&parts[..i]);
        if dirs.contains_key(&path) {
            continue;
        }
        dirs.insert(path, Vec::new());
        if let Some(parent) = dirs.get_mut(&joined(&parts[..i - 1])) {
            parent.push(FsEntry {
                name: parts[i - 1].clone(),
                dir: true,
                archive: false,
                link: None,
                encrypted: false,
            });
        }
    }
}

pub fn build_tree(raw: &[RawEntry], limits: &BrowseLimits, cut: bool) -> ArchiveTree {
    let mut dirs = HashMap::from([(String::new(), Vec::new())]);
    let mut files = HashMap::new();
    let kept = &raw[..raw.len().min(limits.entries)];
    let placed: Vec<(&RawEntry, Vec<String>)> = kept
        .iter()
        .map(|entry| (entry, segments_of(&entry.name, limits)))
        .collect();
    for (entry, parts) in &placed {
        if parts.is_empty() {
            continue;
        }
        let folder = if entry.dir {
            &parts[..]
        } else {
            &parts[..parts.len() - 1]
        };
        ensure_dir(&mut dirs, folder);
    }
    let mut taken: HashMap<String, HashSet<String>> = HashMap::new();
    let mut next_suffix: HashMap<(String, String), usize> = HashMap::new();
    for (entry, parts) in &placed {
        let Some((base, parents)) = parts.split_last() else {
            continue;
        };
        if entry.dir {
            continue;
        }
        let parent = joined(parents);
        let siblings = dirs.entry(parent.clone()).or_default();
        let taken_here = taken.entry(parent.clone()).or_insert_with(|| {
            siblings
                .iter()
                .map(|sibling| sibling.name.clone())
                .collect()
        });
        let mut name = base.clone();
        if taken_here.contains(&name) {
            let next = next_suffix
                .entry((parent.clone(), base.clone()))
                .or_insert(2);
            name = format!("{base} ({next})");
            while taken_here.contains(&name) {
                *next += 1;
                name = format!("{base} ({next})");
            }
            *next += 1;
        }
        taken_here.insert(name.clone());
        let path = if parent.is_empty() {
            name.clone()
        } else {
            format!("{parent}/{name}")
        };
        files.insert(
            path,
            EntryRef {
                index: entry.index,
                size: entry.size,
                encrypted: entry.encrypted,
                link: entry.link.clone(),
            },
        );
        siblings.push(FsEntry {
            name,
            dir: false,
            archive: false,
            link: entry
                .link
                .as_deref()
                .map(|link| shown_text(link, limits.name_length)),
            encrypted: entry.encrypted,
        });
    }
    ArchiveTree {
        dirs,
        files,
        cut: cut || raw.len() > limits.entries,
    }
}
