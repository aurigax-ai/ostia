use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use globset::{GlobBuilder, GlobMatcher};
use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{CollatorBorrowed, CollatorPreferences};
use ostia_base::js::{JS_DOT, js_trim, non_empty, static_regex};
use ostia_contract::files_api::FsEntry;
use regex::Regex;
use serde_json::{Map, Value};

use crate::settings::file_tree_settings::{FileSortBy, FileSortOrder};

pub const COMPACT_MAX_DEPTH: usize = 32;

static NAME_COLLATOR: LazyLock<Option<CollatorBorrowed<'static>>> = LazyLock::new(|| {
    let mut prefs = CollatorPreferences::default();
    prefs.numeric_ordering = Some(CollationNumericOrdering::True);
    let mut options = CollatorOptions::default();
    options.strength = Some(Strength::Primary);
    CollatorBorrowed::try_new(prefs, options).ok()
});

static COMPACT_PART: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\$\{[a-z]+\}|\*"));

pub fn name_compare(left: &str, right: &str) -> Ordering {
    NAME_COLLATOR
        .as_ref()
        .map_or(Ordering::Equal, |collator| collator.compare(left, right))
}

pub fn child_path(path: &str, name: &str) -> String {
    if path.ends_with('/') {
        format!("{path}{name}")
    } else {
        format!("{path}/{name}")
    }
}

pub fn relative_to_root<'a>(path: &'a str, root: &str) -> Option<&'a str> {
    let base = root_base(root);
    path.strip_prefix(base.as_str())
}

fn root_base(root: &str) -> String {
    if root.ends_with('/') {
        root.to_owned()
    } else {
        format!("{root}/")
    }
}

pub fn base_name(path: &str) -> &str {
    let name = path.rfind('/').map_or(path, |slash| &path[slash + 1..]);
    if name.is_empty() { path } else { name }
}

pub fn parent_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(slash) if slash > 0 => &path[..slash],
        _ => "/",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SplitPath<'a> {
    pub name: &'a str,
    pub dir: &'a str,
}

pub fn split_path(path: &str) -> SplitPath<'_> {
    match path.rfind('/') {
        None => SplitPath {
            name: path,
            dir: "",
        },
        Some(slash) => SplitPath {
            name: &path[slash + 1..],
            dir: &path[..slash],
        },
    }
}

fn expand_home(path: &str, home: Option<&str>) -> String {
    match non_empty(home) {
        Some(home) if path == "~" || path.starts_with("~/") => format!("{home}{}", &path[1..]),
        _ => path.to_owned(),
    }
}

pub fn path_in_tree(path: &str, root: &str, home: Option<&str>) -> Option<String> {
    let target = expand_home(path, home);
    let base = expand_home(root, home);
    if target == base {
        return Some(root.to_owned());
    }
    let rel = relative_to_root(&target, &base)?;
    Some(child_path(root, rel))
}

pub struct ExcludeMatcher {
    tests: Vec<GlobMatcher>,
}

impl ExcludeMatcher {
    pub fn is_excluded(&self, path: &str, root: &str) -> bool {
        let rel = relative_to_root(path, root);
        self.tests
            .iter()
            .any(|test| test.is_match(path) || rel.is_some_and(|rel| test.is_match(rel)))
    }
}

pub fn is_under_excluded(excluded: &ExcludeMatcher, path: &str, root: &str) -> bool {
    let Some(rel) = relative_to_root(path, root) else {
        return excluded.is_excluded(path, root);
    };
    let base = root_base(root);
    let parts: Vec<&str> = rel.split('/').collect();
    (0..parts.len())
        .any(|i| excluded.is_excluded(&format!("{base}{}", parts[..=i].join("/")), root))
}

fn compile_glob(pattern: &str) -> Option<GlobMatcher> {
    let trimmed = js_trim(pattern).trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    GlobBuilder::new(trimmed)
        .literal_separator(true)
        .build()
        .ok()
        .map(|glob| glob.compile_matcher())
}

pub fn exclude_matcher<S: AsRef<str>>(patterns: &[S]) -> ExcludeMatcher {
    ExcludeMatcher {
        tests: patterns
            .iter()
            .filter_map(|pattern| compile_glob(pattern.as_ref()))
            .collect(),
    }
}

fn type_key(entry: &FsEntry) -> String {
    if entry.dir {
        return String::new();
    }
    match entry.name.rfind('.') {
        Some(dot) if dot > 0 => entry.name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

fn code_unit_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

pub fn sort_entries(entries: &[FsEntry], order: FileSortOrder, by: FileSortBy) -> Vec<FsEntry> {
    let mut sorted = entries.to_vec();
    sorted.sort_by(|a, b| {
        if order == FileSortOrder::FoldersFirst && a.dir != b.dir {
            return if a.dir {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        if by == FileSortBy::Type {
            let by_type = name_compare(&type_key(a), &type_key(b));
            if by_type != Ordering::Equal {
                return by_type;
            }
        }
        name_compare(&a.name, &b.name).then_with(|| code_unit_order(&a.name, &b.name))
    });
    sorted
}

#[derive(Clone, Debug)]
pub struct NestingRule {
    pub parent: Regex,
    pub children: Vec<String>,
}

pub fn nesting_rules(patterns: &Map<String, Value>) -> Vec<NestingRule> {
    let mut rules = Vec::new();
    for (key, value) in patterns {
        let parent = js_trim(key);
        if parent.is_empty() || parent.split('*').count() > 2 {
            continue;
        }
        let source = match parent.split_once('*') {
            Some((head, tail)) => format!(
                "^{}({JS_DOT}*){}$",
                regex::escape(head),
                regex::escape(tail)
            ),
            None => format!("^{}$", regex::escape(parent)),
        };
        let Some(value) = value.as_str() else {
            continue;
        };
        let children: Vec<String> = value
            .split(',')
            .map(js_trim)
            .filter(|child| !child.is_empty())
            .map(str::to_owned)
            .collect();
        if children.is_empty() {
            continue;
        }
        if let Ok(parent) = Regex::new(&format!("(?i){source}")) {
            rules.push(NestingRule { parent, children });
        }
    }
    rules
}

fn basename_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    }
}

fn extname_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[dot + 1..],
        _ => "",
    }
}

fn child_matcher(pattern: &str, capture: &str, parent: &str) -> Option<Regex> {
    let mut source = String::new();
    let mut last = 0;
    for part in COMPACT_PART.find_iter(pattern) {
        source.push_str(&regex::escape(&pattern[last..part.start()]));
        last = part.end();
        let text = part.as_str();
        if text == "*" {
            source.push_str(JS_DOT);
            source.push('*');
            continue;
        }
        let value = match &text[2..text.len() - 1] {
            "capture" => Some(capture),
            "basename" => Some(basename_of(parent)),
            "extname" => Some(extname_of(parent)),
            _ => None,
        };
        source.push_str(&regex::escape(value.unwrap_or(text)));
    }
    source.push_str(&regex::escape(&pattern[last..]));
    Regex::new(&format!("(?i)^{source}$")).ok()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NestedEntry {
    pub entry: FsEntry,
    pub nested: Vec<FsEntry>,
}

pub fn nest_entries(entries: &[FsEntry], rules: &[NestingRule]) -> Vec<NestedEntry> {
    if rules.is_empty() {
        return entries
            .iter()
            .map(|entry| NestedEntry {
                entry: entry.clone(),
                nested: Vec::new(),
            })
            .collect();
    }
    let files: Vec<usize> = (0..entries.len()).filter(|&i| !entries[i].dir).collect();
    let mut parent_index: HashMap<usize, usize> = HashMap::new();
    let mut has_children: HashSet<usize> = HashSet::new();
    for &parent in &files {
        if parent_index.contains_key(&parent) {
            continue;
        }
        let parent_name = &entries[parent].name;
        let mut matchers: Vec<Regex> = Vec::new();
        for rule in rules {
            let Some(found) = rule.parent.captures(parent_name) else {
                continue;
            };
            let capture = found.get(1).map_or("", |m| m.as_str());
            matchers.extend(
                rule.children
                    .iter()
                    .filter_map(|child| child_matcher(child, capture, parent_name)),
            );
        }
        if matchers.is_empty() {
            continue;
        }
        for &file in &files {
            if file == parent || parent_index.contains_key(&file) || has_children.contains(&file) {
                continue;
            }
            if matchers.iter().any(|re| re.is_match(&entries[file].name)) {
                parent_index.insert(file, parent);
                has_children.insert(parent);
            }
        }
    }
    let mut out: Vec<NestedEntry> = Vec::new();
    let mut slot: HashMap<usize, usize> = HashMap::new();
    for (i, entry) in entries.iter().enumerate() {
        if parent_index.contains_key(&i) {
            continue;
        }
        slot.insert(i, out.len());
        out.push(NestedEntry {
            entry: entry.clone(),
            nested: Vec::new(),
        });
    }
    for (i, entry) in entries.iter().enumerate() {
        if let Some(item) = parent_index
            .get(&i)
            .and_then(|parent| slot.get(parent))
            .and_then(|&at| out.get_mut(at))
        {
            item.nested.push(entry.clone());
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompactChain {
    pub names: Vec<String>,
    pub path: String,
    pub entries: Vec<FsEntry>,
}

pub async fn compact_chain(
    path: &str,
    list: impl AsyncFn(&str) -> Vec<FsEntry>,
    visible: impl Fn(Vec<FsEntry>, &str) -> Vec<FsEntry>,
    max_depth: usize,
) -> CompactChain {
    let mut names: Vec<String> = Vec::new();
    let mut current = path.to_owned();
    let mut entries = visible(list(&current).await, &current);
    while names.len() < max_depth && entries.len() == 1 && entries[0].dir {
        names.push(entries[0].name.clone());
        current = child_path(&current, &entries[0].name);
        entries = visible(list(&current).await, &current);
    }
    CompactChain {
        names,
        path: current,
        entries,
    }
}
