#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use ostia_agents::chat_fs_tools::{
    CHAT_EDITS_MAX, CHAT_LIST_MAX, CHAT_QUERY_MAX, CHAT_READ_FILE_MAX, CHAT_SEARCH_MATCHES_MAX,
    CHAT_WRITE_MAX, list_tool, plan_edit_tool, preview_tool, read_tool, restore_tool, search_tool,
    version_of, write_tool,
};
use ostia_base::host::Host;
use ostia_testkit::temp_host;
use serde_json::{Value, json};
use tempfile::TempDir;

const A_TEXT: &str = "one\ntwo\nthree needle\nfour";

struct Fix {
    _dir: TempDir,
    host: Host,
    home: PathBuf,
    project: PathBuf,
    other: PathBuf,
    outside_roots: PathBuf,
}

fn setup() -> Fix {
    let (dir, host) = temp_host().unwrap();
    let base = dir.path().to_path_buf();
    let home = base.join("home");
    let project = home.join("project");
    let other = home.join("other");
    let outside_roots = base.join("elsewhere");
    for folder in [
        &project,
        &other,
        &outside_roots,
        &project.join("node_modules").join("x"),
    ] {
        fs::create_dir_all(folder).unwrap();
    }
    fs::write(project.join("a.txt"), A_TEXT).unwrap();
    fs::write(
        project.join("node_modules").join("x").join("dep.txt"),
        "needle in a dependency",
    )
    .unwrap();
    fs::write(other.join("notes.txt"), "private notes").unwrap();
    fs::write(outside_roots.join("secret.txt"), "not for the assistant").unwrap();
    Fix {
        _dir: dir,
        host,
        home,
        project,
        other,
        outside_roots,
    }
}

fn s(path: impl AsRef<Path>) -> String {
    path.as_ref().to_str().unwrap().to_owned()
}

fn merge(mut base: Value, extra: Value) -> Value {
    let (Some(target), Some(source)) = (base.as_object_mut(), extra.as_object()) else {
        panic!("merge needs two objects");
    };
    for (key, value) in source {
        target.insert(key.clone(), value.clone());
    }
    base
}

fn contains(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(actual), Value::Object(expected)) => expected
            .iter()
            .all(|(key, want)| actual.get(key).is_some_and(|got| contains(got, want))),
        _ => actual == expected,
    }
}

#[track_caller]
fn assert_has(actual: &Value, expected: Value) {
    assert!(
        contains(actual, &expected),
        "expected {expected} inside {actual}"
    );
}

fn version(text: &str) -> String {
    version_of(text.as_bytes())
}

impl Fix {
    fn roots(&self) -> String {
        s(&self.home)
    }

    fn read(&self, req: Value) -> Value {
        read_tool(&req, &[self.roots().as_str()], &self.host)
    }

    fn list(&self, req: Value) -> Value {
        list_tool(&req, &[self.roots().as_str()], &self.host)
    }

    fn search(&self, req: Value) -> Value {
        search_tool(&req, &[self.roots().as_str()], &self.host)
    }

    fn preview(&self, req: Value) -> Value {
        preview_tool(&req, &[self.roots().as_str()], &self.host)
    }

    fn plan_request(&self, req: Value) -> Value {
        plan_edit_tool(&req, &[self.roots().as_str()], &self.host)
    }

    fn write(&self, req: Value) -> Value {
        write_tool(&req, &[self.roots().as_str()], &self.host)
    }

    fn restore_request(&self, req: Value) -> Value {
        restore_tool(&req, &[self.roots().as_str()], &self.host)
    }

    fn in_folder(&self, path: &Path) -> Value {
        json!({"path": s(path), "root": s(&self.project), "outside": false, "symlinks": false})
    }

    fn target(&self, path: &Path, outside: bool) -> Value {
        json!({"path": s(path), "root": s(&self.project), "outside": outside})
    }

    fn preview_of(&self, path: &Path) -> Value {
        self.preview(json!({"path": s(path), "root": s(&self.project), "dirty": []}))
    }

    fn plan(&self, edits: Value, target: &Path, outside: bool) -> Value {
        self.plan_request(json!({
            "path": s(target),
            "root": s(&self.project),
            "edits": edits,
            "outside": outside,
            "dirty": [],
        }))
    }

    fn plan_a(&self, edits: Value) -> Value {
        self.plan(edits, &self.project.join("a.txt"), false)
    }

    fn restore(&self, path: &Path, expected: Value, content: Value, extra: Value) -> Value {
        let request = merge(
            self.in_folder(path),
            json!({"expected": expected, "content": content, "dirty": []}),
        );
        self.restore_request(merge(request, extra))
    }

    fn a_text(&self) -> String {
        fs::read_to_string(self.project.join("a.txt")).unwrap()
    }
}

#[test]
fn reads_a_file_inside_the_workspace_folder_with_line_bounds() {
    let fix = setup();
    let res = fix.read(merge(
        fix.target(&fix.project.join("a.txt"), false),
        json!({"offset": 2, "limit": 2}),
    ));
    assert_has(
        &res,
        json!({"ok": true, "text": "two\nthree needle", "startLine": 2, "endLine": 3}),
    );
    assert_eq!(res["truncated"], json!(true));
}

#[test]
fn needs_the_outside_flag_for_a_file_outside_the_workspace_folder() {
    let fix = setup();
    let path = fix.other.join("notes.txt");
    assert_has(
        &fix.read(fix.target(&path, false)),
        json!({"ok": false, "error": "outside-folder"}),
    );
    assert_has(
        &fix.read(fix.target(&path, true)),
        json!({"ok": true, "text": "private notes"}),
    );
}

#[test]
fn never_reads_outside_the_allowed_roots_also_through_a_symlink_or_dotdot() {
    let fix = setup();
    let secret = fix.outside_roots.join("secret.txt");
    assert_has(
        &fix.read(fix.target(&secret, true)),
        json!({"ok": false, "error": "not-allowed"}),
    );
    symlink(&secret, fix.project.join("link.txt")).unwrap();
    assert_has(
        &fix.read(fix.target(&fix.project.join("link.txt"), true)),
        json!({"ok": false, "error": "not-allowed"}),
    );
    let dotdot = json!({
        "path": format!("{}/../../elsewhere/secret.txt", s(&fix.project)),
        "root": s(&fix.project),
        "outside": true,
    });
    assert_has(
        &fix.read(dotdot),
        json!({"ok": false, "error": "not-allowed"}),
    );
}

#[test]
fn treats_a_symlink_that_leaves_the_workspace_folder_as_outside_it() {
    let fix = setup();
    symlink(
        fix.other.join("notes.txt"),
        fix.project.join("notes-link.txt"),
    )
    .unwrap();
    assert_has(
        &fix.read(fix.target(&fix.project.join("notes-link.txt"), false)),
        json!({"ok": false, "error": "outside-folder"}),
    );
}

#[test]
fn refuses_relative_paths_binary_files_and_files_over_the_cap() {
    let fix = setup();
    assert_has(
        &fix.read(json!({"path": "a.txt", "root": s(&fix.project), "outside": false})),
        json!({"ok": false, "error": "invalid"}),
    );
    fs::write(fix.project.join("bin"), [1u8, 0, 2]).unwrap();
    assert_has(
        &fix.read(fix.target(&fix.project.join("bin"), false)),
        json!({"ok": false, "error": "binary"}),
    );
    fs::write(fix.project.join("big"), vec![97u8; CHAT_READ_FILE_MAX + 1]).unwrap();
    assert_has(
        &fix.read(fix.target(&fix.project.join("big"), false)),
        json!({"ok": false, "error": "too-large"}),
    );
}

#[test]
fn lists_folders_first() {
    let fix = setup();
    let res = fix.list(fix.target(&fix.project, false));
    let names: Vec<String> = res["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            format!(
                "{}:{}",
                entry["kind"].as_str().unwrap(),
                entry["name"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(res["ok"], json!(true));
    assert_eq!(names, vec!["dir:node_modules", "file:a.txt"]);
}

#[test]
fn finds_names_and_contents_but_skips_node_modules() {
    let fix = setup();
    let res = fix.search(merge(
        fix.target(&fix.project, false),
        json!({"query": "NEEDLE"}),
    ));
    assert_eq!(res["ok"], json!(true));
    assert_eq!(
        res["matches"],
        json!([{"path": "a.txt", "line": 3, "text": "three needle"}])
    );
}

#[test]
fn shows_the_current_text_and_version_then_writes_and_creates_files() {
    let fix = setup();
    let path = fix.project.join("a.txt");
    let before = fix.preview_of(&path);
    assert_has(
        &before,
        json!({
            "ok": true,
            "exists": true,
            "text": A_TEXT,
            "outside": false,
            "symlink": false,
        }),
    );
    let base = before["version"].clone();
    assert_eq!(base, json!(version(A_TEXT)));
    assert_has(
        &fix.write(merge(
            fix.in_folder(&path),
            json!({"content": "new", "base": base}),
        )),
        json!({"ok": true, "created": false, "bytes": 3, "version": version("new")}),
    );
    assert_eq!(fix.a_text(), "new");
    let fresh = fix.project.join("sub").join("b.txt");
    assert_has(
        &fix.preview_of(&fresh),
        json!({"ok": true, "exists": false, "text": "", "version": null}),
    );
    assert_has(
        &fix.write(merge(
            fix.in_folder(&fresh),
            json!({"content": "b", "base": null}),
        )),
        json!({"ok": true, "created": true}),
    );
    assert_eq!(fs::read_to_string(&fresh).unwrap(), "b");
}

#[test]
fn says_a_path_outside_the_workspace_folder_is_outside_and_writes_it_only_when_allowed() {
    let fix = setup();
    let path = fix.other.join("notes.txt");
    let preview = fix.preview_of(&path);
    assert_has(&preview, json!({"ok": true, "outside": true}));
    let base = preview["version"].clone();
    assert_has(
        &fix.write(merge(
            fix.in_folder(&path),
            json!({"content": "x", "base": base}),
        )),
        json!({"ok": false, "error": "outside-folder"}),
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "private notes");
    assert_has(
        &fix.write(merge(
            fix.in_folder(&path),
            json!({"outside": true, "content": "x", "base": base}),
        )),
        json!({"ok": true}),
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "x");
}

#[test]
fn refuses_to_write_when_the_file_changed_appeared_or_vanished_since_the_preview() {
    let fix = setup();
    let path = fix.project.join("a.txt");
    let stale = version("something else");
    assert_has(
        &fix.write(merge(
            fix.in_folder(&path),
            json!({"content": "new", "base": stale}),
        )),
        json!({"ok": false, "error": "changed"}),
    );
    assert_has(
        &fix.write(merge(
            fix.in_folder(&path),
            json!({"content": "new", "base": null}),
        )),
        json!({"ok": false, "error": "changed"}),
    );
    assert_has(
        &fix.write(merge(
            fix.in_folder(&fix.project.join("gone.txt")),
            json!({"content": "x", "base": stale}),
        )),
        json!({"ok": false, "error": "changed"}),
    );
    assert_eq!(fix.a_text(), A_TEXT);
}

#[test]
fn refuses_a_file_symlink_the_roots_and_a_symlinked_folder_unless_the_human_allowed_it() {
    let fix = setup();
    symlink(fix.other.join("notes.txt"), fix.project.join("l.txt")).unwrap();
    let link = merge(
        fix.in_folder(&fix.project.join("l.txt")),
        json!({"outside": true, "content": "x", "base": null}),
    );
    assert_has(
        &fix.write(link.clone()),
        json!({"ok": false, "error": "through-symlink"}),
    );
    assert_has(
        &fix.write(merge(link, json!({"symlinks": true}))),
        json!({"ok": false, "error": "not-a-file"}),
    );
    assert_eq!(
        fs::read_to_string(fix.other.join("notes.txt")).unwrap(),
        "private notes"
    );
    assert_has(
        &fix.write(merge(
            fix.in_folder(&fix.outside_roots.join("new.txt")),
            json!({"outside": true, "content": "x", "base": null}),
        )),
        json!({"ok": false, "error": "not-allowed"}),
    );
    symlink(&fix.outside_roots, fix.project.join("escape")).unwrap();
    assert_has(
        &fix.write(merge(
            fix.in_folder(&fix.project.join("escape").join("new.txt")),
            json!({"outside": true, "symlinks": true, "content": "x", "base": null}),
        )),
        json!({"ok": false, "error": "not-allowed"}),
    );
    fs::create_dir(fix.project.join("real")).unwrap();
    symlink(fix.project.join("real"), fix.project.join("alias")).unwrap();
    let aliased = fix.project.join("alias").join("c.txt");
    assert_has(
        &fix.preview_of(&aliased),
        json!({"ok": true, "outside": false, "symlink": true}),
    );
    assert_has(
        &fix.write(merge(
            fix.in_folder(&aliased),
            json!({"content": "c", "base": null}),
        )),
        json!({"ok": false, "error": "through-symlink"}),
    );
    assert_has(
        &fix.write(merge(
            fix.in_folder(&aliased),
            json!({"symlinks": true, "content": "c", "base": null}),
        )),
        json!({"ok": true, "created": true}),
    );
    assert_eq!(
        fs::read_to_string(fix.project.join("real").join("c.txt")).unwrap(),
        "c"
    );
}

#[test]
fn refuses_content_over_the_size_cap() {
    let fix = setup();
    let big = "x".repeat(CHAT_WRITE_MAX + 1);
    assert_has(
        &fix.write(merge(
            fix.in_folder(&fix.project.join("big.txt")),
            json!({"content": big, "base": null}),
        )),
        json!({"ok": false, "error": "too-large"}),
    );
}

#[test]
fn does_not_treat_a_workspace_folder_reached_through_a_symlink_as_a_symlinked_write() {
    let fix = setup();
    let via_link = fix.home.join("shortcut");
    symlink(&fix.project, &via_link).unwrap();
    assert_has(
        &fix.preview(json!({
            "path": s(via_link.join("a.txt")),
            "root": s(&via_link),
            "dirty": [],
        })),
        json!({"ok": true, "outside": false, "symlink": false}),
    );
}

#[test]
fn replaces_one_unique_string_and_leaves_the_file_untouched() {
    let fix = setup();
    let res = fix.plan_a(json!([{"oldText": "two", "newText": "2"}]));
    assert_has(
        &res,
        json!({
            "ok": true,
            "before": A_TEXT,
            "after": "one\n2\nthree needle\nfour",
            "outside": false,
            "symlink": false,
        }),
    );
    assert_eq!(fix.a_text(), A_TEXT);
}

#[test]
fn applies_several_replacements_in_order() {
    let fix = setup();
    let res = fix.plan_a(json!([
        {"oldText": "one", "newText": "uno"},
        {"oldText": "uno\ntwo", "newText": "uno\ndos"},
    ]));
    assert_eq!(res["ok"], json!(true));
    assert_eq!(res["after"], json!("uno\ndos\nthree needle\nfour"));
}

#[test]
fn says_which_edit_found_nothing() {
    let fix = setup();
    assert_has(
        &fix.plan_a(json!([
            {"oldText": "one", "newText": "uno"},
            {"oldText": "missing", "newText": "x"},
        ])),
        json!({"ok": false, "error": "no-match", "edit": 1}),
    );
}

#[test]
fn refuses_text_that_is_not_unique_unless_every_match_is_wanted() {
    let fix = setup();
    fs::write(fix.project.join("a.txt"), "a b a b a").unwrap();
    assert_has(
        &fix.plan_a(json!([{"oldText": "a", "newText": "c"}])),
        json!({"ok": false, "error": "ambiguous", "edit": 0, "count": 3}),
    );
    let all = fix.plan_a(json!([{"oldText": "a", "newText": "c", "replaceAll": true}]));
    assert_eq!(all["ok"], json!(true));
    assert_eq!(all["after"], json!("c b c b c"));
}

#[test]
fn refuses_an_edit_that_changes_nothing() {
    let fix = setup();
    assert_has(
        &fix.plan_a(json!([{"oldText": "two", "newText": "two"}])),
        json!({"ok": false, "error": "no-change"}),
    );
}

#[test]
fn matches_text_written_with_lf_in_a_crlf_file_and_keeps_crlf() {
    let fix = setup();
    fs::write(fix.project.join("a.txt"), "one\r\ntwo\r\nthree").unwrap();
    let res = fix.plan_a(json!([{"oldText": "one\ntwo", "newText": "one\n2"}]));
    assert_eq!(res["ok"], json!(true));
    assert_eq!(res["after"], json!("one\r\n2\r\nthree"));
}

#[test]
fn hands_back_the_version_of_the_text_it_planned_on_so_a_later_change_stops_the_write() {
    let fix = setup();
    let path = fix.project.join("a.txt");
    let planned = fix.plan_a(json!([{"oldText": "two", "newText": "2"}]));
    assert_eq!(planned["ok"], json!(true), "no plan");
    let read = fix.read(fix.target(&path, false));
    assert_eq!(read["ok"], json!(true));
    assert_eq!(read["version"], planned["version"]);
    fs::write(&path, "one\ntwo\nchanged by someone else").unwrap();
    assert_has(
        &fix.write(merge(
            fix.in_folder(&path),
            json!({"content": planned["after"], "base": planned["version"]}),
        )),
        json!({"ok": false, "error": "changed"}),
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "one\ntwo\nchanged by someone else"
    );
}

#[test]
fn needs_an_existing_regular_text_file_under_the_size_cap() {
    let fix = setup();
    let edit = json!([{"oldText": "a", "newText": "b"}]);
    assert_has(
        &fix.plan(edit.clone(), &fix.project.join("nope.txt"), false),
        json!({"ok": false, "error": "not-found"}),
    );
    symlink(fix.project.join("a.txt"), fix.project.join("l.txt")).unwrap();
    assert_has(
        &fix.plan(edit.clone(), &fix.project.join("l.txt"), false),
        json!({"ok": false, "error": "not-a-file"}),
    );
    fs::write(fix.project.join("bin"), [97u8, 0, 98]).unwrap();
    assert_has(
        &fix.plan(edit.clone(), &fix.project.join("bin"), false),
        json!({"ok": false, "error": "binary"}),
    );
    fs::write(fix.project.join("big.txt"), "a".repeat(CHAT_WRITE_MAX + 1)).unwrap();
    assert_has(
        &fix.plan(edit, &fix.project.join("big.txt"), false),
        json!({"ok": false, "error": "too-large"}),
    );
    fs::write(fix.project.join("grows.txt"), "a").unwrap();
    assert_has(
        &fix.plan(
            json!([{"oldText": "a", "newText": "b".repeat(CHAT_WRITE_MAX + 1)}]),
            &fix.project.join("grows.txt"),
            false,
        ),
        json!({"ok": false, "error": "too-large"}),
    );
}

#[test]
fn refuses_empty_or_malformed_edit_lists_and_paths_outside_the_roots() {
    let fix = setup();
    assert_has(
        &fix.plan_a(json!([])),
        json!({"ok": false, "error": "invalid"}),
    );
    assert_has(
        &fix.plan_a(json!([{"oldText": "", "newText": "x"}])),
        json!({"ok": false, "error": "invalid"}),
    );
    assert_has(
        &fix.plan(
            json!([{"oldText": "a", "newText": "b"}]),
            &fix.outside_roots.join("secret.txt"),
            false,
        ),
        json!({"ok": false, "error": "not-allowed"}),
    );
}

#[test]
fn tells_nothing_about_a_file_outside_the_workspace_folder_until_the_human_allowed_reading_it() {
    let fix = setup();
    let outside_file = fix.other.join("notes.txt");
    assert_eq!(
        fix.plan(
            json!([{"oldText": "nope", "newText": "x"}]),
            &outside_file,
            false
        ),
        json!({"ok": false, "error": "outside-folder", "path": s(&outside_file)})
    );
    assert_has(
        &fix.plan(
            json!([{"oldText": "private", "newText": "public"}]),
            &outside_file,
            true,
        ),
        json!({"ok": true, "outside": true}),
    );
}

#[test]
fn refuses_a_text_file_that_is_not_utf_8_instead_of_rewriting_its_bytes() {
    let fix = setup();
    let path = fix.project.join("a.txt");
    fs::write(&path, [0x63u8, 0x61, 0x66, 0xe9, 0x0a]).unwrap();
    assert_has(
        &fix.plan_a(json!([{"oldText": "caf", "newText": "bar"}])),
        json!({"ok": false, "error": "binary"}),
    );
    assert_has(
        &fix.preview_of(&path),
        json!({"ok": false, "error": "binary"}),
    );
}

#[test]
fn finds_unsaved_edits_to_the_same_file_opened_through_a_symlinked_folder() {
    let fix = setup();
    symlink(&fix.project, fix.home.join("shortcut")).unwrap();
    let opened = fix.home.join("shortcut").join("a.txt");
    let res = fix.plan_request(json!({
        "path": s(fix.project.join("a.txt")),
        "root": s(&fix.project),
        "edits": [{"oldText": "two", "newText": "2"}],
        "outside": false,
        "dirty": [s(&opened)],
    }));
    assert_has(&res, json!({"ok": true, "unsaved": true}));
    assert_has(
        &fix.preview(json!({
            "path": s(&opened),
            "root": s(&fix.project),
            "dirty": [s(fix.project.join("a.txt"))],
        })),
        json!({"ok": true, "unsaved": true}),
    );
}

#[test]
fn does_not_count_other_files_paths_outside_the_roots_or_junk_as_unsaved() {
    let fix = setup();
    let res = fix.preview(json!({
        "path": s(fix.project.join("a.txt")),
        "root": s(&fix.project),
        "dirty": [
            s(fix.project.join("b.txt")),
            s(fix.outside_roots.join("secret.txt")),
            7,
            "",
        ],
    }));
    assert_has(&res, json!({"ok": true, "unsaved": false}));
}

#[test]
fn restores_the_previous_content_while_the_file_is_still_what_was_written() {
    let fix = setup();
    let path = fix.project.join("a.txt");
    assert_has(
        &fix.restore(&path, json!(version(A_TEXT)), json!("before"), json!({})),
        json!({"ok": true, "removed": false, "version": version("before")}),
    );
    assert_eq!(fix.a_text(), "before");
}

#[test]
fn removes_a_file_the_chat_created_and_brings_back_one_it_removed() {
    let fix = setup();
    let path = fix.project.join("made.txt");
    fs::write(&path, "made").unwrap();
    assert_has(
        &fix.restore(&path, json!(version("made")), Value::Null, json!({})),
        json!({"ok": true, "removed": true, "version": null}),
    );
    assert!(!path.exists());
    assert_has(
        &fix.restore(&path, Value::Null, json!("made"), json!({})),
        json!({"ok": true, "version": version("made")}),
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "made");
}

#[test]
fn leaves_the_file_alone_when_it_changed_appeared_or_vanished_after_the_write() {
    let fix = setup();
    let path = fix.project.join("a.txt");
    assert_has(
        &fix.restore(
            &path,
            json!(version("what ostia wrote")),
            json!("x"),
            json!({}),
        ),
        json!({"ok": false, "error": "changed"}),
    );
    assert_has(
        &fix.restore(&path, Value::Null, json!("x"), json!({})),
        json!({"ok": false, "error": "changed"}),
    );
    assert_eq!(fix.a_text(), A_TEXT);
    assert_has(
        &fix.restore(
            &fix.project.join("gone.txt"),
            json!(version("x")),
            Value::Null,
            json!({}),
        ),
        json!({"ok": false, "error": "changed"}),
    );
}

#[test]
fn only_checks_when_asked_to_and_writes_nothing_then() {
    let fix = setup();
    let path = fix.project.join("a.txt");
    let now = json!(version(A_TEXT));
    assert_has(
        &fix.restore(&path, now.clone(), json!("x"), json!({"check": true})),
        json!({"ok": true, "version": version("x")}),
    );
    assert_has(
        &fix.restore(&path, now, Value::Null, json!({"check": true})),
        json!({"ok": true, "removed": true}),
    );
    assert_eq!(fix.a_text(), A_TEXT);
}

#[test]
fn refuses_a_file_with_unsaved_editor_edits_also_opened_through_a_symlinked_folder() {
    let fix = setup();
    symlink(&fix.project, fix.home.join("shortcut")).unwrap();
    let path = fix.project.join("a.txt");
    assert_has(
        &fix.restore(
            &path,
            json!(version(A_TEXT)),
            json!("x"),
            json!({"dirty": [s(fix.home.join("shortcut").join("a.txt"))]}),
        ),
        json!({"ok": false, "error": "unsaved"}),
    );
    assert_eq!(fix.a_text(), A_TEXT);
}

#[test]
fn stays_inside_the_workspace_folder_unless_the_human_allowed_outside() {
    let fix = setup();
    let path = fix.other.join("notes.txt");
    assert_has(
        &fix.restore(
            &path,
            json!(version("private notes")),
            json!("x"),
            json!({}),
        ),
        json!({"ok": false, "error": "outside-folder"}),
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "private notes");
}

#[test]
fn refuses_a_path_through_a_symlink_unless_the_human_allowed_symlinks() {
    let fix = setup();
    fs::create_dir(fix.project.join("real")).unwrap();
    fs::write(fix.project.join("real").join("c.txt"), "c").unwrap();
    symlink(fix.project.join("real"), fix.project.join("alias")).unwrap();
    let aliased = fix.project.join("alias").join("c.txt");
    assert_has(
        &fix.restore(&aliased, json!(version("c")), json!("x"), json!({})),
        json!({"ok": false, "error": "through-symlink"}),
    );
    assert_has(
        &fix.restore(&aliased, json!(version("c")), Value::Null, json!({})),
        json!({"ok": false, "error": "through-symlink"}),
    );
    assert_eq!(
        fs::read_to_string(fix.project.join("real").join("c.txt")).unwrap(),
        "c"
    );
    assert_has(
        &fix.restore(
            &aliased,
            json!(version("c")),
            json!("x"),
            json!({"symlinks": true}),
        ),
        json!({"ok": true}),
    );
    assert_eq!(
        fs::read_to_string(fix.project.join("real").join("c.txt")).unwrap(),
        "x"
    );
}

#[test]
fn refuses_a_symlinked_file_itself_even_when_symlinks_are_allowed() {
    let fix = setup();
    symlink(fix.project.join("a.txt"), fix.project.join("l.txt")).unwrap();
    assert_has(
        &fix.restore(
            &fix.project.join("l.txt"),
            Value::Null,
            json!("x"),
            json!({}),
        ),
        json!({"ok": false, "error": "through-symlink"}),
    );
    assert_has(
        &fix.restore(
            &fix.project.join("l.txt"),
            json!(version(A_TEXT)),
            json!("x"),
            json!({"symlinks": true}),
        ),
        json!({"ok": false, "error": "not-a-file"}),
    );
    assert_eq!(fix.a_text(), A_TEXT);
}

#[test]
fn refuses_content_over_the_size_cap_and_accepts_exactly_the_cap() {
    let fix = setup();
    let path = fix.project.join("a.txt");
    let now = json!(version(A_TEXT));
    let over = json!("x".repeat(CHAT_WRITE_MAX + 1));
    assert_has(
        &fix.restore(&path, now.clone(), over.clone(), json!({})),
        json!({"ok": false, "error": "too-large"}),
    );
    assert_has(
        &fix.restore(&path, now.clone(), over, json!({"check": true})),
        json!({"ok": false, "error": "too-large"}),
    );
    assert_eq!(fix.a_text(), A_TEXT);
    assert_has(
        &fix.restore(&path, now, json!("x".repeat(CHAT_WRITE_MAX)), json!({})),
        json!({"ok": true}),
    );
    assert_eq!(fix.a_text().len(), CHAT_WRITE_MAX);
}

#[test]
fn refuses_content_that_is_not_a_string() {
    let fix = setup();
    let path = fix.project.join("a.txt");
    assert_has(
        &fix.restore(&path, json!(version(A_TEXT)), json!(7), json!({})),
        json!({"ok": false, "error": "too-large"}),
    );
    assert_eq!(fix.a_text(), A_TEXT);
}

#[test]
fn refuses_to_create_a_file_whose_real_folder_lies_outside_the_roots() {
    let fix = setup();
    symlink(&fix.outside_roots, fix.project.join("escape")).unwrap();
    assert_has(
        &fix.restore(
            &fix.project.join("escape").join("new.txt"),
            Value::Null,
            json!("x"),
            json!({"outside": true, "symlinks": true}),
        ),
        json!({"ok": false, "error": "not-allowed"}),
    );
    assert!(!fix.outside_roots.join("new.txt").exists());
}

#[test]
fn hashes_text_and_bytes_to_the_same_sha256_hex() {
    assert_eq!(
        version_of(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(version_of("é".as_bytes()), version_of(&[0xc3, 0xa9]));
}

#[test]
fn refuses_an_empty_a_missing_or_a_too_long_path_as_invalid() {
    let fix = setup();
    let too_long = format!("/{}", "a".repeat(4096));
    for path in [json!(""), Value::Null, json!(too_long)] {
        assert_has(
            &fix.read(json!({"path": path, "root": s(&fix.project), "outside": false})),
            json!({"ok": false, "error": "invalid"}),
        );
    }
    assert_eq!(
        fix.read(json!({"root": s(&fix.project), "outside": false})),
        json!({"ok": false, "error": "invalid"})
    );
    assert_eq!(
        fix.read(json!({"path": "rel.txt", "root": s(&fix.project), "outside": false})),
        json!({"ok": false, "error": "invalid", "path": "rel.txt"})
    );
}

#[test]
fn reports_not_found_for_a_missing_file_a_folder_for_read_and_a_file_for_list_and_search() {
    let fix = setup();
    assert_has(
        &fix.read(fix.target(&fix.project.join("missing.txt"), false)),
        json!({"ok": false, "error": "not-found"}),
    );
    assert_has(
        &fix.read(fix.target(&fix.project, false)),
        json!({"ok": false, "error": "not-a-file"}),
    );
    assert_has(
        &fix.list(fix.target(&fix.project.join("a.txt"), false)),
        json!({"ok": false, "error": "not-a-directory"}),
    );
    assert_has(
        &fix.list(fix.target(&fix.project.join("missing"), false)),
        json!({"ok": false, "error": "not-found"}),
    );
    assert_has(
        &fix.search(merge(
            fix.target(&fix.project.join("a.txt"), false),
            json!({"query": "one"}),
        )),
        json!({"ok": false, "error": "not-a-directory"}),
    );
    assert_has(
        &fix.search(merge(
            fix.target(&fix.project.join("missing"), false),
            json!({"query": "one"}),
        )),
        json!({"ok": false, "error": "not-found"}),
    );
}

#[test]
fn clamps_the_line_offset_and_limit_and_reports_the_totals() {
    let fix = setup();
    let path = fix.project.join("a.txt");
    let ask = |extra: Value| fix.read(merge(fix.target(&path, false), extra));
    assert_has(
        &ask(json!({"offset": 99})),
        json!({"ok": true, "startLine": 4, "endLine": 4, "totalLines": 4, "text": "four", "truncated": false}),
    );
    assert_has(
        &ask(json!({"offset": 0, "limit": 0})),
        json!({"startLine": 1, "endLine": 1, "text": "one", "truncated": true}),
    );
    assert_has(
        &ask(json!({"offset": "x", "limit": "y"})),
        json!({"startLine": 1, "endLine": 4, "totalLines": 4, "truncated": false}),
    );
    assert_has(
        &ask(json!({"offset": 2.9, "limit": 1.9})),
        json!({"startLine": 2, "endLine": 2, "text": "two"}),
    );
    assert_eq!(ask(json!({}))["version"], json!(version(A_TEXT)));
}

#[test]
fn stops_reading_at_the_text_cap_and_marks_the_result_truncated() {
    let fix = setup();
    let path = fix.project.join("long.txt");
    let line = "y".repeat(999);
    fs::write(&path, vec![line.as_str(); 40].join("\n")).unwrap();
    let res = fix.read(fix.target(&path, false));
    assert_has(
        &res,
        json!({"ok": true, "startLine": 1, "endLine": 30, "totalLines": 40, "truncated": true}),
    );
    assert_eq!(res["text"].as_str().unwrap().len(), 30 * 1000 - 1);
}

#[test]
fn lists_at_most_the_cap_and_gives_files_a_size_and_other_things_a_kind() {
    let fix = setup();
    let many = fix.project.join("many");
    fs::create_dir(&many).unwrap();
    for index in 0..=CHAT_LIST_MAX {
        fs::write(many.join(format!("f{index:04}.txt")), "ab").unwrap();
    }
    let res = fix.list(fix.target(&many, false));
    assert_eq!(res["entries"].as_array().unwrap().len(), CHAT_LIST_MAX);
    assert_eq!(res["truncated"], json!(true));
    assert_eq!(
        res["entries"][0],
        json!({"name": "f0000.txt", "kind": "file", "size": 2})
    );
    symlink(fix.project.join("a.txt"), fix.project.join("zlink")).unwrap();
    let small = fix.list(fix.target(&fix.project, false));
    assert_eq!(small["truncated"], json!(false));
    let kinds: Vec<(String, String)> = small["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["name"].as_str().unwrap().to_owned(),
                entry["kind"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        kinds,
        vec![
            ("many".to_owned(), "dir".to_owned()),
            ("node_modules".to_owned(), "dir".to_owned()),
            ("a.txt".to_owned(), "file".to_owned()),
            ("zlink".to_owned(), "other".to_owned()),
        ]
    );
}

#[test]
fn refuses_an_empty_or_too_long_search_query_and_matches_file_names() {
    let fix = setup();
    let ask = |query: Value| {
        fix.search(merge(
            fix.target(&fix.project, false),
            json!({"query": query}),
        ))
    };
    for query in [
        json!(""),
        json!("   "),
        json!(7),
        json!("q".repeat(CHAT_QUERY_MAX + 1)),
    ] {
        assert_eq!(
            ask(query.clone()),
            json!({"ok": false, "error": "invalid"}),
            "{query}"
        );
    }
    let by_name = ask(json!("  A.TXT "));
    assert_eq!(by_name["matches"], json!([{"path": "a.txt"}]));
    assert_eq!(by_name["truncated"], json!(false));
}

#[test]
fn stops_a_search_at_the_match_cap_and_marks_it_truncated() {
    let fix = setup();
    let hits = fix.project.join("hits");
    fs::create_dir(&hits).unwrap();
    for index in 0..(CHAT_SEARCH_MATCHES_MAX + 20) {
        fs::write(hits.join(format!("h{index:04}.txt")), "no\nhit here\n").unwrap();
    }
    let res = fix.search(merge(fix.target(&hits, false), json!({"query": "hit"})));
    assert_eq!(res["ok"], json!(true));
    assert_eq!(
        res["matches"].as_array().unwrap().len(),
        CHAT_SEARCH_MATCHES_MAX
    );
    assert_eq!(res["truncated"], json!(true));
}

#[test]
fn refuses_more_edits_than_the_cap_and_edits_that_are_not_text() {
    let fix = setup();
    let many: Vec<Value> = (0..=CHAT_EDITS_MAX)
        .map(|_| json!({"oldText": "one", "newText": "uno"}))
        .collect();
    assert_has(
        &fix.plan_a(Value::Array(many)),
        json!({"ok": false, "error": "invalid"}),
    );
    assert_has(
        &fix.plan_a(json!([{"oldText": "one", "newText": 5}])),
        json!({"ok": false, "error": "invalid"}),
    );
    assert_has(
        &fix.plan_a(json!([{"oldText": 1, "newText": "x"}])),
        json!({"ok": false, "error": "invalid"}),
    );
    assert_has(
        &fix.plan_a(json!("one")),
        json!({"ok": false, "error": "invalid"}),
    );
}

#[test]
fn refuses_to_write_content_that_is_not_a_string() {
    let fix = setup();
    assert_has(
        &fix.write(merge(
            fix.in_folder(&fix.project.join("a.txt")),
            json!({"content": 7, "base": version(A_TEXT)}),
        )),
        json!({"ok": false, "error": "too-large"}),
    );
    assert_eq!(fix.a_text(), A_TEXT);
}

#[test]
fn accepts_exactly_the_size_cap_on_write_and_counts_bytes_not_characters() {
    let fix = setup();
    let exact = "x".repeat(CHAT_WRITE_MAX);
    assert_has(
        &fix.write(merge(
            fix.in_folder(&fix.project.join("exact.txt")),
            json!({"content": exact, "base": null}),
        )),
        json!({"ok": true, "created": true, "bytes": CHAT_WRITE_MAX}),
    );
    let wide = "é".repeat(CHAT_WRITE_MAX / 2 + 1);
    assert_has(
        &fix.write(merge(
            fix.in_folder(&fix.project.join("wide.txt")),
            json!({"content": wide, "base": null}),
        )),
        json!({"ok": false, "error": "too-large"}),
    );
    assert!(!fix.project.join("wide.txt").exists());
}
