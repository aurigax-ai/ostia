#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::files_api::FsEntry;
use ostia_model::files::file_tree::{
    COMPACT_MAX_DEPTH, base_name, child_path, compact_chain, exclude_matcher, is_under_excluded,
    nest_entries, nesting_rules, parent_of, path_in_tree, relative_to_root, sort_entries,
    split_path,
};
use ostia_model::settings::file_tree_settings::{
    FileSortBy, FileSortOrder, default_nesting_patterns,
};
use serde_json::{Map, Value};

fn file(name: &str) -> FsEntry {
    FsEntry {
        name: name.to_owned(),
        dir: false,
        archive: false,
        link: None,
        encrypted: false,
    }
}

fn dir(name: &str) -> FsEntry {
    FsEntry {
        dir: true,
        ..file(name)
    }
}

fn names(entries: &[FsEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.name.as_str()).collect()
}

fn patterns(pairs: &[(&str, &str)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), Value::String((*value).to_owned())))
        .collect()
}

fn nest(list: &[FsEntry], pairs: &[(&str, &str)]) -> Vec<(String, Vec<String>)> {
    nest_with(list, &patterns(pairs))
}

fn nest_with(list: &[FsEntry], map: &Map<String, Value>) -> Vec<(String, Vec<String>)> {
    nest_entries(list, &nesting_rules(map))
        .into_iter()
        .map(|item| {
            (
                item.entry.name,
                item.nested.into_iter().map(|e| e.name).collect(),
            )
        })
        .collect()
}

fn expected(rows: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
    rows.iter()
        .map(|(parent, children)| {
            (
                (*parent).to_owned(),
                children.iter().map(|c| (*c).to_owned()).collect(),
            )
        })
        .collect()
}

#[test]
fn splits_a_path_into_its_name_and_folder() {
    let deep = split_path("src/deep/a.ts");
    assert_eq!(deep.name, "a.ts");
    assert_eq!(deep.dir, "src/deep");
    let bare = split_path("a.ts");
    assert_eq!(bare.name, "a.ts");
    assert_eq!(bare.dir, "");
}

#[test]
fn names_the_last_segment_and_the_parent_folder() {
    assert_eq!(base_name("/p/src/a.ts"), "a.ts");
    assert_eq!(base_name("/p/src/"), "/p/src/");
    assert_eq!(parent_of("/p/src/a.ts"), "/p/src");
    assert_eq!(parent_of("/a.ts"), "/");
}

#[test]
fn joins_a_child_onto_a_path_with_or_without_a_trailing_slash() {
    assert_eq!(child_path("/p", "a.ts"), "/p/a.ts");
    assert_eq!(child_path("/p/", "a.ts"), "/p/a.ts");
    assert_eq!(child_path("/", "a.ts"), "/a.ts");
}

#[test]
fn strips_the_root_prefix_and_returns_none_outside_it() {
    assert_eq!(relative_to_root("/p/src/a.ts", "/p"), Some("src/a.ts"));
    assert_eq!(relative_to_root("/p/src/a.ts", "/p/"), Some("src/a.ts"));
    assert_eq!(relative_to_root("/px/a.ts", "/p"), None);
}

#[test]
fn matches_double_star_name_at_any_depth_including_the_root_level() {
    let hidden = exclude_matcher(&["**/node_modules", "**/.git"]);
    assert!(hidden.is_excluded("/p/node_modules", "/p"));
    assert!(hidden.is_excluded("/p/pkg/a/node_modules", "/p"));
    assert!(hidden.is_excluded("/p/.git", "/p"));
    assert!(!hidden.is_excluded("/p/.github", "/p"));
    assert!(!hidden.is_excluded("/p/src", "/p"));
}

#[test]
fn matches_a_bare_pattern_only_relative_to_the_tree_root_like_vs_code() {
    let hidden = exclude_matcher(&["dist"]);
    assert!(hidden.is_excluded("/p/dist", "/p"));
    assert!(!hidden.is_excluded("/p/pkg/dist", "/p"));
}

#[test]
fn matches_dotfiles_with_double_star_dot_star_and_absolute_paths_literally() {
    let hidden = exclude_matcher(&["**/.*", "/p/src/generated"]);
    assert!(hidden.is_excluded("/p/.env", "/p"));
    assert!(hidden.is_excluded("/p/src/.eslintrc", "/p"));
    assert!(hidden.is_excluded("/p/src/generated", "/p"));
    assert!(!hidden.is_excluded("/q/src/generated", "/q"));
    assert!(!hidden.is_excluded("/p/src/index.ts", "/p"));
}

#[test]
fn supports_star_question_mark_and_braces_and_ignores_blank_patterns() {
    let hidden = exclude_matcher(&["", "**/*.{log,tmp}", "**/cache?"]);
    assert!(hidden.is_excluded("/p/a/debug.log", "/p"));
    assert!(hidden.is_excluded("/p/x.tmp", "/p"));
    assert!(hidden.is_excluded("/p/cache1", "/p"));
    assert!(!hidden.is_excluded("/p/cache12", "/p"));
    assert!(!hidden.is_excluded("/p/a.ts", "/p"));
}

#[test]
fn never_matches_with_no_patterns() {
    let none: [&str; 0] = [];
    assert!(!exclude_matcher(&none).is_excluded("/p/.git", "/p"));
}

#[test]
fn ignores_a_trailing_slash_and_whitespace_around_a_pattern() {
    let hidden = exclude_matcher(&["  dist/  ", "///"]);
    assert!(hidden.is_excluded("/p/dist", "/p"));
    assert!(!hidden.is_excluded("/p/src", "/p"));
}

#[test]
fn ignores_a_pattern_that_does_not_compile() {
    let hidden = exclude_matcher(&["[", "**/ok"]);
    assert!(hidden.is_excluded("/p/ok", "/p"));
    assert!(!hidden.is_excluded("/p/src", "/p"));
}

fn sort_entries_fixture() -> Vec<FsEntry> {
    vec![
        file("b.ts"),
        dir("zeta"),
        file("a.md"),
        dir("Alpha"),
        file("c.json"),
        file("file10"),
        file("file2"),
    ]
}

#[test]
fn puts_folders_first_then_sorts_by_name_case_insensitively_and_numerically() {
    let sorted = sort_entries(
        &sort_entries_fixture(),
        FileSortOrder::FoldersFirst,
        FileSortBy::Name,
    );
    assert_eq!(
        names(&sorted),
        ["Alpha", "zeta", "a.md", "b.ts", "c.json", "file2", "file10"]
    );
}

#[test]
fn interleaves_folders_and_files_in_mixed_order() {
    let sorted = sort_entries(
        &sort_entries_fixture(),
        FileSortOrder::Mixed,
        FileSortBy::Name,
    );
    assert_eq!(
        names(&sorted),
        ["a.md", "Alpha", "b.ts", "c.json", "file2", "file10", "zeta"]
    );
}

#[test]
fn sorts_files_by_extension_then_name_when_sorting_by_type() {
    let sorted = sort_entries(
        &sort_entries_fixture(),
        FileSortOrder::FoldersFirst,
        FileSortBy::Type,
    );
    assert_eq!(
        names(&sorted),
        ["Alpha", "zeta", "file2", "file10", "c.json", "a.md", "b.ts"]
    );
}

#[test]
fn does_not_mutate_its_input() {
    let entries = sort_entries_fixture();
    let copy = entries.clone();
    sort_entries(&entries, FileSortOrder::Mixed, FileSortBy::Type);
    assert_eq!(entries, copy);
}

#[test]
fn breaks_a_tie_between_names_that_differ_only_in_case_by_code_unit_order() {
    let sorted = sort_entries(
        &[file("a"), file("A")],
        FileSortOrder::Mixed,
        FileSortBy::Name,
    );
    assert_eq!(names(&sorted), ["A", "a"]);
}

#[test]
fn treats_a_leading_dot_name_as_having_no_extension_when_sorting_by_type() {
    let sorted = sort_entries(
        &[file("z.md"), file(".env"), file("a.ts")],
        FileSortOrder::Mixed,
        FileSortBy::Type,
    );
    assert_eq!(names(&sorted), [".env", "z.md", "a.ts"]);
}

#[test]
fn nests_exact_name_children_under_an_exact_name_parent() {
    assert_eq!(
        nest(
            &[file("Cargo.lock"), file("Cargo.toml"), file("README.md")],
            &[("Cargo.toml", "Cargo.lock")],
        ),
        expected(&[("Cargo.toml", &["Cargo.lock"]), ("README.md", &[])]),
    );
}

#[test]
fn substitutes_capture_from_the_parent_wildcard() {
    assert_eq!(
        nest(
            &[
                file("a.d.ts"),
                file("a.test.ts"),
                file("a.ts"),
                file("b.test.ts"),
                file("b.ts"),
            ],
            &[("*.ts", "${capture}.test.ts, ${capture}.d.ts")],
        ),
        expected(&[("a.ts", &["a.d.ts", "a.test.ts"]), ("b.ts", &["b.test.ts"]),]),
    );
}

#[test]
fn leaves_a_child_whose_parent_is_missing_at_the_top_level() {
    assert_eq!(
        nest(&[file("orphan.test.ts")], &[("*.ts", "${capture}.test.ts")]),
        expected(&[("orphan.test.ts", &[])]),
    );
}

#[test]
fn supports_star_in_child_patterns_and_basename_and_extname() {
    assert_eq!(
        nest(
            &[
                file("tsconfig.json"),
                file("tsconfig.node.json"),
                file("tsconfig.web.json"),
                file("x.md"),
            ],
            &[("tsconfig.json", "tsconfig.*.json")],
        ),
        expected(&[
            (
                "tsconfig.json",
                &["tsconfig.node.json", "tsconfig.web.json"]
            ),
            ("x.md", &[]),
        ]),
    );
    assert_eq!(
        nest(
            &[file("page.vue"), file("page.vue.css")],
            &[("*.vue", "${basename}.${extname}.css")],
        ),
        expected(&[("page.vue", &["page.vue.css"])]),
    );
}

#[test]
fn matches_names_case_insensitively_and_never_nests_folders() {
    assert_eq!(
        nest(
            &[
                dir("package-lock.json"),
                file("Package.json"),
                file("pnpm-lock.yaml"),
            ],
            &[("package.json", "package-lock.json, pnpm-lock.yaml")],
        ),
        expected(&[
            ("package-lock.json", &[]),
            ("Package.json", &["pnpm-lock.yaml"]),
        ]),
    );
}

#[test]
fn nests_only_one_level_deep_and_never_forms_a_cycle() {
    assert_eq!(
        nest(
            &[file("a.js"), file("a.ts")],
            &[("*.ts", "${capture}.js"), ("*.js", "${capture}.ts")],
        ),
        expected(&[("a.js", &["a.ts"])]),
    );
}

#[test]
fn escapes_regex_characters_in_names_and_captures() {
    assert_eq!(
        nest(
            &[file("a+b.ts"), file("a+b.test.ts"), file("aab.test.ts")],
            &[("*.ts", "${capture}.test.ts")],
        ),
        expected(&[("a+b.ts", &["a+b.test.ts"]), ("aab.test.ts", &[])]),
    );
}

#[test]
fn ignores_parent_keys_with_more_than_one_star() {
    assert_eq!(
        nesting_rules(&patterns(&[("*.*.ts", "x"), ("*.ts", "${capture}.js")])).len(),
        1
    );
}

#[test]
fn ignores_a_blank_parent_key_and_a_rule_without_children() {
    assert_eq!(
        nesting_rules(&patterns(&[
            ("  ", "a"),
            ("*.ts", " , "),
            ("*.js", "${capture}.map")
        ]))
        .len(),
        1
    );
}

#[test]
fn groups_lockfiles_under_package_json_with_the_default_rules() {
    assert_eq!(
        nest_with(
            &[
                file("package.json"),
                file("pnpm-lock.yaml"),
                file("pnpm-workspace.yaml"),
                file("src.ts"),
            ],
            &default_nesting_patterns(),
        ),
        expected(&[
            ("package.json", &["pnpm-lock.yaml", "pnpm-workspace.yaml"]),
            ("src.ts", &[]),
        ]),
    );
}

#[test]
fn returns_every_entry_unnested_when_there_are_no_rules() {
    assert_eq!(
        nest(&[file("a.ts"), file("a.test.ts")], &[]),
        expected(&[("a.ts", &[]), ("a.test.ts", &[])]),
    );
}

fn compact_tree(path: &str) -> Vec<FsEntry> {
    match path {
        "/p/src" => vec![dir("main")],
        "/p/src/main" => vec![dir("java")],
        "/p/src/main/java" => vec![dir("com"), file("App.java")],
        "/p/lib" => vec![dir(".git"), dir("core")],
        "/p/lib/core" => vec![file("x.ts")],
        "/p/one" => vec![file("only.txt")],
        _ => Vec::new(),
    }
}

#[tokio::test]
async fn follows_single_folder_chains_and_returns_the_last_folder_listing() {
    let chain = compact_chain(
        "/p/src",
        async |path: &str| compact_tree(path),
        |entries: Vec<FsEntry>, _path: &str| entries,
        COMPACT_MAX_DEPTH,
    )
    .await;
    assert_eq!(chain.names, ["main", "java"]);
    assert_eq!(chain.path, "/p/src/main/java");
    assert_eq!(names(&chain.entries), ["com", "App.java"]);
}

#[tokio::test]
async fn stops_at_a_folder_whose_only_child_is_a_file() {
    let chain = compact_chain(
        "/p/one",
        async |path: &str| compact_tree(path),
        |entries: Vec<FsEntry>, _path: &str| entries,
        COMPACT_MAX_DEPTH,
    )
    .await;
    assert!(chain.names.is_empty());
    assert_eq!(chain.path, "/p/one");
}

#[tokio::test]
async fn counts_only_visible_children_so_a_hidden_sibling_does_not_break_the_chain() {
    let hide_git = |entries: Vec<FsEntry>, path: &str| {
        let hidden = exclude_matcher(&["**/.git"]);
        entries
            .into_iter()
            .filter(|e| !hidden.is_excluded(&child_path(path, &e.name), "/p"))
            .collect::<Vec<_>>()
    };
    let chain = compact_chain(
        "/p/lib",
        async |path: &str| compact_tree(path),
        hide_git,
        COMPACT_MAX_DEPTH,
    )
    .await;
    assert_eq!(chain.names, ["core"]);
    assert_eq!(names(&chain.entries), ["x.ts"]);

    let all = compact_chain(
        "/p/lib",
        async |path: &str| compact_tree(path),
        |entries: Vec<FsEntry>, _path: &str| entries,
        COMPACT_MAX_DEPTH,
    )
    .await;
    assert_eq!(names(&all.entries), [".git", "core"]);
}

#[tokio::test]
async fn stops_at_the_depth_limit() {
    let chain = compact_chain(
        "/r",
        async |path: &str| vec![dir(&format!("d{}", path.len()))],
        |entries: Vec<FsEntry>, _path: &str| entries,
        5,
    )
    .await;
    assert_eq!(chain.names.len(), 5);
}

#[test]
fn the_default_depth_limit_is_thirty_two() {
    assert_eq!(COMPACT_MAX_DEPTH, 32);
}

#[test]
fn hides_a_path_when_it_or_a_folder_above_it_inside_the_root_is_excluded() {
    let excluded = exclude_matcher(&["**/dist", "/r/secret.txt"]);
    assert!(is_under_excluded(&excluded, "/r/dist/a/b.js", "/r"));
    assert!(is_under_excluded(&excluded, "/r/dist", "/r"));
    assert!(is_under_excluded(&excluded, "/r/secret.txt", "/r"));
    assert!(!is_under_excluded(&excluded, "/r/src/dist.ts", "/r"));
}

#[test]
fn asks_the_matcher_about_the_whole_path_when_it_is_outside_the_root() {
    let excluded = exclude_matcher(&["/elsewhere/secret.txt"]);
    assert!(is_under_excluded(&excluded, "/elsewhere/secret.txt", "/r"));
    assert!(!is_under_excluded(&excluded, "/elsewhere/open.txt", "/r"));
}

#[test]
fn names_a_path_under_the_root_the_way_the_tree_names_its_rows_whichever_side_uses_tilde() {
    let home = Some("/home/u");
    assert_eq!(
        path_in_tree("/home/u/proj/src", "/home/u/proj", home).as_deref(),
        Some("/home/u/proj/src")
    );
    assert_eq!(
        path_in_tree("/home/u/proj/src", "~/proj", home).as_deref(),
        Some("~/proj/src")
    );
    assert_eq!(
        path_in_tree("~/proj/src", "/home/u/proj", home).as_deref(),
        Some("/home/u/proj/src")
    );
    assert_eq!(
        path_in_tree("/home/u/proj", "~/proj", home).as_deref(),
        Some("~/proj")
    );
}

#[test]
fn answers_none_for_a_path_outside_the_root() {
    let home = Some("/home/u");
    assert_eq!(path_in_tree("/home/u/other", "/home/u/proj", home), None);
    assert_eq!(path_in_tree("/home/u/project", "/home/u/proj", home), None);
    assert_eq!(path_in_tree("/tmp/x", "~", home), None);
    assert_eq!(path_in_tree("/home/u/proj/src", "~/proj", None), None);
}

#[test]
fn expands_a_lone_tilde_and_leaves_a_tilde_name_alone() {
    let home = Some("/home/u");
    assert_eq!(
        path_in_tree("~", "/home/u", home).as_deref(),
        Some("/home/u")
    );
    assert_eq!(
        path_in_tree("/home/u/~x/a", "/home/u", home).as_deref(),
        Some("/home/u/~x/a")
    );
}
