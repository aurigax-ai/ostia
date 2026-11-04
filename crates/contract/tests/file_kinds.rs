#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::capabilities::Capability;
use ostia_contract::file_kinds::{
    BrowseCandidate, BrowseKind, FileKindParseContext, FileKindSelector, FileKindViewPriority,
    KindRoles, browse_kind_for, kind_claim, kind_matches, matches_filename_pattern,
    parse_file_kinds,
};
use regex::Regex;
use serde_json::{Value, json};

fn is_inside(path: &str) -> bool {
    !path.starts_with("..") && !path.starts_with('/')
}

fn inside() -> FileKindParseContext<'static> {
    FileKindParseContext {
        is_inside: &is_inside,
        main: false,
        capabilities: &[],
    }
}

fn browsing() -> FileKindParseContext<'static> {
    FileKindParseContext {
        is_inside: &is_inside,
        main: true,
        capabilities: &[Capability::FileContents],
    }
}

fn sheet() -> Value {
    json!({
        "id": "office.spreadsheet",
        "displayName": "Spreadsheet",
        "selector": [{"filenamePattern": "*.xlsx"}, {"filenamePattern": "*.tar.gz"}],
        "view": {"entry": "sheet.html", "priority": "default"},
    })
}

fn with(mut base: Value, key: &str, value: Value) -> Value {
    base[key] = value;
    base
}

fn without(mut base: Value, key: &str) -> Value {
    base.as_object_mut().unwrap().remove(key);
    base
}

fn parsed(raw: &Value, ext_id: &str, context: &FileKindParseContext) -> Value {
    serde_json::to_value(parse_file_kinds(Some(raw), ext_id, context).unwrap()).unwrap()
}

fn refusal(raw: &Value, ext_id: &str, context: &FileKindParseContext) -> String {
    parse_file_kinds(Some(raw), ext_id, context)
        .err()
        .unwrap_or_default()
}

fn matches(text: &str, pattern: &str) -> bool {
    Regex::new(pattern).unwrap().is_match(text)
}

fn selector(patterns: &[&str]) -> Vec<FileKindSelector> {
    patterns
        .iter()
        .map(|pattern| FileKindSelector {
            filename_pattern: (*pattern).to_owned(),
        })
        .collect()
}

#[test]
fn reads_a_kind_with_a_view_role_defaulting_the_priority() {
    let no_priority = with(sheet(), "view", json!({"entry": "sheet.html"}));
    assert_eq!(
        parsed(&json!([no_priority]), "office", &inside()),
        json!([sheet()])
    );
    assert!(
        parse_file_kinds(None, "office", &inside())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn refuses_an_id_of_another_extension_a_bad_pattern_a_missing_view_or_a_duplicate() {
    let cases: Vec<(Value, &str)> = vec![
        (
            json!([with(sheet(), "id", json!("csv.spreadsheet"))]),
            "id must be 'office.<name>'",
        ),
        (json!([with(sheet(), "id", json!("office.a.b"))]), "id"),
        (
            json!([with(sheet(), "selector", json!([{"filenamePattern": "*"}]))]),
            "filenamePattern",
        ),
        (
            json!([with(
                sheet(),
                "selector",
                json!([{"filenamePattern": "a/b.xlsx"}])
            )]),
            "filenamePattern",
        ),
        (json!([with(sheet(), "selector", json!([]))]), "selector"),
        (
            json!([without(sheet(), "view")]),
            "needs a view or a browse role",
        ),
        (
            json!([with(sheet(), "view", json!("x"))]),
            "view must be an object",
        ),
        (
            json!([with(
                sheet(),
                "view",
                json!({"entry": "sheet.html", "priority": "always"})
            )]),
            "priority",
        ),
        (
            json!([with(sheet(), "view", json!({"entry": "../x.html"}))]),
            "view.entry",
        ),
        (
            json!([with(sheet(), "view", json!({"entry": "sheet.js"}))]),
            "view.entry",
        ),
        (json!([sheet(), sheet()]), "duplicate id"),
        (json!("nope"), "array"),
    ];
    for (raw, problem) in cases {
        let text = refusal(&raw, "office", &inside());
        assert!(matches(&text, problem), "{raw}: {text}");
    }
}

#[test]
fn caps_the_kinds_and_the_patterns_they_claim_in_all() {
    let many: Vec<Value> = (0..17)
        .map(|index| {
            let letter = char::from(b'a' + u8::try_from(index % 26).unwrap());
            with(
                sheet(),
                "id",
                json!(format!("office.k{letter}{}", index / 26)),
            )
        })
        .collect();
    assert!(matches(
        &refusal(&Value::Array(many), "office", &inside()),
        "at most 16"
    ));
    let wide: Vec<Value> = (0..3)
        .map(|index| {
            let patterns: Vec<Value> = (0..22)
                .map(|column| json!({"filenamePattern": format!("*.e{index}x{column}")}))
                .collect();
            with(
                with(sheet(), "id", json!(format!("office.w{index}"))),
                "selector",
                Value::Array(patterns),
            )
        })
        .collect();
    assert!(matches(
        &refusal(&Value::Array(wide), "office", &inside()),
        "at most 64 filename patterns"
    ));
}

fn zip() -> Value {
    json!({
        "id": "archives.zip",
        "displayName": "Zip archive",
        "selector": [{"filenamePattern": "*.zip"}],
        "browse": {},
    })
}

#[test]
fn reads_a_browse_only_kind_and_a_kind_with_both_roles() {
    assert_eq!(
        parsed(&json!([zip()]), "archives", &browsing()),
        json!([zip()])
    );
    let both = with(zip(), "view", json!({"entry": "zip.html"}));
    assert_eq!(
        parsed(&json!([both]), "archives", &browsing()),
        json!([with(
            zip(),
            "view",
            json!({"entry": "zip.html", "priority": "default"})
        )])
    );
}

#[test]
fn needs_a_main_process_and_the_file_contents_capability() {
    let problem = "browse needs a main process and the 'file-contents' capability";
    let raw = json!([zip()]);
    assert!(matches(&refusal(&raw, "archives", &inside()), problem));
    let no_main = FileKindParseContext {
        main: false,
        ..browsing()
    };
    assert!(matches(&refusal(&raw, "archives", &no_main), problem));
    let no_capability = FileKindParseContext {
        capabilities: &[],
        ..browsing()
    };
    assert!(matches(&refusal(&raw, "archives", &no_capability), problem));
}

#[test]
fn refuses_a_kind_with_neither_role() {
    assert!(matches(
        &refusal(&json!([without(zip(), "browse")]), "archives", &browsing()),
        "needs a view or a browse role"
    ));
}

#[test]
fn refuses_a_browse_role_that_is_not_an_object() {
    assert!(matches(
        &refusal(
            &json!([with(zip(), "browse", json!(true))]),
            "archives",
            &browsing()
        ),
        "browse must be an object"
    ));
}

fn roles(
    id: &str,
    patterns: &[&str],
    view: Option<FileKindViewPriority>,
    browse: bool,
) -> KindRoles {
    KindRoles {
        id: id.to_owned(),
        selector: selector(patterns),
        view,
        browse,
    }
}

#[test]
fn claims_the_browse_role_apart_from_the_view_role() {
    let browse_only = roles("archives.zip", &["*.zip"], None, true);
    let both = roles(
        "archives.zip",
        &["*.zip"],
        Some(FileKindViewPriority::Default),
        true,
    );
    let view_only = roles(
        "archives.zip",
        &["*.zip"],
        Some(FileKindViewPriority::Default),
        false,
    );
    assert_eq!(kind_claim(&browse_only), "archives.zip:browse:*.zip");
    assert_eq!(kind_claim(&both), "archives.zip:view:default+browse:*.zip");
    assert_ne!(kind_claim(&view_only), kind_claim(&both));
}

fn candidate(ext_id: &str, builtin: bool, id: &str, patterns: &[&str]) -> BrowseCandidate {
    BrowseCandidate {
        ext_id: ext_id.to_owned(),
        builtin,
        kind: BrowseKind {
            id: id.to_owned(),
            selector: selector(patterns),
        },
    }
}

#[test]
fn serves_a_file_from_one_kind_builtin_then_the_longest_pattern_then_the_extension_id() {
    let gz = candidate("zz", false, "zz.gz", &["*.gz"]);
    let tar_gz = candidate("aa", false, "aa.tar", &["*.tar.gz"]);
    let builtin = candidate("archives", true, "archives.gz", &["*.gz"]);
    let other = candidate("b", false, "b.x", &["*.gz"]);
    let id_of = |path: &str, list: &[&BrowseCandidate]| {
        browse_kind_for(path, list).map(|found| found.kind.id.clone())
    };
    assert_eq!(
        id_of("/w/a.tar.gz", &[&gz, &tar_gz]).as_deref(),
        Some("aa.tar")
    );
    assert_eq!(
        id_of("/w/a.tar.gz", &[&gz, &tar_gz, &builtin]).as_deref(),
        Some("archives.gz")
    );
    assert_eq!(
        browse_kind_for("/w/a.gz", &[&other, &gz]).map(|found| found.ext_id.as_str()),
        Some("b")
    );
    assert!(browse_kind_for("/w/a.txt", &[&gz]).is_none());
}

fn spreadsheet(view: Option<FileKindViewPriority>) -> KindRoles {
    roles("office.spreadsheet", &["*.XLSX", "*.ods"], view, false)
}

#[test]
fn names_the_id_the_role_the_priority_and_the_sorted_lowercase_patterns() {
    let kind = spreadsheet(Some(FileKindViewPriority::Option));
    assert_eq!(
        kind_claim(&kind),
        "office.spreadsheet:view:option:*.ods,*.xlsx"
    );
    let reversed = roles(
        "office.spreadsheet",
        &["*.ods", "*.XLSX"],
        Some(FileKindViewPriority::Option),
        false,
    );
    assert_eq!(kind_claim(&reversed), kind_claim(&kind));
}

#[test]
fn is_a_new_claim_when_the_selector_widens_or_an_option_view_becomes_the_default_opener() {
    let kind = spreadsheet(Some(FileKindViewPriority::Option));
    let widened = roles(
        "office.spreadsheet",
        &["*.XLSX", "*.ods", "*.csv"],
        Some(FileKindViewPriority::Option),
        false,
    );
    assert_ne!(kind_claim(&widened), kind_claim(&kind));
    assert_ne!(
        kind_claim(&spreadsheet(Some(FileKindViewPriority::Default))),
        kind_claim(&kind)
    );
}

#[test]
fn lists_a_repeated_pattern_once_in_a_claim() {
    let twice = roles(
        "office.spreadsheet",
        &["*.ods", "*.ODS"],
        Some(FileKindViewPriority::Option),
        false,
    );
    assert_eq!(kind_claim(&twice), "office.spreadsheet:view:option:*.ods");
}

#[test]
fn matches_base_names_by_suffix_or_exactly_without_case() {
    assert!(matches_filename_pattern("/w/Report.XLSX", "*.xlsx"));
    assert!(matches_filename_pattern("/w/src.tar.gz", "*.tar.gz"));
    assert!(!matches_filename_pattern("/w/.xlsx", "*.xlsx"));
    assert!(!matches_filename_pattern("/w/a.xlsx.txt", "*.xlsx"));
    assert!(matches_filename_pattern("/w/Makefile", "makefile"));
    assert!(matches_filename_pattern(
        "archive:%2Fw%2Fa.zip!/data/b.csv",
        "*.csv"
    ));
    assert!(!kind_matches("/w/a.csv", &selector(&["*.tsv"])));
}

#[test]
fn reads_the_base_name_after_a_backslash_and_matches_a_whole_name_only() {
    assert!(matches_filename_pattern("C:\\w\\Report.XLSX", "*.xlsx"));
    assert!(!matches_filename_pattern("/w/xMakefile", "makefile"));
    assert!(kind_matches("/w/a.csv", &selector(&["*.tsv", "*.csv"])));
}
