#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use ostia_base::host::{Host, Platform};
use ostia_files::ripgrep::ripgrep_path;
use ostia_files::workspace_search::{
    LINE_LIMIT, QUERY_MAX, SearchError, SearchOutcome, SearchRequest, SearchResults,
    WorkspaceSearch, folder_paths, name_hits, parse_search_request,
};
use serde_json::{Value, json};
use tempfile::TempDir;

fn request(root: &str, text: &str) -> SearchRequest {
    SearchRequest {
        root: root.to_owned(),
        text: text.to_owned(),
        regex: false,
        case_sensitive: false,
        whole_word: false,
        include_ignored: false,
        names_only: false,
        lines_only: false,
    }
}

fn raw(root: &str, text: &str, extra: Value) -> Value {
    let mut base = json!({
        "root": root,
        "text": text,
        "regex": false,
        "caseSensitive": false,
        "wholeWord": false,
        "includeIgnored": false,
    });
    if let (Some(map), Some(more)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in more {
            map.insert(key.clone(), value.clone());
        }
    }
    base
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn rg() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let app = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            other => other,
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        let bundled = PathBuf::from(ripgrep_path(&app.to_string_lossy(), platform, arch));
        if bundled.exists() {
            return bundled;
        }
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join("rg"))
            .find(|candidate| candidate.exists())
            .expect("no ripgrep binary: bundled or on PATH")
    })
}

fn host(cwd: &Path) -> Host {
    Host {
        env: BTreeMap::new(),
        home: cwd.join("home"),
        cwd: cwd.to_path_buf(),
        platform: Platform::current(),
    }
}

struct Fixture {
    home: TempDir,
    root: String,
}

impl Fixture {
    fn new() -> Self {
        let home = TempDir::new().unwrap();
        let root = home.path().join("project");
        fs::create_dir_all(root.join("src/notes")).unwrap();
        fs::create_dir(root.join("build")).unwrap();
        fs::write(
            root.join("src/notes/todo.md"),
            "first line\nfind the needle here\n",
        )
        .unwrap();
        fs::write(root.join("build/out.txt"), "needle in a built file\n").unwrap();
        fs::write(root.join(".gitignore"), "build/\n").unwrap();
        fs::write(root.join("src/paper.PDF"), "%PDF-1.4\n").unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        let root = root.to_string_lossy().into_owned();
        Self { home, root }
    }

    fn search(&self) -> WorkspaceSearch {
        WorkspaceSearch::new(
            rg().to_path_buf(),
            vec![self.home.path().to_string_lossy().into_owned()],
            host(self.home.path()),
        )
    }

    fn ask(&self, text: &str, extra: Value) -> Value {
        raw(&self.root, text, extra)
    }
}

fn results(outcome: SearchOutcome) -> SearchResults {
    match outcome {
        SearchOutcome::Ok(results) => results,
        SearchOutcome::Failed { error, message } => panic!("{error:?}: {message}"),
    }
}

fn failed_with(outcome: &SearchOutcome, expected: SearchError) -> bool {
    matches!(outcome, SearchOutcome::Failed { error, .. } if *error == expected)
}

#[test]
fn keeps_only_booleans_that_are_true_and_refuses_an_empty_or_oversized_text() {
    assert_eq!(
        parse_search_request(&json!({"root": "/r", "text": "a", "regex": "yes"})),
        Some(request("/r", "a"))
    );
    assert_eq!(
        parse_search_request(&json!({"root": "/r", "text": "  "})),
        None
    );
    assert_eq!(
        parse_search_request(&json!({"root": "/r", "text": "x".repeat(QUERY_MAX + 1)})),
        None
    );
    assert_eq!(parse_search_request(&json!({"text": "a"})), None);
    assert_eq!(parse_search_request(&Value::Null), None);
}

#[test]
fn carries_names_only_only_when_it_is_true() {
    let names = SearchRequest {
        names_only: true,
        ..request("/r", "a")
    };
    assert_eq!(
        parse_search_request(&json!({"root": "/r", "text": "a", "namesOnly": true})),
        Some(names)
    );
    assert_eq!(
        parse_search_request(&json!({"root": "/r", "text": "a", "namesOnly": "yes"})),
        Some(request("/r", "a"))
    );
}

#[test]
fn carries_lines_only_only_when_it_is_true_and_names_only_is_not() {
    let lines = SearchRequest {
        lines_only: true,
        ..request("/r", "a")
    };
    assert_eq!(
        parse_search_request(&json!({"root": "/r", "text": "a", "linesOnly": true})),
        Some(lines)
    );
    assert_eq!(
        parse_search_request(&json!({"root": "/r", "text": "a", "linesOnly": 1})),
        Some(request("/r", "a"))
    );
    let names = SearchRequest {
        names_only: true,
        ..request("/r", "a")
    };
    assert_eq!(
        parse_search_request(
            &json!({"root": "/r", "text": "a", "linesOnly": true, "namesOnly": true})
        ),
        Some(names)
    );
}

#[test]
fn refuses_an_empty_root_and_a_root_or_text_that_is_not_a_string() {
    for bad in [
        json!({"root": "", "text": "a"}),
        json!({"root": 5, "text": "a"}),
        json!({"root": "/r", "text": 5}),
        json!({"root": "/r"}),
        json!("/r"),
        json!(["/r", "a"]),
    ] {
        assert_eq!(parse_search_request(&bad), None, "{bad}");
    }
}

#[test]
fn trims_the_text_as_javascript_does_and_counts_its_length_in_utf_16_units() {
    for (text, expected) in [
        ("\u{feff}\u{a0}\u{2028} \t", false),
        ("\u{85}", true),
        ("\u{200b}", true),
    ] {
        assert_eq!(
            parse_search_request(&json!({"root": "/r", "text": text})).is_some(),
            expected,
            "{text:?}"
        );
    }
    let fits = "😀".repeat(QUERY_MAX / 2);
    let over = "😀".repeat(QUERY_MAX / 2 + 1);
    assert!(parse_search_request(&json!({"root": "/r", "text": fits})).is_some());
    assert!(parse_search_request(&json!({"root": "/r", "text": over})).is_none());
}

#[test]
fn lists_every_folder_that_holds_a_file_once() {
    let mut folders = folder_paths(&strings(&["src/main/a.ts", "src/main/b.ts", "README.md"]));
    folders.sort();
    assert_eq!(folders, ["src", "src/main"]);
}

#[test]
fn ignores_a_leading_slash_and_a_file_at_the_top_when_listing_folders() {
    assert!(folder_paths(&strings(&["/a.ts", "b.ts"])).is_empty());
    assert!(folder_paths(&[]).is_empty());
}

#[test]
fn matches_files_and_folders_by_name() {
    let files = strings(&[
        "src/main/search.ts",
        "src/renderer/Search.tsx",
        "docs/readme.md",
    ]);
    let hits = name_hits("main", &files, 10, false);
    assert_eq!(hits[0].path, "src/main");
    assert!(hits[0].dir);
    assert!(
        hits.iter()
            .any(|hit| hit.path == "src/main/search.ts" && !hit.dir)
    );
}

#[test]
fn matches_only_folders_when_the_query_ends_in_a_slash() {
    let files = strings(&[
        "src/main/search.ts",
        "src/renderer/Search.tsx",
        "docs/readme.md",
    ]);
    let hits = name_hits("src/", &files, 10, false);
    assert!(!hits.is_empty());
    assert!(hits.iter().all(|hit| hit.dir));
}

#[test]
fn stops_at_the_limit() {
    let files = strings(&[
        "src/main/search.ts",
        "src/renderer/Search.tsx",
        "docs/readme.md",
    ]);
    assert_eq!(name_hits("s", &files, 2, false).len(), 2);
}

#[test]
fn returns_files_only_and_treats_a_trailing_slash_as_part_of_the_query_when_asked_for_files_only() {
    let files = strings(&[
        "src/main/search.ts",
        "src/renderer/Search.tsx",
        "docs/readme.md",
    ]);
    let paths: Vec<String> = name_hits("main", &files, 10, true)
        .into_iter()
        .map(|hit| hit.path)
        .collect();
    assert_eq!(paths, ["src/main/search.ts"]);
    let slash = name_hits("src/", &files, 10, true);
    assert!(slash.iter().all(|hit| !hit.dir));
    assert!(!slash.is_empty());
}

#[test]
fn gives_no_hits_for_a_query_that_is_only_slashes_or_blank() {
    let files = strings(&["src/main/search.ts"]);
    assert!(name_hits("/", &files, 10, false).is_empty());
    assert!(name_hits("///", &files, 10, false).is_empty());
    assert!(name_hits("  ", &files, 10, false).is_empty());
}

#[test]
fn ranks_a_higher_score_first_and_a_shorter_path_first_on_equal_scores() {
    let files = strings(&["a/b/target.rs", "target.rs", "x/target.rs"]);
    let hits = name_hits("target.rs", &files, 10, true);
    assert_eq!(hits[0].path, "target.rs");
    let lengths: Vec<usize> = hits.iter().map(|hit| hit.path.len()).collect();
    let mut sorted = lengths.clone();
    sorted.sort_unstable();
    assert_eq!(lengths, sorted);
}

#[tokio::test]
async fn finds_folder_names_file_names_and_text_in_one_run() {
    let fx = Fixture::new();
    let search = fx.search();
    let res = results(search.run(1, &fx.ask("notes", json!({}))).await);
    assert_eq!(res.root, fx.root);
    assert_eq!(res.names[0].path, "src/notes");
    assert!(res.names[0].dir);

    let text = results(search.run(1, &fx.ask("needle", json!({}))).await);
    assert_eq!(text.files.len(), 1);
    assert_eq!(text.files[0].path, "src/notes/todo.md");
    assert_eq!(text.files[0].matches.len(), 1);
    let hit = &text.files[0].matches[0];
    assert_eq!(hit.line, 2);
    assert_eq!(hit.column, 10);
    assert_eq!(hit.text, "find the needle here");
    assert_eq!(hit.ranges, [(9, 15)]);
}

#[tokio::test]
async fn the_files_panel_searches_folder_names_file_names_and_text_with_the_bundled_ripgrep() {
    let fx = Fixture::new();
    let search = fx.search();
    let text = results(search.run(1, &fx.ask("needle", json!({}))).await);
    let pairs: Vec<(String, Vec<String>)> = text
        .files
        .iter()
        .map(|file| {
            (
                file.path.clone(),
                file.matches.iter().map(|m| m.text.clone()).collect(),
            )
        })
        .collect();
    assert_eq!(
        pairs,
        [(
            "src/notes/todo.md".to_owned(),
            vec!["find the needle here".to_owned()]
        )]
    );

    let folders = results(search.run(1, &fx.ask("notes/", json!({}))).await);
    let names: Vec<(String, bool)> = folders
        .names
        .iter()
        .map(|name| (name.path.clone(), name.dir))
        .collect();
    assert_eq!(names, [("src/notes".to_owned(), true)]);
}

#[tokio::test]
async fn lists_the_pdfs_under_the_folder_with_their_size_and_time() {
    let fx = Fixture::new();
    let res = results(fx.search().run(1, &fx.ask("paper", json!({}))).await);
    assert_eq!(res.pdfs.len(), 1);
    assert_eq!(res.pdfs[0].path, "src/paper.PDF");
    assert_eq!(res.pdfs[0].size, 9);
    assert!(res.pdfs[0].mtime_ms > 0.0);
}

#[tokio::test]
async fn searches_gitignored_files_only_when_asked() {
    let fx = Fixture::new();
    let search = fx.search();
    let res = results(
        search
            .run(1, &fx.ask("needle", json!({"includeIgnored": true})))
            .await,
    );
    let paths: Vec<&str> = res.files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(paths, ["build/out.txt", "src/notes/todo.md"]);
    let plain = results(search.run(1, &fx.ask("needle", json!({}))).await);
    assert_eq!(plain.files.len(), 1);
}

#[tokio::test]
async fn lists_only_matching_file_names_with_no_folders_and_no_text_search_when_names_only_is_set()
{
    let fx = Fixture::new();
    let search = fx.search();
    let res = results(
        search
            .run(1, &fx.ask("notes", json!({"namesOnly": true})))
            .await,
    );
    let paths: Vec<&str> = res.names.iter().map(|name| name.path.as_str()).collect();
    assert_eq!(paths, ["src/notes/todo.md"]);
    assert!(res.names.iter().all(|name| !name.dir));
    assert!(res.files.is_empty());
    assert!(res.pdfs.is_empty());

    let body = results(
        search
            .run(1, &fx.ask("needle", json!({"namesOnly": true})))
            .await,
    );
    assert!(body.names.is_empty());
    assert!(body.files.is_empty());
}

#[tokio::test]
async fn cancels_an_earlier_names_only_search_when_the_caller_starts_another() {
    let fx = Fixture::new();
    let search = fx.search();
    let first = search.run(9, &fx.ask("todo", json!({"namesOnly": true})));
    let second = search.run(9, &fx.ask("paper", json!({"namesOnly": true})));
    assert!(failed_with(&first.await, SearchError::Cancelled));
    assert!(matches!(second.await, SearchOutcome::Ok(_)));
}

#[tokio::test]
async fn keeps_a_callers_full_search_running_while_it_searches_names_only() {
    let fx = Fixture::new();
    let search = fx.search();
    let full = search.run(8, &fx.ask("needle", json!({})));
    let names = search.run(8, &fx.ask("paper", json!({"namesOnly": true})));
    assert!(matches!(full.await, SearchOutcome::Ok(_)));
    assert!(matches!(names.await, SearchOutcome::Ok(_)));
}

#[tokio::test]
async fn lists_only_matching_text_lines_with_no_names_and_no_pdfs_when_lines_only_is_set() {
    let fx = Fixture::new();
    let res = results(
        fx.search()
            .run(1, &fx.ask("needle", json!({"linesOnly": true})))
            .await,
    );
    assert_eq!(res.files.len(), 1);
    assert_eq!(res.files[0].path, "src/notes/todo.md");
    assert_eq!(res.files[0].matches.len(), 1);
    assert_eq!(res.files[0].matches[0].line, 2);
    assert_eq!(res.files[0].matches[0].text, "find the needle here");
    assert!(res.names.is_empty());
    assert!(res.pdfs.is_empty());
    assert!(!res.truncated);
}

#[tokio::test]
async fn stops_a_lines_only_search_at_its_limit_and_says_it_was_cut() {
    let fx = Fixture::new();
    let many = fx.home.path().join("many");
    fs::create_dir(&many).unwrap();
    fs::write(many.join("log.txt"), "needle\n".repeat(LINE_LIMIT * 3)).unwrap();
    let ask = raw(
        &many.to_string_lossy(),
        "needle",
        json!({"linesOnly": true}),
    );
    let res = results(fx.search().run(1, &ask).await);
    assert_eq!(res.matches, LINE_LIMIT);
    assert_eq!(res.files[0].matches.len(), LINE_LIMIT);
    assert!(res.truncated);
}

#[tokio::test]
async fn cancels_an_earlier_lines_only_search_when_the_caller_starts_another_and_leaves_its_full_and_names_searches_running()
 {
    let fx = Fixture::new();
    let search = fx.search();
    let full = search.run(6, &fx.ask("needle", json!({})));
    let names = search.run(6, &fx.ask("paper", json!({"namesOnly": true})));
    let first = search.run(6, &fx.ask("needle", json!({"linesOnly": true})));
    let second = search.run(6, &fx.ask("first", json!({"linesOnly": true})));
    assert!(failed_with(&first.await, SearchError::Cancelled));
    assert!(matches!(second.await, SearchOutcome::Ok(_)));
    assert!(matches!(full.await, SearchOutcome::Ok(_)));
    assert!(matches!(names.await, SearchOutcome::Ok(_)));
}

#[tokio::test]
async fn refuses_a_folder_outside_the_allowed_roots() {
    let fx = Fixture::new();
    let search = WorkspaceSearch::new(
        rg().to_path_buf(),
        vec![fx.root.clone()],
        host(fx.home.path()),
    );
    let ask = raw(&fx.home.path().to_string_lossy(), "needle", json!({}));
    assert!(failed_with(
        &search.run(1, &ask).await,
        SearchError::OutsideRoots
    ));
}

#[tokio::test]
async fn reports_an_invalid_regex() {
    let fx = Fixture::new();
    let outcome = fx
        .search()
        .run(1, &fx.ask("bad(", json!({"regex": true})))
        .await;
    assert!(failed_with(&outcome, SearchError::InvalidPattern));
}

#[tokio::test]
async fn cancels_a_callers_earlier_search_when_it_starts_a_new_one() {
    let fx = Fixture::new();
    let search = fx.search();
    let first = search.run(7, &fx.ask("needle", json!({})));
    let second = search.run(7, &fx.ask("line", json!({})));
    assert!(failed_with(&first.await, SearchError::Cancelled));
    assert!(matches!(second.await, SearchOutcome::Ok(_)));
}

#[tokio::test]
async fn refuses_an_invalid_request_with_the_failed_code_and_the_invalid_search_message() {
    let fx = Fixture::new();
    let search = fx.search();
    for bad in [
        Value::Null,
        json!({"root": fx.root}),
        fx.ask("  ", json!({})),
    ] {
        match search.run(1, &bad).await {
            SearchOutcome::Failed { error, message } => {
                assert_eq!(error, SearchError::Failed, "{bad}");
                assert_eq!(message, "invalid search", "{bad}");
            }
            other => panic!("{other:?}"),
        }
    }
}

#[tokio::test]
async fn refuses_a_root_that_is_a_file_or_missing_inside_the_allowed_roots() {
    let fx = Fixture::new();
    let search = fx.search();
    let file = format!("{}/.gitignore", fx.root);
    let missing = format!("{}/nope", fx.root);
    for root in [file, missing] {
        let outcome = search.run(1, &raw(&root, "needle", json!({}))).await;
        match outcome {
            SearchOutcome::Failed { error, message } => {
                assert_eq!(error, SearchError::OutsideRoots, "{root}");
                assert_eq!(message, "", "{root}");
            }
            other => panic!("{other:?}"),
        }
    }
}

#[tokio::test]
async fn gives_each_caller_its_own_slots_so_another_caller_does_not_cancel_a_search() {
    let fx = Fixture::new();
    let search = fx.search();
    let one = search.run(1, &fx.ask("needle", json!({})));
    let two = search.run(2, &fx.ask("needle", json!({})));
    assert!(matches!(one.await, SearchOutcome::Ok(_)));
    assert!(matches!(two.await, SearchOutcome::Ok(_)));
}

#[tokio::test]
async fn reuses_the_file_list_for_a_while_so_a_new_file_does_not_show_at_once() {
    let fx = Fixture::new();
    let search = fx.search();
    let before = results(
        search
            .run(1, &fx.ask("fresh", json!({"namesOnly": true})))
            .await,
    );
    assert!(before.names.is_empty());
    fs::write(format!("{}/src/fresh.txt", fx.root), "x").unwrap();
    let after = results(
        search
            .run(1, &fx.ask("fresh", json!({"namesOnly": true})))
            .await,
    );
    assert!(after.names.is_empty());
    let other = fx.search();
    let found = results(
        other
            .run(1, &fx.ask("fresh", json!({"namesOnly": true})))
            .await,
    );
    assert_eq!(found.names.len(), 1);
}

#[tokio::test]
async fn keeps_one_file_list_for_all_files_and_one_for_tracked_files() {
    let fx = Fixture::new();
    let search = fx.search();
    let tracked = results(
        search
            .run(1, &fx.ask("out", json!({"namesOnly": true})))
            .await,
    );
    assert!(tracked.names.is_empty());
    let all = results(
        search
            .run(
                1,
                &fx.ask("out", json!({"namesOnly": true, "includeIgnored": true})),
            )
            .await,
    );
    let paths: Vec<&str> = all.names.iter().map(|name| name.path.as_str()).collect();
    assert_eq!(paths, ["build/out.txt"]);
}

#[tokio::test]
async fn reports_a_missing_ripgrep_binary_without_panicking() {
    let fx = Fixture::new();
    let search = WorkspaceSearch::new(
        fx.home.path().join("no-such-rg"),
        vec![fx.home.path().to_string_lossy().into_owned()],
        host(fx.home.path()),
    );
    let outcome = search.run(1, &fx.ask("needle", json!({}))).await;
    assert!(failed_with(&outcome, SearchError::RgMissing));
}
