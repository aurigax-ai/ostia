#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use ostia_base::js::utf16_len;
use ostia_files::ripgrep::{
    FILE_LIST_LIMIT, MATCH_LIMIT, PREVIEW_CHARS, RgFailureCode, TextQuery, files_argv, list_files,
    parse_match, preview, relative_path, ripgrep_path, search_text, text_argv,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

fn query() -> TextQuery {
    TextQuery {
        text: "hello".into(),
        regex: false,
        case_sensitive: false,
        whole_word: false,
        include_ignored: false,
    }
}

fn argv(q: &TextQuery) -> Vec<String> {
    text_argv(q)
}

fn tail(items: &[String], count: usize) -> Vec<&str> {
    items[items.len() - count..]
        .iter()
        .map(String::as_str)
        .collect()
}

fn match_event(path: &str, text: &str, line: u64, spans: &[(u64, u64)]) -> String {
    json!({
        "type": "match",
        "data": {
            "path": {"text": path},
            "lines": {"text": text},
            "line_number": line,
            "absolute_offset": 0,
            "submatches": spans
                .iter()
                .map(|(start, end)| json!({"match": {"text": ""}, "start": start, "end": end}))
                .collect::<Vec<_>>(),
        },
    })
    .to_string()
}

fn ranges(items: &[(usize, usize)]) -> Vec<(usize, usize)> {
    items.to_vec()
}

#[test]
fn searches_literally_and_ignoring_case_by_default_after_an_end_of_options_marker() {
    let args = argv(&query());
    assert!(args.contains(&"--fixed-strings".to_owned()));
    assert!(args.contains(&"--ignore-case".to_owned()));
    assert!(args.contains(&"--no-config".to_owned()));
    assert_eq!(tail(&args, 3), ["--", "hello", "."]);
}

#[test]
fn passes_a_text_that_looks_like_an_option_as_data() {
    let q = TextQuery {
        text: "--pre=sh".into(),
        ..query()
    };
    assert_eq!(tail(&argv(&q), 3), ["--", "--pre=sh", "."]);
}

#[test]
fn maps_regex_case_and_whole_word_to_rg_flags() {
    let q = TextQuery {
        regex: true,
        case_sensitive: true,
        whole_word: true,
        ..query()
    };
    let args = argv(&q);
    assert!(!args.contains(&"--fixed-strings".to_owned()));
    assert!(args.contains(&"--case-sensitive".to_owned()));
    assert!(!args.contains(&"--ignore-case".to_owned()));
    assert!(args.contains(&"--word-regexp".to_owned()));
}

#[test]
fn leaves_pdfs_to_the_pdf_search_whatever_their_case() {
    assert!(argv(&query()).join(" ").contains("--iglob !*.pdf"));
    assert!(!files_argv(false).join(" ").contains("*.pdf"));
}

#[test]
fn respects_gitignore_unless_ignored_files_are_included() {
    let no_ignore = "--no-ignore".to_owned();
    assert!(!argv(&query()).contains(&no_ignore));
    assert!(!files_argv(false).contains(&no_ignore));
    let included = TextQuery {
        include_ignored: true,
        ..query()
    };
    assert!(argv(&included).contains(&no_ignore));
    assert!(files_argv(true).contains(&no_ignore));
}

#[test]
fn always_skips_the_git_folder_for_text_and_for_file_lists() {
    assert!(argv(&query()).join(" ").contains("--glob !.git"));
    assert!(files_argv(false).join(" ").contains("--glob !.git"));
}

#[test]
fn builds_the_exact_argument_lists() {
    assert_eq!(
        argv(&query()),
        [
            "--json",
            "--no-config",
            "--hidden",
            "--glob",
            "!.git",
            "--no-messages",
            "--max-filesize",
            "2M",
            "--iglob",
            "!*.pdf",
            "--ignore-case",
            "--fixed-strings",
            "--",
            "hello",
            ".",
        ]
    );
    let all = TextQuery {
        regex: true,
        case_sensitive: true,
        whole_word: true,
        include_ignored: true,
        ..query()
    };
    assert_eq!(
        argv(&all),
        [
            "--json",
            "--no-config",
            "--hidden",
            "--glob",
            "!.git",
            "--no-messages",
            "--no-ignore",
            "--max-filesize",
            "2M",
            "--iglob",
            "!*.pdf",
            "--case-sensitive",
            "--word-regexp",
            "--",
            "hello",
            ".",
        ]
    );
    assert_eq!(
        files_argv(false),
        [
            "--files",
            "--no-config",
            "--hidden",
            "--glob",
            "!.git",
            "--no-messages",
            "."
        ]
    );
    assert_eq!(
        files_argv(true),
        [
            "--files",
            "--no-config",
            "--hidden",
            "--glob",
            "!.git",
            "--no-messages",
            "--no-ignore",
            "."
        ]
    );
}

#[test]
fn reads_path_line_a_1_based_column_and_the_matched_range() {
    let hit = parse_match(&match_event(
        "./src/a.ts",
        "const hello = 1\n",
        12,
        &[(6, 11)],
    ))
    .unwrap();
    assert_eq!(hit.path, "src/a.ts");
    assert_eq!(hit.line_match.line, 12);
    assert_eq!(hit.line_match.column, 7);
    assert_eq!(hit.line_match.text, "const hello = 1");
    assert_eq!(hit.line_match.ranges, ranges(&[(6, 11)]));
}

#[test]
fn turns_byte_offsets_into_character_offsets_on_non_ascii_lines() {
    let hit = parse_match(&match_event("./a.txt", "café hello\n", 2, &[(6, 11)])).unwrap();
    assert_eq!(hit.line_match.column, 6);
    assert_eq!(hit.line_match.ranges, ranges(&[(5, 10)]));
    let text: Vec<char> = hit.line_match.text.chars().collect();
    assert_eq!(text[5..10].iter().collect::<String>(), "hello");
}

#[test]
fn ignores_events_that_are_not_matches_and_lines_that_are_not_json() {
    let begin = json!({"type": "begin", "data": {"path": {"text": "a"}}}).to_string();
    assert!(parse_match(&begin).is_none());
    assert!(parse_match("rg: warning").is_none());
}

#[test]
fn skips_a_line_rg_could_only_give_as_bytes() {
    let raw = json!({
        "type": "match",
        "data": {"path": {"text": "a"}, "lines": {"bytes": "AAE="}, "line_number": 1, "submatches": []},
    })
    .to_string();
    assert!(parse_match(&raw).is_none());
}

#[test]
fn counts_utf16_units_for_an_astral_character_before_the_match() {
    let hit = parse_match(&match_event("./a.txt", "a😀 hello\n", 1, &[(6, 11)])).unwrap();
    assert_eq!(hit.line_match.ranges, ranges(&[(4, 9)]));
    assert_eq!(hit.line_match.column, 5);
}

#[test]
fn drops_a_match_event_with_a_missing_or_wrongly_typed_field() {
    let broken = [
        json!({"type": "match"}),
        json!({"type": "match", "data": {"lines": {"text": "a\n"}, "line_number": 1}}),
        json!({"type": "match", "data": {"path": {"text": 5}, "lines": {"text": "a\n"}, "line_number": 1}}),
        json!({"type": "match", "data": {"path": {"text": "a"}, "line_number": 1}}),
        json!({"type": "match", "data": {"path": {"text": "a"}, "lines": {"text": "a\n"}, "line_number": "1"}}),
        json!({"type": "match", "data": {"path": {"text": "a"}, "lines": {"text": "a\n"}}}),
        json!(null),
        json!(7),
    ];
    for event in broken {
        assert!(parse_match(&event.to_string()).is_none(), "{event}");
    }
}

#[test]
fn keeps_a_match_without_submatches_at_column_one_and_skips_bad_submatches() {
    let bare = json!({
        "type": "match",
        "data": {"path": {"text": "./a"}, "lines": {"text": "  x\n"}, "line_number": 3},
    })
    .to_string();
    let hit = parse_match(&bare).unwrap();
    assert_eq!(hit.line_match.column, 1);
    assert_eq!(hit.line_match.ranges, ranges(&[]));
    assert_eq!(hit.line_match.text, "x");

    let mixed = json!({
        "type": "match",
        "data": {
            "path": {"text": "./a"},
            "lines": {"text": "abc abc\n"},
            "line_number": 1,
            "submatches": [
                {"start": "0", "end": 3},
                {"start": 0},
                {"start": 4, "end": 4},
                {"start": 5, "end": 3},
                {"start": 4, "end": 7},
            ],
        },
    })
    .to_string();
    let hit = parse_match(&mixed).unwrap();
    assert_eq!(hit.line_match.ranges, ranges(&[(4, 7)]));
    assert_eq!(hit.line_match.column, 5);
}

#[test]
fn strips_the_line_ending_and_clamps_a_range_to_the_line() {
    let crlf = parse_match(&match_event("./a", "abc\r\n", 1, &[(0, 3)])).unwrap();
    assert_eq!(crlf.line_match.text, "abc");
    assert_eq!(crlf.line_match.ranges, ranges(&[(0, 3)]));
    let past = parse_match(&match_event("./a", "abc\n", 1, &[(1, 4)])).unwrap();
    assert_eq!(past.line_match.ranges, ranges(&[(1, 3)]));
    let beyond = parse_match(&match_event("./a", "abc\n", 1, &[(5, 9)]));
    assert_eq!(beyond.unwrap().line_match.ranges, ranges(&[]));
}

#[test]
fn drops_the_indent_before_the_match() {
    let shown = preview("      return hello", &[(13, 18)]);
    assert_eq!(shown.text, "return hello");
    assert_eq!(shown.ranges, ranges(&[(7, 12)]));
}

#[test]
fn clips_a_long_line_around_the_first_match_and_keeps_the_range_on_the_match() {
    let line = format!("{}needle{}", "x".repeat(5000), "y".repeat(5000));
    let shown = preview(&line, &[(5000, 5006)]);
    assert_eq!(utf16_len(&shown.text), PREVIEW_CHARS);
    let (from, to) = shown.ranges[0];
    assert_eq!(&shown.text[from..to], "needle");
}

#[test]
fn drops_ranges_past_the_clipped_text() {
    let line = format!("a{}a", "x".repeat(1000));
    assert_eq!(
        preview(&line, &[(0, 1), (1001, 1002)]).ranges,
        ranges(&[(0, 1)])
    );
}

#[test]
fn keeps_the_indent_when_the_match_starts_inside_it_and_clips_a_range_that_runs_past_the_end() {
    let inside = preview("    abc", &[(1, 3)]);
    assert_eq!(inside.text, "   abc");
    assert_eq!(inside.ranges, ranges(&[(0, 2)]));
    let line = "x".repeat(300);
    let clipped = preview(&line, &[(100, 400)]);
    assert_eq!(clipped.text.len(), PREVIEW_CHARS);
    assert_eq!(clipped.ranges, ranges(&[(40, 240)]));
    let none = preview("   plain text", &[]);
    assert_eq!(none.text, "plain text");
    assert_eq!(none.ranges, ranges(&[]));
}

#[test]
fn strips_the_dot_slash_rg_prints_for_the_searched_folder() {
    assert_eq!(relative_path("./src/a.ts"), "src/a.ts");
    assert_eq!(relative_path(".env"), ".env");
}

#[test]
fn points_at_the_platform_package_next_to_the_app() {
    assert_eq!(
        ripgrep_path("/repo", "linux", "x64"),
        "/repo/node_modules/@vscode/ripgrep-linux-x64/bin/rg"
    );
}

#[test]
fn points_into_app_asar_unpacked_for_a_packaged_app() {
    assert_eq!(
        ripgrep_path("/opt/ostia/resources/app.asar", "darwin", "arm64"),
        "/opt/ostia/resources/app.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg"
    );
}

#[test]
fn names_the_binary_rg_exe_on_windows_and_keeps_an_asar_in_the_middle_of_a_path() {
    assert_eq!(
        ripgrep_path("/repo", "win32", "x64"),
        "/repo/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe"
    );
    assert_eq!(
        ripgrep_path("/a.asar/b", "linux", "x64"),
        "/a.asar/b/node_modules/@vscode/ripgrep-linux-x64/bin/rg"
    );
}

fn fake_rg() -> &'static Path {
    static BIN: OnceLock<(TempDir, PathBuf)> = OnceLock::new();
    &BIN.get_or_init(|| {
        let dir = TempDir::new().unwrap();
        let bin = dir.path().join("rg");
        let script = "#!/bin/sh\n\
            printf '%s\\n' \"$@\" > argv\n\
            [ -f stderr ] && cat stderr >&2\n\
            [ -f stdout ] && cat stdout\n\
            [ -f sleep ] && exec sleep \"$(cat sleep)\"\n\
            exit \"$(cat code 2>/dev/null || echo 0)\"\n";
        fs::write(&bin, script).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        (dir, bin)
    })
    .1
}

struct Root {
    dir: TempDir,
}

impl Root {
    fn new() -> Self {
        fake_rg();
        Self {
            dir: TempDir::new().unwrap(),
        }
    }

    fn put(&self, name: &str, text: &str) -> &Self {
        fs::write(self.dir.path().join(name), text).unwrap();
        self
    }

    fn lines(&self, lines: &[String]) -> &Self {
        self.put("stdout", &format!("{}\n", lines.join("\n")))
    }

    fn argv(&self) -> Vec<String> {
        fs::read_to_string(self.dir.path().join("argv"))
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }
}

fn hit(path: &str, line: u64) -> String {
    match_event(path, "hello\n", line, &[(0, 5)])
}

async fn search(root: &Root, limit: usize) -> Value {
    let result = search_text(
        fake_rg(),
        root.path(),
        &query(),
        &CancellationToken::new(),
        limit,
    )
    .await;
    match result {
        Ok(results) => json!({
            "ok": true,
            "files": results.files.iter().map(|f| json!({
                "path": f.path,
                "lines": f.matches.iter().map(|m| m.line).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "matches": results.matches,
            "truncated": results.truncated,
        }),
        Err(failure) => json!({
            "ok": false,
            "error": failure.error.as_str(),
            "message": failure.message,
        }),
    }
}

#[tokio::test]
async fn groups_matches_by_path_sorted_by_path_and_counts_them() {
    let root = Root::new();
    root.lines(&[
        hit("./z.rs", 1),
        hit("./src/b.rs", 4),
        hit("./a.rs", 2),
        hit("./src/b.rs", 9),
        json!({"type": "begin", "data": {"path": {"text": "x"}}}).to_string(),
        "rg: warning".to_owned(),
        hit("./a.rs", 5),
    ]);
    assert_eq!(
        search(&root, MATCH_LIMIT).await,
        json!({
            "ok": true,
            "files": [
                {"path": "a.rs", "lines": [2, 5]},
                {"path": "src/b.rs", "lines": [4, 9]},
                {"path": "z.rs", "lines": [1]},
            ],
            "matches": 5,
            "truncated": false,
        })
    );
}

#[tokio::test]
async fn runs_rg_in_the_searched_folder_with_the_text_arguments() {
    let root = Root::new();
    root.lines(&[hit("./a.rs", 1)]);
    search(&root, MATCH_LIMIT).await;
    assert_eq!(root.argv(), argv(&query()));
}

#[tokio::test]
async fn sorts_paths_by_utf16_code_unit_order_as_js_does() {
    let root = Root::new();
    root.lines(&[hit("./\u{ff5e}", 1), hit("./😀", 1), hit("./a", 1)]);
    let res = search(&root, MATCH_LIMIT).await;
    let paths: Vec<&str> = res["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["a", "😀", "\u{ff5e}"]);
}

#[tokio::test]
async fn stops_at_the_match_limit_and_reports_truncated() {
    let root = Root::new();
    let lines: Vec<String> = (1..=5).map(|n| hit("./a.rs", n)).collect();
    root.lines(&lines);
    assert_eq!(
        search(&root, 3).await,
        json!({"ok": true, "files": [{"path": "a.rs", "lines": [1, 2, 3]}], "matches": 3, "truncated": true})
    );
    assert_eq!(
        search(&root, 6).await,
        json!({"ok": true, "files": [{"path": "a.rs", "lines": [1, 2, 3, 4, 5]}], "matches": 5, "truncated": false})
    );
}

#[tokio::test(start_paused = true)]
async fn ends_a_run_that_never_finishes_after_fifteen_seconds() {
    let root = Root::new();
    root.put("sleep", "600");
    let res = search(&root, MATCH_LIMIT).await;
    assert_eq!(res["ok"], json!(true), "{res}");
    assert_eq!(res["truncated"], json!(true));
}

#[tokio::test]
async fn reports_a_missing_binary_as_rg_missing() {
    let root = Root::new();
    let missing = root.path().join("no-such-rg");
    let result = search_text(
        &missing,
        root.path(),
        &query(),
        &CancellationToken::new(),
        MATCH_LIMIT,
    )
    .await;
    let failure = result.unwrap_err();
    assert_eq!(failure.error, RgFailureCode::RgMissing);
    assert_eq!(failure.message, "ripgrep is missing from this build");
}

#[tokio::test]
async fn reports_a_binary_that_cannot_run_as_failed_with_the_system_message() {
    let root = Root::new();
    let plain = root.path().join("rg");
    fs::write(&plain, "x").unwrap();
    let result = search_text(
        &plain,
        root.path(),
        &query(),
        &CancellationToken::new(),
        MATCH_LIMIT,
    )
    .await;
    let failure = result.unwrap_err();
    assert_eq!(failure.error, RgFailureCode::Failed);
    assert!(!failure.message.is_empty());
}

#[tokio::test]
async fn reports_a_bad_regex_or_glob_as_invalid_pattern_whatever_the_case() {
    for stderr in [
        "rg: regex parse error:\n    (a\n    ^\nerror: unclosed group\n",
        "error parsing glob '[': unclosed character class\n",
        "INVALID GLOB x\n",
        "Regex Parse Error\n",
    ] {
        let root = Root::new();
        root.put("stderr", stderr).put("code", "2");
        let res = search(&root, MATCH_LIMIT).await;
        assert_eq!(res["ok"], json!(false), "{stderr}");
        assert_eq!(res["error"], json!("invalid-pattern"), "{stderr}");
        assert_eq!(res["message"], json!(stderr.trim()), "{stderr}");
    }
}

#[tokio::test]
async fn reports_another_error_exit_as_failed_with_the_first_eight_trimmed_lines() {
    let root = Root::new();
    let stderr: String = (1..=12).map(|n| format!("line {n}\n")).collect();
    root.put("stderr", &format!("  \n{stderr}"))
        .put("code", "2");
    let res = search(&root, MATCH_LIMIT).await;
    assert_eq!(res["error"], json!("failed"));
    assert_eq!(
        res["message"],
        json!("line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8")
    );
}

#[tokio::test]
async fn treats_exit_codes_zero_and_one_and_an_error_exit_without_stderr_as_success() {
    for (code, stderr) in [
        ("0", ""),
        ("1", ""),
        ("1", "rg: warning\n"),
        ("2", ""),
        ("2", "  \n\n"),
    ] {
        let root = Root::new();
        root.lines(&[hit("./a.rs", 1)])
            .put("code", code)
            .put("stderr", stderr);
        let res = search(&root, MATCH_LIMIT).await;
        assert_eq!(res["ok"], json!(true), "{code} {stderr:?}");
        assert_eq!(res["matches"], json!(1), "{code} {stderr:?}");
    }
}

#[tokio::test]
async fn reports_a_run_that_was_cancelled_before_it_started_without_spawning() {
    let root = Root::new();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let missing = root.path().join("no-such-rg");
    let result = search_text(&missing, root.path(), &query(), &cancel, MATCH_LIMIT).await;
    let failure = result.unwrap_err();
    assert_eq!(failure.error, RgFailureCode::Cancelled);
    assert_eq!(failure.message, "");
    assert!(!root.path().join("argv").exists());
}

#[tokio::test]
async fn reports_a_run_that_was_cancelled_while_running_as_cancelled_and_stops_the_child() {
    let root = Root::new();
    root.lines(&[hit("./a.rs", 1)]).put("sleep", "60");
    let cancel = CancellationToken::new();
    let started = std::time::Instant::now();
    let (result, ()) = tokio::join!(
        search_text(fake_rg(), root.path(), &query(), &cancel, MATCH_LIMIT),
        async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel.cancel();
        }
    );
    let failure = result.unwrap_err();
    assert_eq!(failure.error, RgFailureCode::Cancelled);
    assert_eq!(failure.message, "");
    assert!(started.elapsed() < Duration::from_secs(30));
}

#[tokio::test]
async fn lists_files_without_the_dot_slash_and_not_truncated() {
    let root = Root::new();
    root.lines(&[
        "./a.rs".to_owned(),
        "./src/b.rs".to_owned(),
        ".env".to_owned(),
    ]);
    let list = list_files(fake_rg(), root.path(), false, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(list.paths, ["a.rs", "src/b.rs", ".env"]);
    assert!(!list.truncated);
    assert_eq!(root.argv(), files_argv(false));
    list_files(fake_rg(), root.path(), true, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(root.argv(), files_argv(true));
}

#[tokio::test]
async fn stops_a_file_list_at_the_limit_and_reports_truncated() {
    let root = Root::new();
    let lines: Vec<String> = (1..=FILE_LIST_LIMIT + 10)
        .map(|n| format!("./f{n}"))
        .collect();
    root.lines(&lines);
    let list = list_files(fake_rg(), root.path(), false, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(list.paths.len(), FILE_LIST_LIMIT);
    assert_eq!(list.paths[0], "f1");
    assert!(list.truncated);
}

#[tokio::test]
async fn reports_failures_of_a_file_list_the_same_way_as_a_text_search() {
    let root = Root::new();
    let missing = root.path().join("no-such-rg");
    let failure = list_files(&missing, root.path(), false, &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(failure.error, RgFailureCode::RgMissing);
    root.put("stderr", "boom\n").put("code", "2");
    let failure = list_files(fake_rg(), root.path(), false, &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(failure.error, RgFailureCode::Failed);
    assert_eq!(failure.message, "boom");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let failure = list_files(fake_rg(), root.path(), false, &cancel)
        .await
        .unwrap_err();
    assert_eq!(failure.error, RgFailureCode::Cancelled);
}
