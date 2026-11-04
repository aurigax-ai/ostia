use ostia_contract::chat_tools::SkillSummary;
use ostia_model::assist::chat_tool_specs::{builtin_specs, skills_description};
use serde_json::{Value, json};

fn skills(count: usize) -> Vec<SkillSummary> {
    (0..count)
        .map(|i| SkillSummary {
            name: format!("skill-{i}"),
            description: format!(
                "What skill {i} is for, in a long sentence the model never needs to see."
            ),
            path: format!("/home/u/.claude/skills/skill-{i}/SKILL.md"),
        })
        .collect()
}

fn declaration(name: &str, description: &str, input_schema: &Value) -> String {
    json!({ "name": name, "description": description, "parameters": input_schema }).to_string()
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

#[test]
fn lists_each_skill_by_name_on_its_own_line_never_its_description() {
    let text = skills_description(&skills(3));
    let lines: Vec<&str> = text.split('\n').skip(1).collect();
    assert_eq!(lines, vec!["- skill-0", "- skill-1", "- skill-2"]);
    assert!(!text.contains("What skill"));
}

#[test]
fn lists_at_most_32_names_and_counts_the_rest() {
    let text = skills_description(&skills(40));
    let lines: Vec<&str> = text.split('\n').skip(1).collect();
    assert_eq!(lines.len(), 33);
    assert_eq!(lines[31], "- skill-31");
    assert_eq!(lines[32], "- and 8 more");
}

#[test]
fn stays_short_for_the_most_skills_a_human_can_have() {
    assert!(utf16_len(&skills_description(&skills(128))) < 600);
}

#[test]
fn costs_under_3100_characters_together_and_edit_file_under_650() {
    let mut total = 0;
    let mut edit_file = 0;
    for spec in builtin_specs() {
        let description = if spec.name == "load_skill" {
            skills_description(&skills(1))
        } else {
            spec.description.clone()
        };
        let size = utf16_len(&declaration(spec.name, &description, &spec.input_schema));
        total += size;
        if spec.name == "edit_file" {
            edit_file = size;
        }
    }
    assert!(total < 3100, "{total}");
    assert!(edit_file > 0 && edit_file < 650, "{edit_file}");
}

#[test]
fn declares_the_eleven_built_in_tools_in_the_order_the_model_sees_them() {
    let names: Vec<&str> = builtin_specs().iter().map(|spec| spec.name).collect();
    assert_eq!(
        names,
        vec![
            "read_file",
            "list_directory",
            "search_files",
            "terminal_context",
            "git_status",
            "load_skill",
            "propose_command",
            "edit_file",
            "write_file",
            "open_file",
            "open_url",
        ]
    );
}

#[test]
fn gives_every_built_in_tool_an_object_schema_and_a_description() {
    for spec in builtin_specs() {
        assert_eq!(spec.input_schema["type"], "object", "{}", spec.name);
        assert!(!spec.description.is_empty(), "{}", spec.name);
    }
}

#[test]
fn requires_the_path_of_read_file_and_the_edits_of_edit_file() {
    let specs = builtin_specs();
    let schema = |name: &str| {
        specs
            .iter()
            .find(|spec| spec.name == name)
            .unwrap()
            .input_schema
            .clone()
    };
    assert_eq!(schema("read_file")["required"], json!(["path"]));
    assert_eq!(schema("edit_file")["required"], json!(["path", "edits"]));
    assert_eq!(schema("write_file")["required"], json!(["path", "content"]));
    assert_eq!(schema("open_url")["required"], json!(["url"]));
    assert_eq!(schema("git_status").get("required"), None);
}

#[test]
fn adds_the_skill_list_after_the_load_skill_description() {
    let text = skills_description(&[]);
    assert!(text.starts_with("Load the instructions of a skill by name. Skills:\n"));
    assert_eq!(text.split('\n').count(), 1 + 1);
}
