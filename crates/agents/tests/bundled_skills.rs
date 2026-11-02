#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use ostia_agents::bundled_skills::{
    BundledSkillFile, CORE_SKILL_FILES, MANAGER_SKILL_FILES, bundled_skill_text,
    write_bundled_skill,
};
use ostia_base::js::{JS_SPACE_CLASS, utf16_len};
use ostia_base::node_path::normalize;
use ostia_contract::agent_skills::{SkillFrontmatter, skill_directive, skill_frontmatter};
use regex::Regex;
use serde_json::Value;
use tempfile::TempDir;

const SKILL_BODY_MAX_LINES: usize = 500;
const DESCRIPTION_MAX: usize = 1024;
const CORE_SKILL_MAX_CHARS: usize = 17_700;
const CONTENTS_FROM_LINES: usize = 100;

const ADMIN_ONLY_COMMANDS: [&str; 7] = [
    "token create",
    "token update",
    "token show",
    "token list",
    "token revoke",
    "polkit install",
    "cmux import",
];
const EXTENSIONS_FOR_THE_HUMAN_NO_AGENT_SKILL_COVERS: [&str; 7] = [
    "assistant",
    "handoff",
    "keeper",
    "model-runtime",
    "skills",
    "ssh",
    "trellis",
];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn extensions_dir() -> PathBuf {
    root().join("src/extensions")
}

fn skills_dir() -> PathBuf {
    root().join("src/main/agents/skills")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn json_file(path: &Path) -> Value {
    serde_json::from_str(&read(path)).unwrap()
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn items<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn manifests() -> Vec<Value> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(extensions_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    dirs.sort();
    dirs.into_iter()
        .map(|dir| dir.join("ostia.json"))
        .filter(|file| file.exists())
        .map(|file| json_file(&file))
        .collect()
}

fn contributes(manifest: &Value) -> &Value {
    manifest.get("contributes").unwrap_or(&Value::Null)
}

fn marketplace_ids() -> Vec<String> {
    let listing = json_file(&root().join("marketplace/ostia-marketplace.json"));
    let listed = items(&listing, "extensions")
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned);
    let unlisted = items(&listing, "unlisted")
        .iter()
        .filter_map(|entry| str_of(entry, "path"))
        .map(str::to_owned);
    listed
        .chain(unlisted)
        .map(|path| path.rsplit('/').next().unwrap().to_owned())
        .collect()
}

#[derive(Clone)]
struct SkillFile {
    path: String,
    text: String,
}

struct SkillUnderTest {
    label: String,
    files: Vec<SkillFile>,
    own: Option<Value>,
}

fn files_of(files: &[BundledSkillFile]) -> Vec<SkillFile> {
    files
        .iter()
        .map(|file| SkillFile {
            path: file.path.to_owned(),
            text: file.text.to_owned(),
        })
        .collect()
}

fn extension_skills() -> Vec<SkillUnderTest> {
    manifests()
        .into_iter()
        .flat_map(|manifest| {
            let id = str_of(&manifest, "id").unwrap().to_owned();
            items(contributes(&manifest), "agentSkills")
                .iter()
                .map(|skill| {
                    let dir = extensions_dir()
                        .join(&id)
                        .join(str_of(skill, "path").unwrap());
                    let names = std::iter::once("SKILL.md")
                        .chain(items(skill, "files").iter().filter_map(Value::as_str));
                    SkillUnderTest {
                        label: format!("{id}/{}", str_of(skill, "name").unwrap()),
                        own: Some(manifest.clone()),
                        files: names
                            .map(|path| SkillFile {
                                path: path.to_owned(),
                                text: read(&dir.join(path)),
                            })
                            .collect(),
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn skills() -> Vec<SkillUnderTest> {
    let mut all = vec![
        SkillUnderTest {
            label: "ostia".to_owned(),
            files: files_of(CORE_SKILL_FILES),
            own: None,
        },
        SkillUnderTest {
            label: "ostia-manager".to_owned(),
            files: files_of(MANAGER_SKILL_FILES),
            own: None,
        },
    ];
    all.extend(extension_skills());
    all
}

fn frontmatter_block() -> Regex {
    Regex::new(r"(?s)^---\n(.*?)\n---\n").unwrap()
}

fn frontmatter(text: &str) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let Some(found) = frontmatter_block().captures(text) else {
        return fields;
    };
    for line in found[1].split('\n') {
        if let Some(at) = line.find(": ").filter(|at| *at > 0) {
            fields.insert(line[..at].to_owned(), line[at + 2..].to_owned());
        }
    }
    fields
}

fn body(text: &str) -> String {
    frontmatter_block().replace(text, "").into_owned()
}

fn entry(skill: &SkillUnderTest) -> &SkillFile {
    skill
        .files
        .iter()
        .find(|file| file.path == "SKILL.md")
        .unwrap_or_else(|| panic!("{} has no SKILL.md", skill.label))
}

fn links(text: &str) -> Vec<String> {
    let pattern = format!(r"\]\(([^)#{JS_SPACE_CLASS}]+\.md)\)");
    Regex::new(&pattern)
        .unwrap()
        .captures_iter(text)
        .map(|found| found[1].to_owned())
        .collect()
}

fn is_word(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn matches_with_clean_start(
    pattern: &str,
    text: &str,
    start_is_blocked: impl Fn(char) -> bool,
) -> Vec<regex::Captures<'_>> {
    let re = Regex::new(pattern).unwrap();
    let mut found = Vec::new();
    let mut from = 0;
    while from <= text.len() {
        let Some(captures) = re.captures_at(text, from) else {
            break;
        };
        let whole = captures.get(0).unwrap();
        let blocked = text[..whole.start()]
            .chars()
            .next_back()
            .is_some_and(&start_is_blocked);
        if blocked {
            from = whole.start() + 1;
        } else {
            from = whole.end().max(whole.start() + 1);
            found.push(captures);
        }
    }
    found
}

fn commands_shown(text: &str) -> Vec<(String, Option<String>)> {
    matches_with_clean_start(r"ostia ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?", text, |ch| {
        is_word(ch) || matches!(ch, '/' | '.' | '-')
    })
    .into_iter()
    .map(|found| {
        (
            found[1].to_owned(),
            found.get(2).map(|verb| verb.as_str().to_owned()),
        )
    })
    .collect()
}

fn flags_of(args: Option<&str>) -> Vec<String> {
    let mut flags: Vec<String> = Vec::new();
    for found in matches_with_clean_start(r"--?[a-zA-Z][A-Za-z0-9_-]*", args.unwrap_or(""), |ch| {
        is_word(ch) || ch == '-'
    }) {
        let flag = found[0].to_owned();
        if !flags.contains(&flag) {
            flags.push(flag);
        }
    }
    flags
}

fn keeps_going(next: Option<char>) -> bool {
    next.is_some_and(|ch| is_word(ch) || ch == '-')
}

fn shows_flag(text: &str, flag: &str) -> bool {
    text.match_indices(flag).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + flag.len()..].chars().next();
        !keeps_going(before) && !keeps_going(after)
    })
}

struct CliSurface {
    label: String,
    noun: String,
    verb: Option<String>,
    args: Option<String>,
}

fn surface(noun: &str, verb: Option<&str>, args: Option<&str>) -> CliSurface {
    let label = std::iter::once("ostia")
        .chain(std::iter::once(noun))
        .chain(verb.filter(|verb| !verb.is_empty()))
        .collect::<Vec<_>>()
        .join(" ");
    CliSurface {
        label,
        noun: noun.to_owned(),
        verb: verb.map(str::to_owned),
        args: args.map(str::to_owned),
    }
}

fn usage_table() -> Vec<Value> {
    let table = json_file(&root().join("test/fixtures/rust/cli-usage-table.json"));
    table.as_array().unwrap().clone()
}

fn cli_surfaces() -> Vec<CliSurface> {
    usage_table()
        .iter()
        .filter(|usage| str_of(usage, "audience") != Some("plumbing"))
        .flat_map(|usage| {
            let noun = str_of(usage, "noun").unwrap();
            let verbs: Vec<&Value> = items(usage, "verbs")
                .iter()
                .filter(|verb| verb.get("hidden").is_none())
                .collect();
            if verbs.is_empty() {
                return vec![surface(noun, None, str_of(usage, "args"))];
            }
            verbs
                .into_iter()
                .map(|verb| surface(noun, str_of(verb, "verb"), str_of(verb, "args")))
                .collect()
        })
        .collect()
}

fn extension_surfaces() -> Vec<CliSurface> {
    manifests()
        .iter()
        .filter(|manifest| {
            !EXTENSIONS_FOR_THE_HUMAN_NO_AGENT_SKILL_COVERS
                .contains(&str_of(manifest, "id").unwrap())
        })
        .flat_map(|manifest| {
            let id = str_of(manifest, "id").unwrap();
            let noun = str_of(contributes(manifest), "verb").unwrap_or(id);
            items(contributes(manifest), "commands")
                .iter()
                .filter(|command| command.get("stdin").is_none())
                .map(|command| surface(noun, str_of(command, "id"), str_of(command, "usage")))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn mentions(text: &str, shown: &CliSurface) -> bool {
    let verb = shown
        .verb
        .as_ref()
        .map_or(String::new(), |verb| format!(" {verb}"));
    let direct = format!("ostia {}{verb}", shown.noun);
    if text
        .match_indices(&direct)
        .any(|(at, _)| !keeps_going(text[at + direct.len()..].chars().next()))
    {
        return true;
    }
    let Some(shown_verb) = &shown.verb else {
        return false;
    };
    let prefix = format!("ostia {} ", shown.noun);
    let noun_again = format!("{} ", shown.noun);
    text.match_indices(&prefix).any(|(at, _)| {
        let rest = &text[at + prefix.len()..];
        let line = rest.split('\n').next().unwrap();
        line.match_indices("| ").any(|(pipe, _)| {
            let after = &line[pipe + 2..];
            [after.strip_prefix(&noun_again), Some(after)]
                .into_iter()
                .flatten()
                .any(|tail| {
                    tail.strip_prefix(shown_verb.as_str())
                        .is_some_and(|following| !keeps_going(following.chars().next()))
                })
        })
    })
}

fn extension_commands() -> BTreeMap<String, BTreeSet<String>> {
    let built_in: BTreeSet<String> = marketplace_ids().into_iter().collect();
    manifests()
        .iter()
        .filter(|manifest| !built_in.contains(str_of(manifest, "id").unwrap()))
        .map(|manifest| {
            (
                str_of(manifest, "id").unwrap().to_owned(),
                command_ids(manifest),
            )
        })
        .collect()
}

fn command_ids(manifest: &Value) -> BTreeSet<String> {
    items(contributes(manifest), "commands")
        .iter()
        .filter_map(|command| str_of(command, "id"))
        .map(str::to_owned)
        .collect()
}

#[test]
fn label_is_shown_with_every_flag_it_takes() {
    let texts: Vec<String> = skills()
        .into_iter()
        .flat_map(|skill| skill.files)
        .map(|file| file.text)
        .collect();
    let surfaces: Vec<CliSurface> = cli_surfaces()
        .into_iter()
        .chain(extension_surfaces())
        .filter(|shown| !ADMIN_ONLY_COMMANDS.contains(&shown.label.trim_start_matches("ostia ")))
        .collect();
    assert!(!surfaces.is_empty());
    for shown in &surfaces {
        let wher: Vec<&String> = texts.iter().filter(|text| mentions(text, shown)).collect();
        assert!(!wher.is_empty(), "{} is in no skill", shown.label);
        for flag in flags_of(shown.args.as_deref()) {
            assert!(
                wher.iter().any(|text| shows_flag(text, &flag)),
                "{} {flag} is in no skill",
                shown.label
            );
        }
    }
}

#[test]
fn label_has_a_valid_name_and_a_third_person_description() {
    let name_pattern = Regex::new(r"^[a-z0-9]+(-[a-z0-9]+)*$").unwrap();
    let reserved = Regex::new(r"anthropic|claude").unwrap();
    let first_person = Regex::new(r"(?i-u)\b(you|your|I|my|we)\b").unwrap();
    let verb_form = Regex::new(r"^[A-Z][a-z]+s$").unwrap();
    let use_when = Regex::new(r"(?-u:\b)Use when(?-u:\b)").unwrap();
    for skill in skills() {
        let fields = frontmatter(&entry(&skill).text);
        let name = fields.get("name").map_or("", String::as_str);
        assert!(name_pattern.is_match(name), "{}", skill.label);
        assert!(utf16_len(name) <= 64, "{}", skill.label);
        assert!(!reserved.is_match(name), "{}", skill.label);
        let description = fields.get("description").map_or("", String::as_str);
        assert!(utf16_len(description) > 0, "{}", skill.label);
        assert!(utf16_len(description) <= DESCRIPTION_MAX, "{}", skill.label);
        assert!(!first_person.is_match(description), "{}", skill.label);
        assert!(
            verb_form.is_match(description.split(' ').next().unwrap()),
            "{}",
            skill.label
        );
        assert!(use_when.is_match(description), "{}", skill.label);
    }
}

#[test]
fn label_passes_the_extension_skill_rules_name_and_description_only_no_injection() {
    for skill in skills() {
        let text = &entry(&skill).text;
        assert!(
            matches!(
                skill_frontmatter(text),
                Some(SkillFrontmatter::Valid { .. })
            ),
            "{}",
            skill.label
        );
        assert_eq!(skill_directive(text), None, "{}", skill.label);
    }
}

#[test]
fn label_keeps_skill_md_within_500_lines() {
    for skill in skills() {
        assert!(
            body(&entry(&skill).text).split('\n').count() <= SKILL_BODY_MAX_LINES,
            "{}",
            skill.label
        );
    }
}

#[test]
fn keeps_the_core_skill_md_within_the_size_it_had_after_1191() {
    let core = CORE_SKILL_FILES
        .iter()
        .find(|file| file.path == "SKILL.md")
        .unwrap();
    assert!(utf16_len(core.text) <= CORE_SKILL_MAX_CHARS);
}

#[test]
fn label_links_only_files_it_ships_one_level_deep() {
    for skill in skills() {
        let paths: BTreeSet<&str> = skill.files.iter().map(|file| file.path.as_str()).collect();
        let linked: Vec<String> = links(&entry(&skill).text)
            .iter()
            .map(|link| normalize(Path::new(link)).to_string_lossy().into_owned())
            .collect();
        for link in &linked {
            assert!(paths.contains(link.as_str()), "{}: {link}", skill.label);
        }
        for file in skill.files.iter().filter(|file| file.path != "SKILL.md") {
            assert!(
                linked.contains(&file.path),
                "{}: {} is linked from SKILL.md",
                skill.label,
                file.path
            );
            assert!(
                links(&file.text).is_empty(),
                "{}: {} links further",
                skill.label,
                file.path
            );
            let folder = Path::new(&file.path)
                .parent()
                .map_or(String::new(), |dir| dir.to_string_lossy().into_owned());
            let depth = if folder.is_empty() {
                1
            } else {
                folder.split('/').count()
            };
            assert!(depth <= 1, "{}", file.path);
            if file.text.split('\n').count() > CONTENTS_FROM_LINES {
                assert!(
                    file.text.contains("## Contents"),
                    "{}: {} needs a contents list",
                    skill.label,
                    file.path
                );
            }
        }
    }
}

#[test]
fn label_shows_only_ostia_commands_that_exist() {
    let table = usage_table();
    for skill in skills() {
        let mut extensions = extension_commands();
        if let Some(own) = &skill.own {
            let commands = command_ids(own);
            extensions.insert(str_of(own, "id").unwrap().to_owned(), commands.clone());
            if let Some(verb) = str_of(contributes(own), "verb") {
                extensions.insert(verb.to_owned(), commands);
            }
        }
        for file in &skill.files {
            for (noun, verb) in commands_shown(&file.text) {
                let wher = format!(
                    "{} {}: ostia {noun} {}",
                    skill.label,
                    file.path,
                    verb.as_deref().unwrap_or("")
                );
                if let Some(core) = table
                    .iter()
                    .find(|usage| str_of(usage, "noun") == Some(&noun))
                {
                    if let (Some(verbs), Some(verb)) = (core.get("verbs"), &verb) {
                        let names: Vec<&str> = verbs
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter_map(|v| str_of(v, "verb"))
                            .collect();
                        assert!(names.contains(&verb.as_str()), "{wher}");
                    }
                    continue;
                }
                assert!(extensions.contains_key(&noun), "{wher}");
                if let Some(verb) = &verb {
                    assert!(extensions[&noun].contains(verb), "{wher}");
                }
            }
        }
    }
}

#[test]
fn names_no_marketplace_extension_in_the_core_skill() {
    let text = CORE_SKILL_FILES
        .iter()
        .map(|file| file.text)
        .collect::<Vec<_>>()
        .join("\n");
    let ids = ["trellis", "keeper", "model-runtime"]
        .map(str::to_owned)
        .into_iter()
        .chain(marketplace_ids());
    for id in ids {
        let pattern = format!(r"(?i-u)\b{}\b", regex::escape(&id));
        assert!(!Regex::new(&pattern).unwrap().is_match(&text), "{id}");
    }
}

fn markdown_files(dir: &Path, prefix: &str) -> Vec<String> {
    let mut found = Vec::new();
    for item in fs::read_dir(dir).unwrap() {
        let item = item.unwrap();
        let name = item.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if item.path().is_dir() {
            found.extend(markdown_files(&item.path(), &relative));
        } else if relative.ends_with(".md") {
            found.push(relative);
        }
    }
    found
}

#[test]
fn ships_every_markdown_file_in_its_folder() {
    for (folder, files) in [
        ("ostia", CORE_SKILL_FILES),
        ("ostia-manager", MANAGER_SKILL_FILES),
    ] {
        let mut on_disk = markdown_files(&skills_dir().join(folder), "");
        on_disk.sort();
        let mut shipped: Vec<String> = files.iter().map(|file| file.path.to_owned()).collect();
        shipped.sort();
        assert_eq!(on_disk, shipped, "{folder}");
    }
}

#[test]
fn ships_the_text_of_the_files_on_disk_in_a_fixed_order() {
    let core_paths: Vec<&str> = CORE_SKILL_FILES.iter().map(|file| file.path).collect();
    assert_eq!(
        core_paths,
        [
            "SKILL.md",
            "reference/browser.md",
            "reference/bus.md",
            "reference/capabilities.md",
            "reference/git.md",
            "reference/graphs.md",
            "reference/panes.md",
            "reference/previews.md",
            "reference/reports.md",
            "reference/sandbox.md",
            "reference/serial.md",
            "reference/settings.md",
            "reference/system.md",
            "reference/views.md",
        ]
    );
    let manager_paths: Vec<&str> = MANAGER_SKILL_FILES.iter().map(|file| file.path).collect();
    assert_eq!(manager_paths, ["SKILL.md"]);
    for (folder, files) in [
        ("ostia", CORE_SKILL_FILES),
        ("ostia-manager", MANAGER_SKILL_FILES),
    ] {
        for file in files {
            assert_eq!(
                file.text,
                read(&skills_dir().join(folder).join(file.path)),
                "{folder}/{}",
                file.path
            );
        }
    }
}

#[test]
fn writes_every_file_under_the_folder_and_makes_the_folders() {
    let dir = TempDir::new().unwrap();
    let target = dir.path().join("skills/ostia");
    write_bundled_skill(&target, CORE_SKILL_FILES).unwrap();
    for file in CORE_SKILL_FILES {
        assert_eq!(read(&target.join(file.path)), file.text, "{}", file.path);
    }
    assert!(target.join("reference").is_dir());
}

#[test]
fn overwrites_a_file_that_is_already_there() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("reference")).unwrap();
    fs::write(
        dir.path().join("reference/a.md"),
        "old and much longer text",
    )
    .unwrap();
    let files = [BundledSkillFile {
        path: "reference/a.md",
        text: "new",
    }];
    write_bundled_skill(dir.path(), &files).unwrap();
    assert_eq!(read(&dir.path().join("reference/a.md")), "new");
}

#[test]
fn joins_the_files_under_a_header_each_and_trims_trailing_whitespace() {
    let files = [
        BundledSkillFile {
            path: "SKILL.md",
            text: "first\n\n",
        },
        BundledSkillFile {
            path: "reference/a.md",
            text: "second  \n",
        },
    ];
    assert_eq!(
        bundled_skill_text(&files),
        "==> SKILL.md <==\n\nfirst\n\n==> reference/a.md <==\n\nsecond"
    );
}

#[test]
fn gives_an_empty_text_for_no_files() {
    assert_eq!(bundled_skill_text(&[]), "");
}
