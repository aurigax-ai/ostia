use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex, utf16_len};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

pub const DOTFILES_PATTERN: &str = "**/.*";
pub const EXCLUDE_MAX: usize = 200;
pub const PATTERN_MAX_LENGTH: usize = 500;
pub const NESTING_MAX: usize = 100;
pub const VIEWER_ASSOCIATIONS_MAX: usize = 100;
pub const BUILTIN_ICON_THEME: &str = "ostia";

static FILENAME_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(
        r"^(?:\*\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}|[A-Za-z0-9._-][A-Za-z0-9._ -]{0,126}[A-Za-z0-9._-]?)$",
    )
});
static FILE_KIND_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z0-9][a-z0-9-]*\.[a-z][a-z0-9-]{0,39}$"));
static ICON_THEME_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$"));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileSortOrder {
    FoldersFirst,
    Mixed,
}

impl FileSortOrder {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "foldersFirst" => Some(Self::FoldersFirst),
            "mixed" => Some(Self::Mixed),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileSortBy {
    Name,
    Type,
}

impl FileSortBy {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "name" => Some(Self::Name),
            "type" => Some(Self::Type),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BreadcrumbStyle {
    Auto,
    Full,
    Short,
}

impl BreadcrumbStyle {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "full" => Some(Self::Full),
            "short" => Some(Self::Short),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FileNestingSettings {
    pub enabled: bool,
    pub patterns: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeSettings {
    pub exclude: Vec<String>,
    pub show_excluded: bool,
    pub search_ignored: bool,
    pub compact_folders: bool,
    pub nesting: FileNestingSettings,
    pub sort_order: FileSortOrder,
    pub sort_by: FileSortBy,
    pub breadcrumb: BreadcrumbStyle,
    pub icon_theme: String,
    pub viewer_associations: Map<String, Value>,
}

pub fn default_nesting_patterns() -> Map<String, Value> {
    [
        (
            "package.json",
            "package-lock.json, pnpm-lock.yaml, pnpm-workspace.yaml, yarn.lock, bun.lock, bun.lockb, .npmrc",
        ),
        ("Cargo.toml", "Cargo.lock"),
        ("go.mod", "go.sum, go.work, go.work.sum"),
        (
            "pyproject.toml",
            "uv.lock, poetry.lock, setup.cfg, requirements*.txt",
        ),
        ("tsconfig.json", "tsconfig.*.json"),
        (
            "*.ts",
            "${capture}.test.ts, ${capture}.spec.ts, ${capture}.d.ts, ${capture}.js",
        ),
        (
            "*.tsx",
            "${capture}.test.tsx, ${capture}.spec.tsx, ${capture}.module.css, ${capture}.css",
        ),
        (
            "*.js",
            "${capture}.test.js, ${capture}.spec.js, ${capture}.js.map, ${capture}.min.js, ${capture}.d.ts",
        ),
        (".gitignore", ".gitattributes, .gitmodules"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), Value::String(value.to_owned())))
    .collect()
}

fn default_exclude() -> Vec<String> {
    [
        "**/.git",
        "**/.hg",
        "**/.svn",
        "**/.DS_Store",
        "**/Thumbs.db",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

impl Default for FileTreeSettings {
    fn default() -> Self {
        Self {
            exclude: default_exclude(),
            show_excluded: false,
            search_ignored: false,
            compact_folders: true,
            nesting: FileNestingSettings {
                enabled: true,
                patterns: default_nesting_patterns(),
            },
            sort_order: FileSortOrder::FoldersFirst,
            sort_by: FileSortBy::Name,
            breadcrumb: BreadcrumbStyle::Auto,
            icon_theme: BUILTIN_ICON_THEME.to_owned(),
            viewer_associations: Map::new(),
        }
    }
}

fn pattern(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    let trimmed = js_trim(text);
    (!trimmed.is_empty() && utf16_len(text) <= PATTERN_MAX_LENGTH).then_some(trimmed)
}

fn parse_exclude(raw: Option<&Value>) -> Vec<String> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return default_exclude();
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        if let Some(text) = pattern(item)
            && !out.iter().any(|existing| existing == text)
        {
            out.push(text.to_owned());
        }
        if out.len() >= EXCLUDE_MAX {
            break;
        }
    }
    out
}

fn parse_nesting_patterns(raw: Option<&Value>) -> Map<String, Value> {
    let Some(entries) = raw.and_then(Value::as_object) else {
        return default_nesting_patterns();
    };
    let mut out = Map::new();
    for (key, value) in entries {
        if out.len() >= NESTING_MAX {
            break;
        }
        let key_text = Value::String(key.clone());
        if let (Some(k), Some(v)) = (pattern(&key_text), pattern(value))
            && k == key
        {
            out.insert(k.to_owned(), Value::String(v.to_owned()));
        }
    }
    out
}

fn parse_viewer_associations(raw: Option<&Value>) -> Map<String, Value> {
    let Some(entries) = raw.and_then(Value::as_object) else {
        return Map::new();
    };
    let mut out = Map::new();
    for (key, value) in entries {
        if out.len() >= VIEWER_ASSOCIATIONS_MAX {
            break;
        }
        if FILENAME_PATTERN.is_match(key)
            && let Some(view) = value.as_str()
            && (view == "default" || FILE_KIND_ID.is_match(view))
        {
            out.insert(key.clone(), Value::String(view.to_owned()));
        }
    }
    out
}

pub fn parse_file_tree_settings(raw: &Value) -> FileTreeSettings {
    let base = FileTreeSettings::default();
    let Some(record) = raw.as_object() else {
        return base;
    };
    let flag = |name: &str, fallback: bool| {
        record
            .get(name)
            .and_then(Value::as_bool)
            .unwrap_or(fallback)
    };
    let text = |name: &str| record.get(name).and_then(Value::as_str);
    let nesting = record.get("nesting").and_then(Value::as_object);
    FileTreeSettings {
        exclude: parse_exclude(record.get("exclude")),
        show_excluded: flag("showExcluded", base.show_excluded),
        search_ignored: flag("searchIgnored", base.search_ignored),
        compact_folders: flag("compactFolders", base.compact_folders),
        nesting: FileNestingSettings {
            enabled: nesting
                .and_then(|map| map.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(base.nesting.enabled),
            patterns: parse_nesting_patterns(nesting.and_then(|map| map.get("patterns"))),
        },
        sort_order: text("sortOrder")
            .and_then(FileSortOrder::parse)
            .unwrap_or(base.sort_order),
        sort_by: text("sortBy")
            .and_then(FileSortBy::parse)
            .unwrap_or(base.sort_by),
        breadcrumb: text("breadcrumb")
            .and_then(BreadcrumbStyle::parse)
            .unwrap_or(base.breadcrumb),
        icon_theme: text("iconTheme")
            .filter(|id| ICON_THEME_ID.is_match(id))
            .map_or(base.icon_theme, str::to_owned),
        viewer_associations: parse_viewer_associations(record.get("viewerAssociations")),
    }
}
