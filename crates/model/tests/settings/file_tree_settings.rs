#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::settings::file_tree_settings::{
    EXCLUDE_MAX, FileTreeSettings, NESTING_MAX, PATTERN_MAX_LENGTH, VIEWER_ASSOCIATIONS_MAX,
    default_nesting_patterns, parse_file_tree_settings,
};
use serde_json::{Value, json};

fn parsed(raw: Value) -> Value {
    serde_json::to_value(parse_file_tree_settings(&raw)).unwrap()
}

fn defaults() -> Value {
    serde_json::to_value(FileTreeSettings::default()).unwrap()
}

#[test]
fn returns_the_defaults_when_files_is_missing_or_not_an_object() {
    assert_eq!(parsed(Value::Null), defaults());
    assert_eq!(parsed(json!([])), defaults());
}

#[test]
fn hides_vcs_folders_and_os_litter_by_default_compacts_folders_and_nests_files() {
    let settings = FileTreeSettings::default();
    assert!(settings.exclude.iter().any(|p| p == "**/.git"));
    assert!(settings.exclude.iter().any(|p| p == "**/.DS_Store"));
    assert!(settings.compact_folders);
    assert!(settings.nesting.enabled);
    let patterns = default_nesting_patterns();
    assert!(
        patterns["package.json"]
            .as_str()
            .unwrap()
            .contains("pnpm-lock.yaml")
    );
    assert_eq!(patterns["Cargo.toml"], json!("Cargo.lock"));
}

#[test]
fn trims_dedupes_and_caps_exclude_patterns_and_drops_non_strings() {
    let parsed_value = parsed(json!({
        "exclude": [" **/dist ", "**/dist", 7, "", "**/.*"]
    }));
    assert_eq!(parsed_value["exclude"], json!(["**/dist", "**/.*"]));
    let many: Vec<String> = (0..500).map(|i| format!("p{i}")).collect();
    let capped = parse_file_tree_settings(&json!({ "exclude": many }));
    assert_eq!(capped.exclude.len(), EXCLUDE_MAX);
}

#[test]
fn keeps_an_empty_exclude_list_the_user_chose() {
    assert_eq!(parsed(json!({ "exclude": [] }))["exclude"], json!([]));
}

#[test]
fn replaces_the_default_nesting_patterns_with_the_user_map_dropping_non_string_values() {
    let value = parsed(json!({
        "nesting": { "enabled": false, "patterns": { "*.go": "${capture}_test.go", "bad": 3 } }
    }));
    assert_eq!(
        value["nesting"],
        json!({ "enabled": false, "patterns": { "*.go": "${capture}_test.go" } })
    );
}

#[test]
fn falls_back_to_the_default_sort_and_icon_theme_for_unknown_values() {
    let value = parsed(json!({ "sortOrder": "weird", "sortBy": "size", "iconTheme": "../x" }));
    assert_eq!(value["sortOrder"], json!("foldersFirst"));
    assert_eq!(value["sortBy"], json!("name"));
    assert_eq!(value["iconTheme"], json!("ostia"));
    assert_eq!(
        parsed(json!({ "iconTheme": "ostia" }))["iconTheme"],
        json!("ostia")
    );
    assert_eq!(
        parsed(json!({ "iconTheme": "material-icon-theme" }))["iconTheme"],
        json!("material-icon-theme")
    );
}

#[test]
fn writes_the_defaults_in_the_ts_field_order() {
    let keys: Vec<String> = defaults().as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "exclude",
            "showExcluded",
            "searchIgnored",
            "compactFolders",
            "nesting",
            "sortOrder",
            "sortBy",
            "breadcrumb",
            "iconTheme",
            "viewerAssociations"
        ]
    );
}

#[test]
fn has_the_default_values_for_every_field() {
    assert_eq!(
        defaults(),
        json!({
            "exclude": ["**/.git", "**/.hg", "**/.svn", "**/.DS_Store", "**/Thumbs.db"],
            "showExcluded": false,
            "searchIgnored": false,
            "compactFolders": true,
            "nesting": { "enabled": true, "patterns": default_nesting_patterns() },
            "sortOrder": "foldersFirst",
            "sortBy": "name",
            "breadcrumb": "auto",
            "iconTheme": "ostia",
            "viewerAssociations": {}
        })
    );
}

#[test]
fn lists_the_default_nesting_patterns_in_the_ts_order() {
    let patterns = default_nesting_patterns();
    let keys: Vec<&str> = patterns.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "package.json",
            "Cargo.toml",
            "go.mod",
            "pyproject.toml",
            "tsconfig.json",
            "*.ts",
            "*.tsx",
            "*.js",
            ".gitignore"
        ]
    );
    assert_eq!(patterns["go.mod"], json!("go.sum, go.work, go.work.sum"));
    assert_eq!(
        patterns["*.ts"],
        json!("${capture}.test.ts, ${capture}.spec.ts, ${capture}.d.ts, ${capture}.js")
    );
    assert_eq!(patterns[".gitignore"], json!(".gitattributes, .gitmodules"));
}

#[test]
fn keeps_a_boolean_and_falls_back_for_a_value_of_another_type() {
    let value = parsed(json!({
        "showExcluded": true,
        "searchIgnored": "yes",
        "compactFolders": 0
    }));
    assert_eq!(value["showExcluded"], json!(true));
    assert_eq!(value["searchIgnored"], json!(false));
    assert_eq!(value["compactFolders"], json!(true));
    assert_eq!(
        parsed(json!({ "compactFolders": false }))["compactFolders"],
        json!(false)
    );
}

#[test]
fn accepts_every_sort_order_sort_by_and_breadcrumb_value() {
    for order in ["foldersFirst", "mixed"] {
        assert_eq!(
            parsed(json!({ "sortOrder": order }))["sortOrder"],
            json!(order)
        );
    }
    for by in ["name", "type"] {
        assert_eq!(parsed(json!({ "sortBy": by }))["sortBy"], json!(by));
    }
    for style in ["auto", "full", "short"] {
        assert_eq!(
            parsed(json!({ "breadcrumb": style }))["breadcrumb"],
            json!(style)
        );
    }
    assert_eq!(
        parsed(json!({ "breadcrumb": "long" }))["breadcrumb"],
        json!("auto")
    );
    assert_eq!(
        parsed(json!({ "sortOrder": 1 }))["sortOrder"],
        json!("foldersFirst")
    );
}

#[test]
fn falls_back_to_the_default_exclude_list_when_exclude_is_not_an_array() {
    for (row, raw) in [
        ("string", json!("**/dist")),
        ("null", json!(null)),
        ("object", json!({})),
    ] {
        assert_eq!(
            parsed(json!({ "exclude": raw }))["exclude"],
            defaults()["exclude"],
            "row {row}"
        );
    }
}

#[test]
fn drops_an_exclude_pattern_that_is_blank_or_longer_than_the_limit() {
    assert_eq!(PATTERN_MAX_LENGTH, 500);
    let longest = "a".repeat(500);
    let too_long = "a".repeat(501);
    let value = parsed(json!({ "exclude": ["   ", too_long, longest, "\t**/x\n"] }));
    assert_eq!(value["exclude"], json!([longest, "**/x"]));
}

#[test]
fn stops_collecting_exclude_patterns_at_the_cap_after_skipping_bad_entries() {
    let mut entries: Vec<Value> = vec![json!(1), json!("")];
    entries.extend((0..300).map(|i| json!(format!("p{i}"))));
    let settings = parse_file_tree_settings(&json!({ "exclude": entries }));
    assert_eq!(settings.exclude.len(), EXCLUDE_MAX);
    assert_eq!(settings.exclude[0], "p0");
    assert_eq!(settings.exclude[EXCLUDE_MAX - 1], "p199");
}

#[test]
fn falls_back_to_the_default_nesting_patterns_when_patterns_is_not_an_object() {
    for (row, raw) in [
        ("missing", json!({ "enabled": false })),
        ("array", json!({ "patterns": [] })),
        ("null", json!({ "patterns": null })),
    ] {
        assert_eq!(
            parsed(json!({ "nesting": raw }))["nesting"]["patterns"],
            Value::Object(default_nesting_patterns()),
            "row {row}"
        );
    }
}

#[test]
fn keeps_an_empty_nesting_map_the_user_chose() {
    assert_eq!(
        parsed(json!({ "nesting": { "patterns": {} } }))["nesting"]["patterns"],
        json!({})
    );
}

#[test]
fn reads_nesting_enabled_even_when_nesting_has_other_noise() {
    assert_eq!(
        parsed(json!({ "nesting": { "enabled": "no" } }))["nesting"]["enabled"],
        json!(true)
    );
    assert_eq!(
        parsed(json!({ "nesting": 5 }))["nesting"]["enabled"],
        json!(true)
    );
    assert_eq!(
        parsed(json!({ "nesting": [] }))["nesting"]["enabled"],
        json!(true)
    );
}

#[test]
fn drops_a_nesting_entry_whose_key_is_not_already_trimmed_or_whose_value_is_blank() {
    let value = parsed(json!({
        "nesting": { "patterns": {
            " a.ts": "x",
            "b.ts ": "x",
            "c.ts": "  ",
            "d.ts": " y ",
            "e.ts": ""
        } }
    }));
    assert_eq!(value["nesting"]["patterns"], json!({ "d.ts": "y" }));
}

#[test]
fn caps_the_nesting_map_at_one_hundred_entries() {
    assert_eq!(NESTING_MAX, 100);
    let map: serde_json::Map<String, Value> =
        (0..150).map(|i| (format!("k{i}"), json!("v"))).collect();
    let settings = parse_file_tree_settings(&json!({ "nesting": { "patterns": map } }));
    assert_eq!(settings.nesting.patterns.len(), NESTING_MAX);
}

#[test]
fn keeps_viewer_associations_for_a_file_name_pattern_and_a_view_type() {
    let value = parsed(json!({
        "viewerAssociations": {
            "*.md": "default",
            "Makefile": "acme.viewer",
            "notes.txt": "x-y.z"
        }
    }));
    assert_eq!(
        value["viewerAssociations"],
        json!({ "*.md": "default", "Makefile": "acme.viewer", "notes.txt": "x-y.z" })
    );
}

#[test]
fn drops_a_viewer_association_with_a_bad_pattern_or_a_bad_view_type() {
    let value = parsed(json!({
        "viewerAssociations": {
            "*.": "default",
            "**/*.md": "default",
            "a/b": "default",
            "ok.md": "Default",
            "ok2.md": "acme",
            "ok3.md": "acme.Viewer",
            "ok4.md": 3,
            "ok5.md": null,
            "good.md": "acme.viewer"
        }
    }));
    assert_eq!(
        value["viewerAssociations"],
        json!({ "good.md": "acme.viewer" })
    );
}

#[test]
fn falls_back_to_no_viewer_associations_when_the_value_is_not_an_object() {
    for (row, raw) in [
        ("array", json!(["*.md"])),
        ("string", json!("x")),
        ("null", json!(null)),
    ] {
        assert_eq!(
            parsed(json!({ "viewerAssociations": raw }))["viewerAssociations"],
            json!({}),
            "row {row}"
        );
    }
}

#[test]
fn caps_the_viewer_associations_at_one_hundred_entries() {
    assert_eq!(VIEWER_ASSOCIATIONS_MAX, 100);
    let map: serde_json::Map<String, Value> = (0..150)
        .map(|i| (format!("f{i}.md"), json!("default")))
        .collect();
    let settings = parse_file_tree_settings(&json!({ "viewerAssociations": map }));
    assert_eq!(settings.viewer_associations.len(), VIEWER_ASSOCIATIONS_MAX);
}

#[test]
fn accepts_an_icon_theme_id_of_one_to_sixty_four_safe_characters() {
    let longest = format!("a{}", "b".repeat(63));
    let too_long = format!("a{}", "b".repeat(64));
    assert_eq!(
        parsed(json!({ "iconTheme": longest }))["iconTheme"],
        json!(longest)
    );
    assert_eq!(
        parsed(json!({ "iconTheme": too_long }))["iconTheme"],
        json!("ostia")
    );
    for (row, id) in [
        ("empty", json!("")),
        ("leading dot", json!(".x")),
        ("slash", json!("a/b")),
        ("space", json!("a b")),
        ("number", json!(1)),
    ] {
        assert_eq!(
            parsed(json!({ "iconTheme": id }))["iconTheme"],
            json!("ostia"),
            "row {row}"
        );
    }
    assert_eq!(
        parsed(json!({ "iconTheme": "A.b_c-d" }))["iconTheme"],
        json!("A.b_c-d")
    );
}
