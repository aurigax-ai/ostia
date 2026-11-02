#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtensionSuggestionRule {
    pub names: &'static [&'static str],
    pub suffixes: &'static [&'static str],
}

pub const EXTENSION_SUGGESTIONS: &[(&str, ExtensionSuggestionRule)] = &[
    (
        "lsp-typescript",
        ExtensionSuggestionRule {
            names: &[],
            suffixes: &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
        },
    ),
    (
        "lsp-pyright",
        ExtensionSuggestionRule {
            names: &[],
            suffixes: &["py", "pyi"],
        },
    ),
    (
        "lsp-rust-analyzer",
        ExtensionSuggestionRule {
            names: &[],
            suffixes: &["rs"],
        },
    ),
    (
        "lsp-gopls",
        ExtensionSuggestionRule {
            names: &["go.mod", "go.work"],
            suffixes: &["go"],
        },
    ),
    (
        "lsp-clangd",
        ExtensionSuggestionRule {
            names: &[],
            suffixes: &["c", "h", "cpp", "cc", "cxx", "hpp", "hh"],
        },
    ),
    (
        "lsp-lua",
        ExtensionSuggestionRule {
            names: &[],
            suffixes: &["lua"],
        },
    ),
    (
        "lsp-yaml",
        ExtensionSuggestionRule {
            names: &[],
            suffixes: &["yaml", "yml"],
        },
    ),
    (
        "lsp-bash",
        ExtensionSuggestionRule {
            names: &[],
            suffixes: &["sh", "bash"],
        },
    ),
    (
        "lsp-marksman",
        ExtensionSuggestionRule {
            names: &[],
            suffixes: &["md"],
        },
    ),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuggestedExtension {
    pub ext_id: String,
    pub files: String,
}

fn file_name(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

fn file_suffix(path: &str) -> Option<String> {
    let name = file_name(path);
    name.rfind('.')
        .filter(|dot| *dot > 0)
        .map(|dot| name[dot + 1..].to_lowercase())
        .filter(|suffix| !suffix.is_empty())
}

pub fn files_label(path: &str) -> String {
    match file_suffix(path) {
        Some(suffix) => format!(".{suffix}"),
        None => file_name(path).to_owned(),
    }
}

pub fn suggested_extension(path: &str) -> Option<SuggestedExtension> {
    suggested_extension_in(path, EXTENSION_SUGGESTIONS)
}

pub fn suggested_extension_in(
    path: &str,
    table: &[(&str, ExtensionSuggestionRule)],
) -> Option<SuggestedExtension> {
    let name = file_name(path);
    if let Some((ext_id, _)) = table.iter().find(|(_, rule)| rule.names.contains(&name)) {
        return Some(SuggestedExtension {
            ext_id: (*ext_id).to_owned(),
            files: name.to_owned(),
        });
    }
    let suffix = file_suffix(path)?;
    table
        .iter()
        .find(|(_, rule)| rule.suffixes.contains(&suffix.as_str()))
        .map(|(ext_id, _)| SuggestedExtension {
            ext_id: (*ext_id).to_owned(),
            files: format!(".{suffix}"),
        })
}
