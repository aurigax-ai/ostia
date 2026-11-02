#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;

use ostia_cli::common::pane_token::pane_token;
use ostia_testkit::temp_host;

#[test]
fn ksh_c72_reads_a_kept_pane_token_from_its_file_each_time_so_a_rotated_token_is_used() {
    let (dir, mut host) = temp_host().unwrap();
    let file = dir.path().join("token");
    fs::write(&file, "first\n").unwrap();
    host.env.insert(
        "OSTIA_TOKEN_FILE".to_owned(),
        file.to_string_lossy().into_owned(),
    );
    assert_eq!(pane_token(&host).as_deref(), Some("first"));
    fs::write(&file, "second").unwrap();
    assert_eq!(pane_token(&host).as_deref(), Some("second"));
}

#[test]
fn prefers_ostia_token_and_has_no_token_when_the_file_is_missing_or_empty() {
    let (dir, mut host) = temp_host().unwrap();
    let empty = dir.path().join("empty");
    fs::write(&empty, "").unwrap();
    host.env
        .insert("OSTIA_TOKEN".to_owned(), "direct".to_owned());
    host.env.insert(
        "OSTIA_TOKEN_FILE".to_owned(),
        empty.to_string_lossy().into_owned(),
    );
    assert_eq!(pane_token(&host).as_deref(), Some("direct"));
    host.env.remove("OSTIA_TOKEN");
    assert_eq!(pane_token(&host), None);
    host.env.insert(
        "OSTIA_TOKEN_FILE".to_owned(),
        dir.path().join("missing").to_string_lossy().into_owned(),
    );
    assert_eq!(pane_token(&host), None);
    host.env.remove("OSTIA_TOKEN_FILE");
    assert_eq!(pane_token(&host), None);
}

#[test]
fn falls_back_to_the_file_when_ostia_token_is_empty_and_trims_the_file_text_as_javascript_does() {
    let (dir, mut host) = temp_host().unwrap();
    let file = dir.path().join("token");
    fs::write(&file, "\u{feff} \t kept \r\n").unwrap();
    host.env.insert("OSTIA_TOKEN".to_owned(), String::new());
    host.env.insert(
        "OSTIA_TOKEN_FILE".to_owned(),
        file.to_string_lossy().into_owned(),
    );
    assert_eq!(pane_token(&host).as_deref(), Some("kept"));
    fs::write(&file, " \n\t ").unwrap();
    assert_eq!(pane_token(&host), None);
}

#[test]
fn has_no_token_when_the_token_file_is_a_folder() {
    let (dir, mut host) = temp_host().unwrap();
    host.env.insert(
        "OSTIA_TOKEN_FILE".to_owned(),
        dir.path().to_string_lossy().into_owned(),
    );
    assert_eq!(pane_token(&host), None);
}
