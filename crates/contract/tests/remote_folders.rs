#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::remote_folders::{
    FOLDER_CLOSED_EVENT, REMOTE_ENTRIES_MAX, REMOTE_FILE_ERRORS, REMOTE_FILE_MAX_BYTES,
    REMOTE_FOLDER_ID_PATTERN, REMOTE_FOLDERS_PER_WORKSPACE, REMOTE_HOST_NAME_PATTERN,
    REMOTE_HOST_PATTERN, REMOTE_NAME_MAX, REMOTE_PATH_MAX, REMOTE_SCHEME, REMOTE_VERSION_PATTERN,
    REMOTE_WRITE_ANY, REMOTE_WRITE_NEW, is_inside_root, is_remote_name, is_remote_path,
    normalize_remote_cwd, normalize_remote_listing, normalize_remote_path, normalize_remote_read,
    normalize_remote_stat, normalize_remote_write, parse_remote_path, remote_child, remote_path,
    utf8_length,
};
use serde::Serialize;
use serde_json::{Value, json};

fn wire<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn wire_option<T: Serialize>(value: Option<T>) -> Value {
    value.map_or(Value::Null, wire)
}

fn path_of(value: Value) -> Value {
    normalize_remote_path(&value).map_or(Value::Null, Value::String)
}

#[test]
fn keeps_an_absolute_path_dropping_empty_and_dot_segments() {
    assert_eq!(path_of(json!("/srv/app")), json!("/srv/app"));
    assert_eq!(path_of(json!("/srv//app/./x/")), json!("/srv/app/x"));
    assert_eq!(path_of(json!("/")), json!("/"));
    assert_eq!(path_of(json!("/a b/é")), json!("/a b/é"));
}

#[test]
fn ssh_c62_refuses_a_relative_path_a_parent_segment_control_characters_and_oversize() {
    let long = format!("/{}", "x".repeat(5000));
    let bad = [
        json!("srv/app"),
        json!(""),
        json!("/srv/../etc"),
        json!("/.."),
        json!("/a\nb"),
        json!("/a\u{0}b"),
        json!("/a\u{7f}b"),
        json!("/a\u{fffd}b"),
        json!(long),
        json!(42),
        json!(null),
    ];
    for value in bad {
        assert_eq!(path_of(value.clone()), Value::Null, "{value}");
    }
}

#[test]
fn round_trips_a_folder_id_and_a_path_and_tells_remote_paths_from_local_ones() {
    let path = remote_path("abcdef012345", "/srv/app/a b.txt");
    assert_eq!(path, "remote://abcdef012345/srv/app/a b.txt");
    assert_eq!(
        wire_option(parse_remote_path(&json!(path))),
        json!({ "folderId": "abcdef012345", "path": "/srv/app/a b.txt" })
    );
    assert!(is_remote_path(Some(&path)));
    assert!(!is_remote_path(Some("/home/me/file")));
    assert!(!is_remote_path(None));
    assert_eq!(
        remote_child("remote://abcdef012345/srv", "x"),
        "remote://abcdef012345/srv/x"
    );
    assert_eq!(
        remote_child("remote://abcdef012345/", "x"),
        "remote://abcdef012345/x"
    );
}

#[test]
fn ssh_c62_refuses_a_bad_folder_id_a_missing_path_and_a_path_that_climbs() {
    let bad = [
        json!("remote://short/srv"),
        json!("remote://ABCDEF012345/srv"),
        json!("remote://abcdef012345"),
        json!("remote://abcdef012345/srv/../../etc"),
        json!("file:///etc/passwd"),
        json!("/etc/passwd"),
        json!(7),
    ];
    for value in bad {
        assert_eq!(
            wire_option(parse_remote_path(&value)),
            Value::Null,
            "{value}"
        );
    }
}

#[test]
fn knows_what_is_inside_a_root() {
    assert!(is_inside_root("/srv/app", "/srv/app"));
    assert!(is_inside_root("/srv/app", "/srv/app/x"));
    assert!(!is_inside_root("/srv/app", "/srv/application"));
    assert!(!is_inside_root("/srv/app", "/srv"));
    assert!(is_inside_root("/", "/anything"));
}

#[test]
fn ssh_c61_keeps_a_plain_host_name_and_an_absolute_folder() {
    assert_eq!(
        wire_option(normalize_remote_cwd(
            &json!({ "host": "db1.internal", "cwd": "/srv/app/" })
        )),
        json!({ "host": "db1.internal", "cwd": "/srv/app" })
    );
}

#[test]
fn refuses_a_host_with_odd_characters_a_relative_folder_and_anything_that_is_not_an_object() {
    let bad = [
        json!({ "host": "db 1", "cwd": "/srv" }),
        json!({ "host": "db;rm", "cwd": "/srv" }),
        json!({ "host": "", "cwd": "/srv" }),
        json!({ "host": "db", "cwd": "srv" }),
        json!({ "host": "db", "cwd": "/a/../b" }),
        json!("db:/srv"),
        json!(null),
    ];
    for value in bad {
        assert_eq!(
            wire_option(normalize_remote_cwd(&value)),
            Value::Null,
            "{value}"
        );
    }
}

#[test]
fn ssh_c63_keeps_plain_names_once_drops_the_rest_and_cuts_a_long_listing() {
    let entries = json!([
        { "name": "a.txt", "dir": false },
        { "name": "src", "dir": true },
        { "name": "a.txt", "dir": true },
        { "name": "x/y", "dir": false },
        { "name": "..", "dir": true },
        { "name": ".", "dir": true },
        { "name": "", "dir": false },
        { "name": "bell\u{7}", "dir": false },
        { "name": "bad\u{fffd}bytes", "dir": false },
        { "name": "n".repeat(300), "dir": false },
        { "name": 5 },
        null,
        "text",
        { "name": "kind", "dir": "yes" },
    ]);
    assert_eq!(
        wire(normalize_remote_listing(
            &json!({ "ok": true, "entries": entries })
        )),
        json!({
            "ok": true,
            "entries": [
                { "name": "a.txt", "dir": false },
                { "name": "src", "dir": true },
                { "name": "kind", "dir": false },
            ],
            "truncated": false,
        })
    );
    let many: Vec<Value> = (0..6000)
        .map(|i| json!({ "name": format!("f{i}"), "dir": false }))
        .collect();
    let cut = wire(normalize_remote_listing(
        &json!({ "ok": true, "entries": many }),
    ));
    assert_eq!(cut["ok"], json!(true));
    assert_eq!(cut["entries"].as_array().unwrap().len(), REMOTE_ENTRIES_MAX);
    assert_eq!(cut["truncated"], json!(true));
    assert_eq!(
        wire(normalize_remote_listing(
            &json!({ "ok": true, "entries": "no" })
        )),
        json!({ "ok": false, "error": "failed" })
    );
}

#[test]
fn ssh_c63_refuses_content_with_nul_oversize_content_and_a_version_that_is_not_a_token() {
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": true, "content": "héllo", "version": "12-6" })
        )),
        json!({ "ok": true, "content": "héllo", "version": "12-6" })
    );
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": true, "content": "a\u{0}b", "version": "1-3" })
        )),
        json!({ "ok": false, "error": "binary" })
    );
    assert_eq!(
        wire(normalize_remote_read(&json!({
            "ok": true,
            "content": "x".repeat(REMOTE_FILE_MAX_BYTES + 1),
            "version": "1-3",
        }))),
        json!({ "ok": false, "error": "too-large" })
    );
    assert_eq!(
        wire(normalize_remote_read(&json!({
            "ok": true,
            "content": "好".repeat(REMOTE_FILE_MAX_BYTES / 3 + 1),
            "version": "1-3",
        }))),
        json!({ "ok": false, "error": "too-large" })
    );
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": true, "content": "x", "version": "has space" })
        )),
        json!({ "ok": false, "error": "failed" })
    );
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": true, "content": 7, "version": "1-1" })
        )),
        json!({ "ok": false, "error": "failed" })
    );
    assert_eq!(
        wire(normalize_remote_write(
            &json!({ "ok": true, "version": "9-9" })
        )),
        json!({ "ok": true, "version": "9-9" })
    );
    assert_eq!(
        wire(normalize_remote_write(
            &json!({ "ok": true, "version": "<script>" })
        )),
        json!({ "ok": false, "error": "failed" })
    );
    assert_eq!(
        wire(normalize_remote_stat(
            &json!({ "ok": true, "kind": "file", "version": "1-1" })
        )),
        json!({ "ok": true, "kind": "file", "version": "1-1" })
    );
    assert_eq!(
        wire(normalize_remote_stat(
            &json!({ "ok": true, "kind": "file", "version": "a b" })
        )),
        json!({ "ok": true, "kind": "file" })
    );
    assert_eq!(
        wire(normalize_remote_stat(
            &json!({ "ok": true, "kind": "dir", "version": "1-1" })
        )),
        json!({ "ok": true, "kind": "dir" })
    );
    assert_eq!(
        wire(normalize_remote_stat(
            &json!({ "ok": true, "kind": "socket" })
        )),
        json!({ "ok": false, "error": "failed" })
    );
}

#[test]
fn passes_a_known_error_through_and_turns_anything_else_into_failed() {
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": false, "error": "not-found" })
        )),
        json!({ "ok": false, "error": "not-found" })
    );
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": false, "error": "<b>boom</b>" })
        )),
        json!({ "ok": false, "error": "failed" })
    );
    assert_eq!(
        wire(normalize_remote_listing(&json!(null))),
        json!({ "ok": false, "error": "failed" })
    );
    assert_eq!(
        wire(normalize_remote_write(&json!("ok"))),
        json!({ "ok": false, "error": "failed" })
    );
}

#[test]
fn drops_a_huge_run_of_repeated_names_without_a_quadratic_scan() {
    let mut items: Vec<Value> = (0..REMOTE_ENTRIES_MAX - 1)
        .map(|i| json!({ "name": format!("f{i}"), "dir": false }))
        .collect();
    items.extend((0..1_000_000).map(|_| json!({ "name": "f4998", "dir": false })));
    let raw = json!({ "ok": true, "entries": items });
    let started = std::time::Instant::now();
    let listing = wire(normalize_remote_listing(&raw));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(
        listing["entries"].as_array().unwrap().len(),
        REMOTE_ENTRIES_MAX - 1
    );
    assert_eq!(listing["truncated"], json!(false));
}

#[test]
fn counts_utf_8_bytes_like_an_encoder() {
    let encoder_lengths = [
        ("", 0),
        ("abc", 3),
        ("é", 2),
        ("好", 3),
        ("😀", 4),
        ("a😀好é", 10),
    ];
    for (text, expected) in encoder_lengths {
        assert_eq!(utf8_length(text), expected, "{text}");
    }
}

#[test]
fn has_the_limits_patterns_and_names_the_ts_contract_has() {
    assert_eq!(REMOTE_SCHEME, "remote://");
    assert_eq!(REMOTE_PATH_MAX, 4096);
    assert_eq!(REMOTE_NAME_MAX, 255);
    assert_eq!(REMOTE_ENTRIES_MAX, 5000);
    assert_eq!(REMOTE_FILE_MAX_BYTES, 2 * 1024 * 1024);
    assert_eq!(REMOTE_FOLDERS_PER_WORKSPACE, 8);
    assert_eq!(FOLDER_CLOSED_EVENT, "folder.closed");
    assert_eq!(REMOTE_WRITE_ANY, "any");
    assert_eq!(REMOTE_WRITE_NEW, "new");
    assert_eq!(
        REMOTE_FILE_ERRORS,
        [
            "unknown-folder",
            "invalid-path",
            "not-found",
            "not-file",
            "not-dir",
            "too-large",
            "binary",
            "changed",
            "denied",
            "outside",
            "read-only",
            "unavailable",
            "failed",
        ]
    );
    let accepts = |pattern: &regex::Regex, text: &str| pattern.is_match(text);
    assert!(accepts(&REMOTE_FOLDER_ID_PATTERN, "abcdef012345"));
    assert!(!accepts(&REMOTE_FOLDER_ID_PATTERN, "abcdef01234"));
    assert!(!accepts(&REMOTE_FOLDER_ID_PATTERN, "abcdef0123456"));
    assert!(!accepts(&REMOTE_FOLDER_ID_PATTERN, "abcdef01234\n"));
    assert!(!accepts(&REMOTE_FOLDER_ID_PATTERN, "abcdef01234é"));
    assert!(accepts(&REMOTE_HOST_PATTERN, "me@db1.internal:22"));
    assert!(!accepts(&REMOTE_HOST_PATTERN, "db 1"));
    assert!(!accepts(&REMOTE_HOST_PATTERN, &"h".repeat(331)));
    assert!(accepts(&REMOTE_HOST_PATTERN, &"h".repeat(330)));
    assert!(accepts(&REMOTE_HOST_NAME_PATTERN, &"h".repeat(253)));
    assert!(!accepts(&REMOTE_HOST_NAME_PATTERN, &"h".repeat(254)));
    assert!(!accepts(&REMOTE_HOST_NAME_PATTERN, "me@db1"));
    assert!(accepts(&REMOTE_VERSION_PATTERN, "12-6"));
    assert!(accepts(&REMOTE_VERSION_PATTERN, "a:b._c-"));
    assert!(!accepts(&REMOTE_VERSION_PATTERN, &"v".repeat(81)));
    assert!(!accepts(&REMOTE_VERSION_PATTERN, ""));
}

#[test]
fn keeps_a_path_of_exactly_the_longest_length_and_refuses_one_unit_more() {
    let longest = format!("/{}", "x".repeat(REMOTE_PATH_MAX - 1));
    assert_eq!(path_of(json!(longest.clone())), json!(longest));
    assert_eq!(path_of(json!(format!("{longest}x"))), Value::Null);
}

#[test]
fn counts_the_path_limit_in_utf_16_units_not_bytes_or_code_points() {
    let wide = format!("/{}", "好".repeat(REMOTE_PATH_MAX - 1));
    assert_eq!(path_of(json!(wide.clone())), json!(wide));
    let astral = format!("/{}", "😀".repeat(REMOTE_PATH_MAX / 2));
    assert_eq!(path_of(json!(astral)), Value::Null);
}

#[test]
fn refuses_every_control_character_below_a_space_and_keeps_a_space() {
    for code in 0..0x20_u32 {
        let path = format!("/a{}b", char::from_u32(code).unwrap());
        assert_eq!(path_of(json!(path)), Value::Null, "{code:#x}");
    }
    assert_eq!(path_of(json!("/a b")), json!("/a b"));
    assert_eq!(path_of(json!("/a\u{80}b")), json!("/a\u{80}b"));
}

#[test]
fn keeps_a_dot_dot_inside_a_longer_segment() {
    assert_eq!(path_of(json!("/a/..b/c..")), json!("/a/..b/c.."));
    assert_eq!(path_of(json!("/a/.../b")), json!("/a/.../b"));
    assert_eq!(path_of(json!("//")), json!("/"));
}

#[test]
fn refuses_a_remote_path_with_an_empty_path_part_and_an_id_with_a_newline() {
    let bad = [
        json!("remote://"),
        json!("remote:///srv"),
        json!("remote://abcdef012345\n/srv"),
        json!(null),
    ];
    for value in bad {
        assert_eq!(
            wire_option(parse_remote_path(&value)),
            Value::Null,
            "{value}"
        );
    }
}

#[test]
fn normalizes_the_path_part_of_a_remote_path() {
    assert_eq!(
        wire_option(parse_remote_path(&json!(
            "remote://abcdef012345//srv/./app/"
        ))),
        json!({ "folderId": "abcdef012345", "path": "/srv/app" })
    );
    assert_eq!(
        wire_option(parse_remote_path(&json!("remote://abcdef012345/"))),
        json!({ "folderId": "abcdef012345", "path": "/" })
    );
}

#[test]
fn tells_a_remote_path_by_its_prefix_alone() {
    assert!(is_remote_path(Some("remote://")));
    assert!(!is_remote_path(Some("Remote://x")));
    assert!(!is_remote_path(Some("")));
}

#[test]
fn refuses_a_remote_cwd_whose_host_or_folder_has_the_wrong_type() {
    let bad = [
        json!({ "cwd": "/srv" }),
        json!({ "host": "db" }),
        json!({ "host": 5, "cwd": "/srv" }),
        json!({ "host": "db", "cwd": 5 }),
        json!({ "host": "me@db", "cwd": "/srv" }),
        json!({ "host": "h".repeat(254), "cwd": "/srv" }),
        json!([]),
        json!(5),
    ];
    for value in bad {
        assert_eq!(
            wire_option(normalize_remote_cwd(&value)),
            Value::Null,
            "{value}"
        );
    }
    assert_eq!(
        wire_option(normalize_remote_cwd(
            &json!({ "host": "h".repeat(253), "cwd": "/", "extra": 1 })
        )),
        json!({ "host": "h".repeat(253), "cwd": "/" })
    );
}

#[test]
fn accepts_a_remote_name_of_the_longest_length_and_refuses_the_rest() {
    assert!(is_remote_name(&json!("a")));
    assert!(is_remote_name(&json!("a".repeat(REMOTE_NAME_MAX))));
    assert!(!is_remote_name(&json!("a".repeat(REMOTE_NAME_MAX + 1))));
    assert!(is_remote_name(&json!("...")));
    assert!(is_remote_name(&json!("a b é 好")));
    for bad in [
        json!(""),
        json!("."),
        json!(".."),
        json!("a/b"),
        json!("a\u{fffd}"),
        json!("a\u{7f}"),
        json!("a\tb"),
        json!(5),
        json!(null),
        json!(true),
    ] {
        assert!(!is_remote_name(&bad), "{bad}");
    }
}

#[test]
fn counts_the_remote_name_limit_in_utf_16_units() {
    assert!(is_remote_name(&json!("好".repeat(REMOTE_NAME_MAX))));
    assert!(is_remote_name(&json!("😀".repeat(REMOTE_NAME_MAX / 2))));
    assert!(!is_remote_name(&json!(
        "😀".repeat(REMOTE_NAME_MAX / 2 + 1)
    )));
}

#[test]
fn a_listing_keeps_the_truncated_flag_the_extension_set() {
    assert_eq!(
        wire(normalize_remote_listing(
            &json!({ "ok": true, "entries": [], "truncated": true })
        )),
        json!({ "ok": true, "entries": [], "truncated": true })
    );
    assert_eq!(
        wire(normalize_remote_listing(
            &json!({ "ok": true, "entries": [], "truncated": "yes" })
        )),
        json!({ "ok": true, "entries": [], "truncated": false })
    );
}

#[test]
fn a_listing_of_exactly_the_most_entries_is_not_truncated() {
    let exact: Vec<Value> = (0..REMOTE_ENTRIES_MAX)
        .map(|i| json!({ "name": format!("f{i}"), "dir": true }))
        .collect();
    let listing = wire(normalize_remote_listing(
        &json!({ "ok": true, "entries": exact }),
    ));
    assert_eq!(
        listing["entries"].as_array().unwrap().len(),
        REMOTE_ENTRIES_MAX - 1
    );
    assert_eq!(listing["truncated"], json!(false));
}

#[test]
fn a_listing_counts_only_kept_entries_toward_the_cut_so_repeats_do_not_truncate() {
    let mut entries: Vec<Value> = (0..REMOTE_ENTRIES_MAX + 10)
        .map(|_| json!({ "name": "same" }))
        .collect();
    entries.push(json!({ "name": "other" }));
    let listing = wire(normalize_remote_listing(
        &json!({ "ok": true, "entries": entries }),
    ));
    assert_eq!(listing["entries"].as_array().unwrap().len(), 2);
    assert_eq!(listing["truncated"], json!(false));
}

#[test]
fn a_reply_counts_as_success_only_when_ok_is_the_boolean_true() {
    for ok in [json!("true"), json!(1), json!(null), json!(false)] {
        assert_eq!(
            wire(normalize_remote_write(
                &json!({ "ok": ok, "version": "1-1" })
            )),
            json!({ "ok": false, "error": "failed" }),
            "{ok}"
        );
    }
    assert_eq!(
        wire(normalize_remote_write(&json!({ "version": "1-1" }))),
        json!({ "ok": false, "error": "failed" })
    );
}

#[test]
fn every_known_error_name_passes_through_and_a_non_string_error_becomes_failed() {
    for name in REMOTE_FILE_ERRORS {
        assert_eq!(
            wire(normalize_remote_stat(
                &json!({ "ok": false, "error": name })
            )),
            json!({ "ok": false, "error": name }),
            "{name}"
        );
    }
    for error in [json!(5), json!(null), json!(["failed"]), json!("Failed")] {
        assert_eq!(
            wire(normalize_remote_stat(
                &json!({ "ok": false, "error": error })
            )),
            json!({ "ok": false, "error": "failed" }),
            "{error}"
        );
    }
    assert_eq!(
        wire(normalize_remote_stat(&json!({ "ok": false }))),
        json!({ "ok": false, "error": "failed" })
    );
    assert_eq!(
        wire(normalize_remote_stat(&json!(null))),
        json!({ "ok": false, "error": "failed" })
    );
}

#[test]
fn a_file_stat_without_a_version_has_no_version_field() {
    assert_eq!(
        wire(normalize_remote_stat(
            &json!({ "ok": true, "kind": "file" })
        )),
        json!({ "ok": true, "kind": "file" })
    );
    assert_eq!(
        wire(normalize_remote_stat(
            &json!({ "ok": true, "kind": "file", "version": 7 })
        )),
        json!({ "ok": true, "kind": "file" })
    );
    assert_eq!(
        wire(normalize_remote_stat(&json!({ "ok": true, "kind": 5 }))),
        json!({ "ok": false, "error": "failed" })
    );
}

#[test]
fn a_read_needs_a_string_content_and_a_version_token() {
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": true, "content": "x" })
        )),
        json!({ "ok": false, "error": "failed" })
    );
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": true, "version": "1-1" })
        )),
        json!({ "ok": false, "error": "failed" })
    );
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": true, "content": "", "version": "0-0" })
        )),
        json!({ "ok": true, "content": "", "version": "0-0" })
    );
}

#[test]
fn a_read_of_exactly_the_most_bytes_is_kept_and_a_replacement_character_is_binary() {
    assert_eq!(
        wire(normalize_remote_read(&json!({
            "ok": true,
            "content": "x".repeat(REMOTE_FILE_MAX_BYTES),
            "version": "1-1",
        })))["ok"],
        json!(true)
    );
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": true, "content": "a\u{fffd}b", "version": "1-1" })
        )),
        json!({ "ok": false, "error": "binary" })
    );
}

#[test]
fn a_read_checks_size_before_binary() {
    let content = format!("\u{0}{}", "x".repeat(REMOTE_FILE_MAX_BYTES));
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": true, "content": content, "version": "1-1" })
        )),
        json!({ "ok": false, "error": "too-large" })
    );
}

#[test]
fn a_read_counts_a_wide_character_as_three_bytes_and_an_astral_one_as_four() {
    let four_byte = "😀".repeat(REMOTE_FILE_MAX_BYTES / 4);
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": true, "content": four_byte, "version": "1-1" })
        ))["ok"],
        json!(true)
    );
    let over = "😀".repeat(REMOTE_FILE_MAX_BYTES / 4 + 1);
    assert_eq!(
        wire(normalize_remote_read(
            &json!({ "ok": true, "content": over, "version": "1-1" })
        )),
        json!({ "ok": false, "error": "too-large" })
    );
}

#[test]
fn a_success_result_keeps_the_ts_field_order() {
    let listing = serde_json::to_string(&normalize_remote_listing(
        &json!({ "ok": true, "entries": [{ "name": "a", "dir": true }] }),
    ))
    .unwrap();
    assert_eq!(
        listing,
        r#"{"ok":true,"entries":[{"name":"a","dir":true}],"truncated":false}"#
    );
    let read = serde_json::to_string(&normalize_remote_read(
        &json!({ "ok": true, "content": "c", "version": "1-1" }),
    ))
    .unwrap();
    assert_eq!(read, r#"{"ok":true,"content":"c","version":"1-1"}"#);
    let stat = serde_json::to_string(&normalize_remote_stat(
        &json!({ "ok": true, "kind": "file", "version": "1-1" }),
    ))
    .unwrap();
    assert_eq!(stat, r#"{"ok":true,"kind":"file","version":"1-1"}"#);
    let failure = serde_json::to_string(&normalize_remote_write(&json!(null))).unwrap();
    assert_eq!(failure, r#"{"ok":false,"error":"failed"}"#);
}
