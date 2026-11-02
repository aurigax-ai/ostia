#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use ostia_contract::extension_suggestions::{
    EXTENSION_SUGGESTIONS, ExtensionSuggestionRule, SuggestedExtension, files_label,
    suggested_extension, suggested_extension_in,
};

fn found(ext_id: &str, files: &str) -> Option<SuggestedExtension> {
    Some(SuggestedExtension {
        ext_id: ext_id.to_owned(),
        files: files.to_owned(),
    })
}

#[test]
fn looks_at_the_whole_file_name_first_then_at_the_suffix() {
    let table = [
        (
            "by-suffix",
            ExtensionSuggestionRule {
                names: &[],
                suffixes: &["mod", "rs"],
            },
        ),
        (
            "by-name",
            ExtensionSuggestionRule {
                names: &["go.mod", "Makefile"],
                suffixes: &[],
            },
        ),
    ];
    assert_eq!(
        suggested_extension_in("/p/go.mod", &table),
        found("by-name", "go.mod")
    );
    assert_eq!(
        suggested_extension_in("/p/other.mod", &table),
        found("by-suffix", ".mod")
    );
    assert_eq!(
        suggested_extension_in("/p/Makefile", &table),
        found("by-name", "Makefile")
    );
    assert_eq!(
        suggested_extension_in("/p/MAIN.RS", &table),
        found("by-suffix", ".rs")
    );
}

#[test]
fn suggests_nothing_for_a_file_no_entry_names() {
    assert_eq!(suggested_extension("/p/notes.txt"), None);
    assert_eq!(suggested_extension("/p/README"), None);
    assert_eq!(suggested_extension("/p/.rs"), None);
    assert_eq!(suggested_extension("/p.rs/file"), None);
}

#[test]
fn suggests_nothing_for_a_file_name_that_ends_in_a_dot() {
    assert_eq!(suggested_extension("/p/a."), None);
    assert_eq!(files_label("/p/a."), "a.");
}

#[test]
fn names_the_published_language_extension_for_the_files_it_serves() {
    let suggested = |name: &str| suggested_extension(&format!("/p/{name}")).map(|s| s.ext_id);
    for (name, expected) in [
        ("a.ts", "lsp-typescript"),
        ("a.jsx", "lsp-typescript"),
        ("a.py", "lsp-pyright"),
        ("a.rs", "lsp-rust-analyzer"),
        ("a.go", "lsp-gopls"),
        ("go.mod", "lsp-gopls"),
        ("a.hpp", "lsp-clangd"),
        ("a.lua", "lsp-lua"),
    ] {
        assert_eq!(suggested(name).as_deref(), Some(expected), "{name}");
    }
}

#[test]
fn labels_the_kind_of_file_a_notice_talks_about() {
    assert_eq!(files_label("/p/a.RS"), ".rs");
    assert_eq!(files_label("/p/Dockerfile"), "Dockerfile");
}

#[test]
fn has_an_entry_for_every_language_server_extension_in_the_source_tree_and_no_other() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/extensions");
    let mut extensions: Vec<String> = fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|id| id.starts_with("lsp-"))
        .collect();
    extensions.sort();
    assert!(!extensions.is_empty());
    let mut ids: Vec<String> = EXTENSION_SUGGESTIONS
        .iter()
        .map(|(ext_id, _)| (*ext_id).to_owned())
        .collect();
    ids.sort();
    assert_eq!(ids, extensions);
}

#[test]
fn names_each_suffix_and_file_name_once() {
    let mut seen = Vec::new();
    for (_, rule) in EXTENSION_SUGGESTIONS {
        seen.extend(rule.names.iter().map(|name| (*name).to_owned()));
        seen.extend(rule.suffixes.iter().map(|suffix| format!(".{suffix}")));
    }
    let unique: HashSet<&String> = seen.iter().collect();
    assert_eq!(unique.len(), seen.len());
    for (ext_id, rule) in EXTENSION_SUGGESTIONS {
        assert!(rule.names.len() + rule.suffixes.len() > 0, "{ext_id}");
        for suffix in rule.suffixes {
            assert!(
                !suffix.is_empty()
                    && suffix
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
                "{ext_id} {suffix}"
            );
        }
    }
}
