#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;
use std::time::Duration;

use ostia_base::host::{Host, Platform};
use ostia_files::external_editor::{
    EditorTarget, ExternalEditorRequest, ExternalEditorResult, expand_template,
    open_in_external_editor, resolve_editor_template,
};
use tempfile::TempDir;

fn target(file: &str, line: Option<f64>, column: Option<f64>) -> EditorTarget {
    EditorTarget {
        file: file.to_owned(),
        line,
        column,
    }
}

fn strings(items: &[&str]) -> Option<Vec<String>> {
    Some(items.iter().map(|item| (*item).to_owned()).collect())
}

fn host_with_path(path: &str) -> Host {
    Host {
        env: BTreeMap::from([("PATH".to_owned(), path.to_owned())]),
        home: "/nonexistent-home".into(),
        cwd: "/".into(),
        platform: Platform::current(),
    }
}

fn request(template: Option<&str>, file: &str, line: Option<f64>) -> ExternalEditorRequest {
    ExternalEditorRequest {
        template: template.map(str::to_owned),
        file: file.to_owned(),
        line,
        column: None,
    }
}

#[test]
fn substitutes_file_line_and_column_inside_a_single_argument() {
    assert_eq!(
        expand_template(
            "code -g {file}:{line}:{column}",
            &target("/a/b.ts", Some(12.0), Some(3.0))
        ),
        strings(&["code", "-g", "/a/b.ts:12:3"])
    );
}

#[test]
fn keeps_a_hostile_path_as_one_literal_argv_element_no_shell_parsing() {
    let file = "/tmp/x; rm -rf ~ $(whoami) `id` \"q\" {line}.txt";
    let argv = expand_template("code -g {file}:{line}", &target(file, Some(7.0), None));
    assert_eq!(argv, strings(&["code", "-g", &format!("{file}:7")]));
}

#[test]
fn defaults_line_and_column_to_1_when_missing_or_invalid() {
    assert_eq!(
        expand_template("zed {file}:{line}:{column}", &target("/f", Some(0.0), None)),
        strings(&["zed", "/f:1:1"])
    );
    for (line, column) in [
        (Some(-3.0), Some(-1.0)),
        (Some(1.5), Some(2.5)),
        (Some(f64::NAN), Some(f64::INFINITY)),
        (None, None),
    ] {
        assert_eq!(
            expand_template("zed {file}:{line}:{column}", &target("/f", line, column)),
            strings(&["zed", "/f:1:1"]),
            "line {line:?} column {column:?}"
        );
    }
}

#[test]
fn appends_the_file_when_the_template_has_no_file() {
    assert_eq!(
        expand_template("gedit", &target("/with space/f.txt", None, None)),
        strings(&["gedit", "/with space/f.txt"])
    );
}

#[test]
fn rejects_an_empty_or_malformed_template() {
    assert_eq!(expand_template("   ", &target("/f", None, None)), None);
    assert_eq!(
        expand_template("code '{file}", &target("/f", None, None)),
        None
    );
}

#[test]
fn replaces_every_placeholder_and_leaves_unknown_braces_alone() {
    assert_eq!(
        expand_template(
            "ed {line} {line}+{column} {other} {file}",
            &target("/f", Some(4.0), Some(9.0))
        ),
        strings(&["ed", "4", "4+9", "{other}", "/f"])
    );
}

#[test]
fn counts_a_file_placeholder_in_any_argument_as_having_the_file() {
    assert_eq!(
        expand_template("ed --file={file} -l {line}", &target("/f", Some(2.0), None)),
        strings(&["ed", "--file=/f", "-l", "2"])
    );
}

fn on_path<'a>(bins: &'a [&'a str]) -> impl Fn(&Path) -> bool + 'a {
    move |path| {
        bins.iter()
            .any(|bin| path == Path::new(&format!("/bin/{bin}")))
    }
}

#[test]
fn auto_detects_code_before_cursor_and_zed() {
    assert_eq!(
        resolve_editor_template("auto", "/usr/local/bin:/bin", on_path(&["zed", "code"])),
        Some("code -g {file}:{line}:{column}".to_owned())
    );
    assert_eq!(
        resolve_editor_template("auto", "/bin", on_path(&["zed"])),
        Some("zed {file}:{line}:{column}".to_owned())
    );
    assert_eq!(
        resolve_editor_template("auto", "/bin", on_path(&["zed", "cursor"])),
        Some("cursor -g {file}:{line}:{column}".to_owned())
    );
}

#[test]
fn returns_null_when_auto_finds_nothing_or_the_setting_is_empty() {
    assert_eq!(resolve_editor_template("auto", "/bin", on_path(&[])), None);
    assert_eq!(
        resolve_editor_template("  ", "/bin", on_path(&["code"])),
        None
    );
}

#[test]
fn uses_a_custom_template_verbatim() {
    assert_eq!(
        resolve_editor_template("nvim +{line} {file}", "", on_path(&[])),
        Some("nvim +{line} {file}".to_owned())
    );
}

#[test]
fn trims_the_setting_and_treats_only_the_exact_word_auto_as_auto() {
    assert_eq!(
        resolve_editor_template("  nvim {file}  ", "", on_path(&[])),
        Some("nvim {file}".to_owned())
    );
    assert_eq!(
        resolve_editor_template("  auto ", "/bin", on_path(&["zed"])),
        Some("zed {file}:{line}:{column}".to_owned())
    );
    assert_eq!(
        resolve_editor_template("AUTO", "/bin", on_path(&["zed"])),
        Some("AUTO".to_owned())
    );
}

#[tokio::test]
async fn refuses_a_relative_path() {
    let result = open_in_external_editor(
        &request(Some("true"), "rel.txt", None),
        &host_with_path("/usr/bin"),
    )
    .await;
    assert_eq!(result, ExternalEditorResult::InvalidPath);
}

#[tokio::test]
async fn reports_no_editor_for_an_empty_setting() {
    let result =
        open_in_external_editor(&request(Some(""), "/f", None), &host_with_path("/usr/bin")).await;
    assert_eq!(result, ExternalEditorResult::NoEditor);
}

#[tokio::test]
async fn spawns_the_program_with_argv_and_reports_what_it_ran() {
    let dir = TempDir::new().unwrap();
    let out = dir.path().join("args.txt");
    let script = dir.path().join("fake-editor");
    let partial = dir.path().join("args.txt.partial");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}' && mv '{}' '{}'\n",
            partial.display(),
            partial.display(),
            out.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let file = dir
        .path()
        .join("a b; echo pwned.txt")
        .to_string_lossy()
        .into_owned();
    let script_text = script.to_string_lossy().into_owned();
    let result = open_in_external_editor(
        &request(
            Some(&format!("{script_text} -g {{file}}:{{line}}")),
            &file,
            Some(4.0),
        ),
        &host_with_path("/usr/bin"),
    )
    .await;
    assert_eq!(
        result,
        ExternalEditorResult::Ok {
            argv: vec![script_text, "-g".to_owned(), format!("{file}:4")]
        }
    );
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1000);
    while !out.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the editor wrote nothing"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(fs::read_to_string(&out).unwrap(), format!("-g\n{file}:4\n"));
}

#[tokio::test]
async fn reports_spawn_failed_for_a_missing_program() {
    let result = open_in_external_editor(
        &request(Some("/nonexistent/editor {file}"), "/f", None),
        &host_with_path("/usr/bin"),
    )
    .await;
    assert!(matches!(result, ExternalEditorResult::SpawnFailed { .. }));
}

#[tokio::test]
async fn reports_an_invalid_template_when_the_setting_cannot_be_split() {
    let result = open_in_external_editor(
        &request(Some("code '{file}"), "/f", None),
        &host_with_path("/usr/bin"),
    )
    .await;
    assert_eq!(result, ExternalEditorResult::InvalidTemplate);
}

#[tokio::test]
async fn detects_the_editor_on_the_path_of_the_host_when_the_template_is_absent() {
    let bin = TempDir::new().unwrap();
    symlink("/usr/bin/true", bin.path().join("zed")).unwrap();
    let host = host_with_path(&bin.path().to_string_lossy());
    let result = open_in_external_editor(&request(None, "/f", None), &host).await;
    assert_eq!(
        result,
        ExternalEditorResult::Ok {
            argv: vec!["zed".to_owned(), "/f:1:1".to_owned()]
        }
    );
}

#[tokio::test]
async fn reports_no_editor_when_auto_finds_nothing_on_the_path_of_the_host() {
    let bin = TempDir::new().unwrap();
    let host = host_with_path(&bin.path().to_string_lossy());
    let result = open_in_external_editor(&request(Some("auto"), "/f", None), &host).await;
    assert_eq!(result, ExternalEditorResult::NoEditor);
}
