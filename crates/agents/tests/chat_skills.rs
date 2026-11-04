#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use ostia_agents::chat_skills::{
    ParsedSkill, SKILL_DESCRIPTION_MAX, SKILL_FILE_MAX, SKILLS_MAX, SkillLoadResult, SkillSummary,
    list_skills, load_skill, parse_skill_text,
};
use ostia_contract::assist::CHAT_TOOL_OUTPUT_MAX;
use serde_json::{Value, json};
use tempfile::TempDir;

fn skill(dir: &Path, name: &str, description: &str, body: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n{body}\n"),
    )
    .unwrap();
}

fn names(skills: &[SkillSummary]) -> Vec<&str> {
    skills.iter().map(|s| s.name.as_str()).collect()
}

fn failed(error: &'static str) -> SkillLoadResult {
    SkillLoadResult::Failed { error }
}

fn parsed(name: &str, description: &str, body: &str) -> Option<ParsedSkill> {
    Some(ParsedSkill {
        name: name.to_owned(),
        description: description.to_owned(),
        body: body.to_owned(),
    })
}

#[test]
fn needs_front_matter_with_a_valid_name_and_a_description() {
    assert_eq!(
        parse_skill_text("---\nname: a\ndescription: b\n---\nbody", "x"),
        parsed("a", "b", "body")
    );
    assert_eq!(
        parse_skill_text("---\ndescription: b\n---\n", "folder").map(|s| s.name),
        Some("folder".to_owned())
    );
    assert_eq!(parse_skill_text("no front matter", "x"), None);
    assert_eq!(parse_skill_text("---\nname: a\n---\n", "x"), None);
    assert_eq!(
        parse_skill_text("---\nname: \"../evil\"\ndescription: b\n---\n", "x"),
        None
    );
    assert_eq!(
        parse_skill_text("---\nname: a\ndescription: &d b\nalso: *d\n---\n", "x"),
        None
    );
}

#[test]
fn reads_front_matter_with_windows_line_ends_and_no_body() {
    assert_eq!(
        parse_skill_text("---\r\nname: a\r\ndescription: b\r\n---\r\nbody", "x"),
        parsed("a", "b", "body")
    );
    assert_eq!(
        parse_skill_text("---\nname: a\ndescription: b\n---", "x"),
        parsed("a", "b", "")
    );
    assert_eq!(parse_skill_text("---\nname: a\ndescription: b", "x"), None);
    assert_eq!(
        parse_skill_text("---\nname: a\ndescription: b\n---\n", "x"),
        parsed("a", "b", "")
    );
}

#[test]
fn trims_the_name_folds_the_description_and_caps_it() {
    assert_eq!(
        parse_skill_text(
            "---\nname: '  a  '\ndescription: \"one   two\\nthree\"\n---\n",
            "x"
        ),
        parsed("a", "one two three", "")
    );
    let long = "w".repeat(SKILL_DESCRIPTION_MAX + 50);
    let text = format!("---\nname: a\ndescription: {long}\n---\n");
    assert_eq!(
        parse_skill_text(&text, "x").unwrap().description,
        "w".repeat(SKILL_DESCRIPTION_MAX)
    );
}

#[test]
fn falls_back_to_the_folder_name_when_the_name_is_not_text_and_refuses_bad_fallbacks() {
    assert_eq!(
        parse_skill_text("---\nname: 12\ndescription: b\n---\n", "folder").map(|s| s.name),
        Some("folder".to_owned())
    );
    assert_eq!(
        parse_skill_text("---\ndescription: b\n---\n", "bad name"),
        None
    );
    assert_eq!(
        parse_skill_text("---\nname: a\ndescription: 7\n---\n", "x"),
        None
    );
    assert_eq!(parse_skill_text("---\n- a\n- b\n---\n", "x"), None);
    assert_eq!(parse_skill_text("---\nname: [a\n---\n", "x"), None);
}

#[test]
fn reads_a_folder_of_skills_and_a_single_skill_folder() {
    let base = TempDir::new().unwrap();
    let folder = base.path().join("skills");
    skill(
        &folder.join("deploy"),
        "deploy",
        "Ship the app",
        "Do the thing.",
    );
    skill(
        &folder.join("review"),
        "review",
        "Review a diff",
        "Do the thing.",
    );
    let single = base.path().join("single");
    skill(&single, "single", "One skill", "Do the thing.");
    let folders = [folder.clone(), single];
    assert_eq!(
        names(&list_skills(&folders)),
        vec!["deploy", "review", "single"]
    );
    let loaded = load_skill(std::slice::from_ref(&folder), &json!("review"));
    assert_eq!(
        loaded,
        SkillLoadResult::Loaded {
            name: "review".to_owned(),
            path: folder.join("review").join("SKILL.md"),
            body: "Do the thing.\n".to_owned(),
        }
    );
    assert_eq!(
        load_skill(std::slice::from_ref(&folder), &json!("nope")),
        failed("unknown-skill")
    );
    assert_eq!(load_skill(&[folder], &json!("../x")), failed("invalid"));
}

#[test]
fn skips_symlinked_skill_folders_and_files_and_oversized_files() {
    let base = TempDir::new().unwrap();
    let folder = base.path().join("skills");
    let outside = base.path().join("outside");
    skill(&outside, "linked", "Came through a link", "Do the thing.");
    fs::create_dir_all(&folder).unwrap();
    symlink(&outside, folder.join("linked")).unwrap();
    fs::create_dir(folder.join("filelink")).unwrap();
    symlink(
        outside.join("SKILL.md"),
        folder.join("filelink").join("SKILL.md"),
    )
    .unwrap();
    skill(
        &folder.join("big"),
        "big",
        "Too big",
        &"x".repeat(SKILL_FILE_MAX),
    );
    skill(&folder.join("ok"), "ok", "Fine", "Do the thing.");
    assert_eq!(
        names(&list_skills(std::slice::from_ref(&folder))),
        vec!["ok"]
    );
    assert_eq!(
        load_skill(std::slice::from_ref(&folder), &json!("linked")),
        failed("unknown-skill")
    );
    let linked_folder = base.path().join("linked-root");
    symlink(&folder, &linked_folder).unwrap();
    assert_eq!(list_skills(&[linked_folder]), Vec::<SkillSummary>::new());
}

#[test]
fn lists_the_name_description_and_path_of_each_skill() {
    let base = TempDir::new().unwrap();
    let folder = base.path().join("skills");
    skill(&folder.join("deploy"), "deploy", "Ship the app", "Body.");
    assert_eq!(
        list_skills(std::slice::from_ref(&folder)),
        vec![SkillSummary {
            name: "deploy".to_owned(),
            description: "Ship the app".to_owned(),
            path: folder.join("deploy").join("SKILL.md"),
        }]
    );
}

#[test]
fn keeps_the_first_skill_of_a_name_and_reads_folders_in_the_order_given() {
    let base = TempDir::new().unwrap();
    let first = base.path().join("first");
    let second = base.path().join("second");
    skill(&first.join("a"), "same", "From the first folder", "one");
    skill(&second.join("a"), "same", "From the second folder", "two");
    skill(&second.join("b"), "other", "Other", "three");
    let listed = list_skills(&[second.clone(), first.clone()]);
    assert_eq!(names(&listed), vec!["same", "other"]);
    assert_eq!(listed[0].description, "From the second folder");
    let listed = list_skills(&[first, second]);
    assert_eq!(listed[0].description, "From the first folder");
}

#[test]
fn lists_nothing_for_a_missing_folder_or_a_file_and_skips_plain_files_in_a_folder() {
    let base = TempDir::new().unwrap();
    let folder = base.path().join("skills");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("notes.md"), "x").unwrap();
    skill(&folder.join("ok"), "ok", "Fine", "Body.");
    let file = base.path().join("file.md");
    fs::write(&file, "x").unwrap();
    let missing: PathBuf = base.path().join("missing");
    assert_eq!(names(&list_skills(&[missing, file, folder])), vec!["ok"]);
}

#[test]
fn stops_at_the_cap_of_skills() {
    let base = TempDir::new().unwrap();
    let folder = base.path().join("skills");
    for i in 0..SKILLS_MAX + 5 {
        let name = format!("s{i:03}");
        skill(&folder.join(&name), &name, "Fine", "Body.");
    }
    let listed = list_skills(&[folder]);
    assert_eq!(listed.len(), SKILLS_MAX);
    assert_eq!(listed[0].name, "s000");
}

#[test]
fn clips_a_loaded_body_to_the_tool_output_cap() {
    let base = TempDir::new().unwrap();
    let folder = base.path().join("skills");
    skill(
        &folder.join("big"),
        "big",
        "Big body",
        &"y".repeat(CHAT_TOOL_OUTPUT_MAX + 100),
    );
    let SkillLoadResult::Loaded { body, .. } = load_skill(&[folder], &json!("big")) else {
        panic!("not loaded");
    };
    assert_eq!(body.chars().count(), CHAT_TOOL_OUTPUT_MAX);
}

#[test]
fn refuses_a_name_that_is_not_text_or_not_a_skill_name() {
    let base = TempDir::new().unwrap();
    let folder = base.path().join("skills");
    skill(&folder.join("ok"), "ok", "Fine", "Body.");
    let cases: [Value; 6] = [
        json!(7),
        Value::Null,
        json!(""),
        json!("a b"),
        json!(".hidden"),
        json!("n".repeat(65)),
    ];
    for name in cases {
        assert_eq!(
            load_skill(std::slice::from_ref(&folder), &name),
            failed("invalid"),
            "{name}"
        );
    }
}

#[test]
fn reads_yaml_words_such_as_no_and_off_as_text() {
    assert_eq!(
        parse_skill_text("---\nname: no\ndescription: off\n---\n", "x"),
        parsed("no", "off", "")
    );
    assert_eq!(
        parse_skill_text("---\nname: yes\ndescription: Says on\n---\n", "x"),
        parsed("yes", "Says on", "")
    );
}

#[test]
fn reads_block_and_multi_line_descriptions_and_refuses_broken_front_matter() {
    assert_eq!(
        parse_skill_text("---\nname: a\ndescription: >\n  one\n  two\n---\n", "x")
            .map(|s| s.description),
        Some("one two".to_owned())
    );
    assert_eq!(
        parse_skill_text("---\nname: a\ndescription: one\n  two\n---\n", "x")
            .map(|s| s.description),
        Some("one two".to_owned())
    );
    assert_eq!(
        parse_skill_text("---\nname: a\nname: b\ndescription: c\n---\n", "x"),
        None
    );
    assert_eq!(
        parse_skill_text("---\nname: a\ndescription: b: c\n---\n", "x"),
        None
    );
    assert_eq!(
        parse_skill_text("---\nname: a\ndescription: \"b\n---\n", "x"),
        None
    );
}

#[test]
fn takes_the_fallback_name_from_the_last_segment_of_the_folder_path_as_given() {
    let root = TempDir::new().unwrap();
    fs::create_dir_all(root.path().join("sub")).unwrap();
    fs::write(
        root.path().join("SKILL.md"),
        "---\nname: deploy\ndescription: ships\n---\n",
    )
    .unwrap();
    assert_eq!(
        names(&list_skills(&[root.path().join("sub").join("..")])),
        ["deploy"]
    );
    fs::write(
        root.path().join("sub").join("SKILL.md"),
        "---\ndescription: ships\n---\n",
    )
    .unwrap();
    assert!(list_skills(&[root.path().join("sub").join(".")]).is_empty());
}
