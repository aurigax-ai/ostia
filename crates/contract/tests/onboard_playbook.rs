#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use ostia_contract::agent_skills::skill_directive;
use ostia_contract::onboard_playbook::{ONBOARD_FILES, ONBOARD_TEXT};
use regex::Regex;

const STEP_LINES_MAX: usize = 30;
const INDEX_LINES_MAX: usize = 25;
const ROLES: [&str; 3] = ["worker", "manager", "reviewer"];

fn line_count(text: &str) -> usize {
    text.trim_end().split('\n').count()
}

fn index_lines() -> Vec<(String, String)> {
    let pattern = Regex::new(r"^- ([a-z]+): (.+)$").unwrap();
    ONBOARD_TEXT
        .split('\n')
        .filter_map(|line| pattern.captures(line))
        .map(|captures| (captures[1].to_owned(), captures[2].to_owned()))
        .collect()
}

fn indexed_steps() -> Vec<String> {
    index_lines()
        .into_iter()
        .filter(|(name, _)| !ROLES.contains(&name.as_str()))
        .map(|(name, _)| name)
        .collect()
}

fn role_steps() -> Vec<String> {
    index_lines()
        .into_iter()
        .filter(|(name, _)| ROLES.contains(&name.as_str()))
        .flat_map(|(_, rest)| rest.split(", ").map(str::to_owned).collect::<Vec<_>>())
        .collect()
}

fn step_names() -> Vec<String> {
    let pattern = Regex::new(r"^steps/(.+)\.md$").unwrap();
    ONBOARD_FILES
        .iter()
        .map(|file| pattern.replace(file.path, "$1").into_owned())
        .collect()
}

#[test]
fn lists_every_step_file_in_the_index_and_has_a_file_for_every_indexed_step() {
    let mut indexed = indexed_steps();
    indexed.sort();
    let mut files = step_names();
    files.sort();
    assert_eq!(indexed, files);
}

#[test]
fn gives_every_role_only_steps_that_exist_and_every_step_to_some_role() {
    let files = step_names();
    let used: BTreeSet<String> = role_steps().into_iter().collect();
    let unknown: Vec<&String> = used.iter().filter(|step| !files.contains(step)).collect();
    assert!(unknown.is_empty(), "{unknown:?}");
    let unused: Vec<&String> = files.iter().filter(|step| !used.contains(*step)).collect();
    assert!(unused.is_empty(), "{unused:?}");
}

#[test]
fn keeps_the_index_and_each_step_short_one_heading_each() {
    let heading = Regex::new(r"(?m)^#{1,2} ").unwrap();
    assert!(line_count(ONBOARD_TEXT) <= INDEX_LINES_MAX);
    for file in ONBOARD_FILES {
        assert!(line_count(file.text) <= STEP_LINES_MAX, "{}", file.path);
        assert_eq!(heading.find_iter(file.text).count(), 1, "{}", file.path);
    }
}

#[test]
fn holds_no_shell_injection_in_the_index_or_a_step() {
    let texts = std::iter::once(ONBOARD_TEXT).chain(ONBOARD_FILES.iter().map(|file| file.text));
    for text in texts {
        assert_eq!(skill_directive(text), None, "{text}");
    }
}
