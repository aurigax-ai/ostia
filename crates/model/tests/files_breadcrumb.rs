#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::files::breadcrumb::{Crumb, crumbs_of, fit_crumbs, max_fit_level, short_name};

fn labels(crumbs: &[Crumb]) -> Vec<&str> {
    crumbs.iter().map(|c| c.label.as_str()).collect()
}

#[test]
fn shows_the_home_folder_as_a_tilde() {
    assert_eq!(
        labels(&crumbs_of("/home/me/Personal/terminal", Some("/home/me"))),
        ["~", "Personal", "terminal"]
    );
    assert_eq!(labels(&crumbs_of("/home/me", Some("/home/me/"))), ["~"]);
}

#[test]
fn keeps_a_path_outside_home_whole_and_a_literal_tilde_path_as_it_is() {
    assert_eq!(
        labels(&crumbs_of("/var/log", Some("/home/me"))),
        ["var", "log"]
    );
    assert_eq!(
        labels(&crumbs_of("/home/meow", Some("/home/me"))),
        ["home", "meow"]
    );
    assert_eq!(labels(&crumbs_of("~/src", None)), ["~", "src"]);
    assert_eq!(labels(&crumbs_of("/", Some("/home/me"))), ["/"]);
}

#[test]
fn gives_every_crumb_a_unique_key() {
    let keys: std::collections::HashSet<String> = crumbs_of("/a/a/a", None)
        .into_iter()
        .map(|c| c.key)
        .collect();
    assert_eq!(keys.len(), 3);
}

#[test]
fn keys_name_the_path_up_to_the_crumb() {
    let crumbs = crumbs_of("/home/me/a/b", Some("/home/me"));
    let keys: Vec<&str> = crumbs.iter().map(|c| c.key.as_str()).collect();
    assert_eq!(keys, ["~", "~/a", "~/a/b"]);
    let outside: Vec<String> = crumbs_of("/var//log/", None)
        .into_iter()
        .map(|c| c.key)
        .collect();
    assert_eq!(outside, ["/var", "/var/log"]);
}

#[test]
fn a_bare_tilde_is_one_crumb_and_a_root_home_is_no_home() {
    assert_eq!(labels(&crumbs_of("~", None)), ["~"]);
    assert_eq!(labels(&crumbs_of("/usr/bin", Some("/"))), ["usr", "bin"]);
    assert_eq!(
        labels(&crumbs_of("/home/me/x", Some(""))),
        ["home", "me", "x"]
    );
    assert_eq!(
        labels(&crumbs_of("/home/me/x", Some("/home/me//"))),
        ["~", "x"]
    );
}

#[test]
fn keeps_the_first_letter_and_the_dot_of_a_dot_folder() {
    assert_eq!(short_name("Personal"), "P");
    assert_eq!(short_name(".sdd"), ".s");
    assert_eq!(short_name("文件夾"), "文");
}

#[test]
fn short_name_counts_code_points_not_utf16_units() {
    assert_eq!(short_name("\u{1F600}x"), "\u{1F600}");
    assert_eq!(short_name(".\u{1F600}x"), ".\u{1F600}");
    assert_eq!(short_name("."), ".");
    assert_eq!(short_name(""), "");
}

fn deep() -> Vec<Crumb> {
    crumbs_of("/home/me/Personal/terminal/.sdd/verify", Some("/home/me"))
}

#[test]
fn shows_full_names_at_level_0() {
    assert_eq!(
        labels(&fit_crumbs(&deep(), 0)),
        ["~", "Personal", "terminal", ".sdd", "verify"]
    );
}

#[test]
fn shortens_every_name_but_the_last_at_level_1() {
    assert_eq!(
        labels(&fit_crumbs(&deep(), 1)),
        ["~", "P", "t", ".s", "verify"]
    );
}

#[test]
fn folds_the_leading_crumbs_into_an_ellipsis_from_level_2_and_keeps_the_last_whole() {
    let crumbs = deep();
    assert_eq!(
        labels(&fit_crumbs(&crumbs, 2)),
        ["…", "P", "t", ".s", "verify"]
    );
    assert_eq!(labels(&fit_crumbs(&crumbs, 3)), ["…", "t", ".s", "verify"]);
    assert_eq!(
        labels(&fit_crumbs(&crumbs, max_fit_level(&crumbs))),
        ["…", "verify"]
    );
}

#[test]
fn the_folded_crumb_has_the_ellipsis_as_its_key() {
    assert_eq!(fit_crumbs(&deep(), 3)[0].key, "…");
}

#[test]
fn keeps_the_keys_of_shortened_crumbs() {
    let fitted = fit_crumbs(&deep(), 1);
    assert_eq!(fitted[1].key, "~/Personal");
    assert_eq!(fitted[4].key, "~/Personal/terminal/.sdd/verify");
}

#[test]
fn the_max_fit_level_is_the_number_of_crumbs() {
    assert_eq!(max_fit_level(&deep()), 5);
    assert_eq!(max_fit_level(&[]), 0);
}

#[test]
fn a_single_crumb_or_a_level_past_the_end_stays_whole_or_folds_to_the_last() {
    let one = crumbs_of("/var", None);
    assert_eq!(labels(&fit_crumbs(&one, 4)), ["var"]);
    assert_eq!(labels(&fit_crumbs(&deep(), 99)), ["…", "verify"]);
    assert_eq!(labels(&fit_crumbs(&deep(), -1)), labels(&deep()));
}
