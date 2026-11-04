use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex, utf16_len};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::capabilities::Capability;
use crate::is_record::is_record;

pub const FILE_KIND_VIEW_PRIORITIES: [&str; 2] = ["default", "option"];
pub const FILE_KINDS_MAX: usize = 16;
pub const FILE_KIND_SELECTORS_MAX: usize = 32;
pub const FILE_KIND_PATTERNS_MAX: usize = 64;
pub const FILE_KIND_DISPLAY_NAME_MAX: usize = 60;
pub static FILE_KIND_NAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z][a-z0-9-]{0,39}$"));
pub const FILE_CONTENTS_CAPABILITY: Capability = Capability::FileContents;
pub static FILENAME_PATTERN_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(
        r"^(?:\*\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}|[A-Za-z0-9._-][A-Za-z0-9._ -]{0,126}[A-Za-z0-9._-]?)$",
    )
});

pub const VIEWER_SCHEME: &str = "ostia-viewer";
pub const OWN_VIEW: &str = "default";
pub static FILE_KIND_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z0-9][a-z0-9-]*\.[a-z][a-z0-9-]{0,39}$"));
pub const VIEWER_DOCUMENT_PATH: &str = "/~document";
pub const VIEWER_META_PATH: &str = "/~meta";
pub const VIEWER_EVENTS_PATH: &str = "/~events";
pub const VIEWER_PORTABLE_PATH: &str = "/~portable";
pub const VIEWER_CHANGED_EVENT: &str = "changed";
pub const VIEWER_APPENDS_QUERY: &str = "appends=1";
pub const VIEWER_SELECTION_CLEARED_EVENT: &str = "selection-cleared";

pub const PORTABLE_TABLES_MAX: usize = 256;
pub const PORTABLE_TABLE_ROWS_MAX: usize = 5_000;
pub const PORTABLE_TABLE_COLUMNS_MAX: usize = 1_000;
pub const PORTABLE_TABLES_BYTES_MAX: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKindViewPriority {
    Default,
    Option,
}

impl FileKindViewPriority {
    pub fn name(self) -> &'static str {
        match self {
            Self::Default => FILE_KIND_VIEW_PRIORITIES[0],
            Self::Option => FILE_KIND_VIEW_PRIORITIES[1],
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "default" => Some(Self::Default),
            "option" => Some(Self::Option),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewerChange {
    Appended,
    Replaced,
}

pub fn viewer_change_of(data: &Value) -> ViewerChange {
    if data.as_str() == Some("appended") {
        ViewerChange::Appended
    } else {
        ViewerChange::Replaced
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileKindSelector {
    pub filename_pattern: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FileKindView {
    pub entry: String,
    pub priority: FileKindViewPriority,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BrowseRole {}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileKindContribution {
    pub id: String,
    pub display_name: String,
    pub selector: Vec<FileKindSelector>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<FileKindView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browse: Option<BrowseRole>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FileKindInfoView {
    pub priority: FileKindViewPriority,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ShadowedKind {
    pub name: String,
    pub patterns: Vec<String>,
}

fn is_false(flag: &bool) -> bool {
    !flag
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileKindInfo {
    pub id: String,
    pub display_name: String,
    pub selector: Vec<FileKindSelector>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<FileKindInfoView>,
    #[serde(skip_serializing_if = "is_false")]
    pub browse: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadowed: Option<Vec<ShadowedKind>>,
    pub approved: bool,
}

#[derive(Clone, Copy)]
pub struct FileKindParseContext<'a> {
    pub is_inside: &'a dyn Fn(&str) -> bool,
    pub main: bool,
    pub capabilities: &'a [Capability],
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerDocumentMeta {
    pub name: String,
    pub size: u64,
    pub modified: serde_json::Number,
    pub locale: String,
    pub view_type: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PortableTable {
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ViewerPortableTables {
    pub tables: Vec<PortableTable>,
}

pub fn is_view_type(value: &str) -> bool {
    value == OWN_VIEW || FILE_KIND_ID_PATTERN.is_match(value)
}

fn parse_selector(raw: Option<&Value>, place: &str) -> Result<Vec<FileKindSelector>, String> {
    let items = raw
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= FILE_KIND_SELECTORS_MAX)
        .ok_or_else(|| {
            format!("{place}.selector must be an array of 1-{FILE_KIND_SELECTORS_MAX} entries")
        })?;
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            item.get("filenamePattern")
                .and_then(Value::as_str)
                .filter(|pattern| FILENAME_PATTERN_PATTERN.is_match(pattern))
                .map(|pattern| FileKindSelector {
                    filename_pattern: pattern.to_owned(),
                })
                .ok_or_else(|| {
                    format!(
                        "{place}.selector[{index}].filenamePattern must be *.<extension> or a file name"
                    )
                })
        })
        .collect()
}

fn parse_view(
    raw: &Value,
    place: &str,
    is_inside: &dyn Fn(&str) -> bool,
) -> Result<FileKindView, String> {
    if !is_record(raw) {
        return Err(format!("{place}.view must be an object"));
    }
    let priority = match raw.get("priority") {
        None => Some(FileKindViewPriority::Default),
        Some(value) => value.as_str().and_then(FileKindViewPriority::parse),
    }
    .ok_or_else(|| {
        format!(
            "{place}.view.priority must be one of {}",
            FILE_KIND_VIEW_PRIORITIES.join(", ")
        )
    })?;
    let entry = raw
        .get("entry")
        .and_then(Value::as_str)
        .filter(|entry| entry.ends_with(".html") && is_inside(entry))
        .ok_or_else(|| format!("{place}.view.entry must be an .html file inside the extension"))?;
    Ok(FileKindView {
        entry: entry.to_owned(),
        priority,
    })
}

fn valid_id<'a>(raw: &'a Value, ext_id: &str) -> Option<&'a str> {
    let id = raw.get("id")?.as_str()?;
    let segments: Vec<&str> = id.split('.').collect();
    let [owner, name] = segments.as_slice() else {
        return None;
    };
    (*owner == ext_id && !name.is_empty() && FILE_KIND_NAME_PATTERN.is_match(name)).then_some(id)
}

fn parse_kind(
    raw: &Value,
    place: &str,
    ext_id: &str,
    context: &FileKindParseContext,
) -> Result<FileKindContribution, String> {
    if !is_record(raw) {
        return Err(format!("{place}: must be an object"));
    }
    let id = valid_id(raw, ext_id)
        .ok_or_else(|| format!("{place}.id must be '{ext_id}.<name>' with a lowercase name"))?;
    let display_name = raw
        .get("displayName")
        .and_then(Value::as_str)
        .filter(|name| !js_trim(name).is_empty() && utf16_len(name) <= FILE_KIND_DISPLAY_NAME_MAX)
        .ok_or_else(|| {
            format!("{place}.displayName must be 1-{FILE_KIND_DISPLAY_NAME_MAX} characters")
        })?;
    let selector = parse_selector(raw.get("selector"), place)?;
    let (view_raw, browse_raw) = (raw.get("view"), raw.get("browse"));
    if view_raw.is_none() && browse_raw.is_none() {
        return Err(format!("{place} needs a view or a browse role"));
    }
    let view = view_raw
        .map(|view| parse_view(view, place, context.is_inside))
        .transpose()?;
    let browse = match browse_raw {
        None => None,
        Some(role) if !is_record(role) => {
            return Err(format!("{place}.browse must be an object"));
        }
        Some(_) if !context.main || !context.capabilities.contains(&FILE_CONTENTS_CAPABILITY) => {
            return Err(format!(
                "{place}.browse needs a main process and the 'file-contents' capability"
            ));
        }
        Some(_) => Some(BrowseRole {}),
    };
    Ok(FileKindContribution {
        id: id.to_owned(),
        display_name: display_name.to_owned(),
        selector,
        view,
        browse,
    })
}

pub fn parse_file_kinds(
    raw: Option<&Value>,
    ext_id: &str,
    context: &FileKindParseContext,
) -> Result<Vec<FileKindContribution>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let items = raw
        .as_array()
        .filter(|items| items.len() <= FILE_KINDS_MAX)
        .ok_or_else(|| {
            format!("contributes.fileKinds must be an array of at most {FILE_KINDS_MAX}")
        })?;
    let mut kinds: Vec<FileKindContribution> = Vec::new();
    let mut patterns = 0;
    for (index, item) in items.iter().enumerate() {
        let place = format!("contributes.fileKinds[{index}]");
        let parsed = parse_kind(item, &place, ext_id, context)?;
        if kinds.iter().any(|kind| kind.id == parsed.id) {
            return Err(format!("{place}: duplicate id '{}'", parsed.id));
        }
        patterns += parsed.selector.len();
        kinds.push(parsed);
    }
    if patterns > FILE_KIND_PATTERNS_MAX {
        return Err(format!(
            "contributes.fileKinds may have at most {FILE_KIND_PATTERNS_MAX} filename patterns in all"
        ));
    }
    Ok(kinds)
}

fn base_name(path: &str) -> &str {
    path.rfind(['/', '\\']).map_or(path, |at| &path[at + 1..])
}

pub fn matches_filename_pattern(path: &str, pattern: &str) -> bool {
    let name = base_name(path).to_lowercase();
    let wanted = pattern.to_lowercase();
    if !wanted.starts_with("*.") {
        return name == wanted;
    }
    let suffix = &wanted[1..];
    utf16_len(&name) > utf16_len(suffix) && name.ends_with(suffix)
}

pub fn kind_matches(path: &str, selector: &[FileKindSelector]) -> bool {
    selector
        .iter()
        .any(|item| matches_filename_pattern(path, &item.filename_pattern))
}

#[derive(Clone, Debug, PartialEq)]
pub struct KindRoles {
    pub id: String,
    pub selector: Vec<FileKindSelector>,
    pub view: Option<FileKindViewPriority>,
    pub browse: bool,
}

pub fn kind_claim(kind: &KindRoles) -> String {
    let mut patterns: Vec<String> = kind
        .selector
        .iter()
        .map(|item| item.filename_pattern.to_lowercase())
        .collect();
    patterns.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    patterns.dedup();
    let mut roles: Vec<String> = Vec::new();
    if let Some(priority) = kind.view {
        roles.push(format!("view:{}", priority.name()));
    }
    if kind.browse {
        roles.push("browse".to_owned());
    }
    format!("{}:{}:{}", kind.id, roles.join("+"), patterns.join(","))
}

#[derive(Clone, Debug, PartialEq)]
pub struct BrowseKind {
    pub id: String,
    pub selector: Vec<FileKindSelector>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BrowseCandidate {
    pub ext_id: String,
    pub builtin: bool,
    pub kind: BrowseKind,
}

fn longest_match(path: &str, selector: &[FileKindSelector]) -> Option<usize> {
    selector
        .iter()
        .filter(|item| matches_filename_pattern(path, &item.filename_pattern))
        .map(|item| utf16_len(&item.filename_pattern))
        .max()
}

fn outranks(
    candidate: &BrowseCandidate,
    length: usize,
    current: &BrowseCandidate,
    longest: usize,
) -> bool {
    if candidate.builtin != current.builtin {
        return candidate.builtin;
    }
    length > longest
        || (length == longest
            && candidate
                .ext_id
                .encode_utf16()
                .lt(current.ext_id.encode_utf16()))
}

pub fn browse_kind_for<'a>(
    path: &str,
    candidates: &[&'a BrowseCandidate],
) -> Option<&'a BrowseCandidate> {
    let mut best: Option<(&'a BrowseCandidate, usize)> = None;
    for candidate in candidates.iter().copied() {
        let Some(length) = longest_match(path, &candidate.kind.selector) else {
            continue;
        };
        let better =
            best.is_none_or(|(current, longest)| outranks(candidate, length, current, longest));
        if better {
            best = Some((candidate, length));
        }
    }
    best.map(|(candidate, _)| candidate)
}
