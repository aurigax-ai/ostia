use ostia_contract::chat_tools::SkillSummary;
use serde_json::{Value, json};

const SKILLS_LISTED_MAX: usize = 32;

const LOAD_SKILL_DESCRIPTION: &str = "Load the instructions of a skill by name.";

#[derive(Clone, Debug, PartialEq)]
pub struct BuiltinSpec {
    pub name: &'static str,
    pub description: String,
    pub input_schema: Value,
}

fn spec(name: &'static str, description: &str, input_schema: Value) -> BuiltinSpec {
    BuiltinSpec {
        name,
        description: description.to_owned(),
        input_schema,
    }
}

pub fn builtin_specs() -> Vec<BuiltinSpec> {
    vec![
        spec(
            "read_file",
            "Read a text file, relative to the workspace folder. Returns up to 2000 lines and the absolute path the edit tools take.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "offset": { "type": "integer", "description": "First line, 1-based" },
                    "limit": { "type": "integer" },
                },
                "required": ["path"],
            }),
        ),
        spec(
            "list_directory",
            "List a folder, relative to the workspace folder (empty for that folder).",
            json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        ),
        spec(
            "search_files",
            "Find a case-insensitive substring in file names and contents under a folder (default the workspace folder), skipping .git and node_modules. Up to 100 matches.",
            json!({
                "type": "object",
                "properties": { "query": { "type": "string" }, "path": { "type": "string" } },
                "required": ["query"],
            }),
        ),
        spec(
            "terminal_context",
            "The workspace terminal's folder and recent commands with exit codes, never their output.",
            json!({ "type": "object", "properties": {} }),
        ),
        spec(
            "git_status",
            "Branch, change counts and changed files of the terminal's repository.",
            json!({ "type": "object", "properties": {} }),
        ),
        spec(
            "load_skill",
            LOAD_SKILL_DESCRIPTION,
            json!({
                "type": "object",
                "properties": { "name": { "type": "string" } },
                "required": ["name"],
            }),
        ),
        spec(
            "propose_command",
            "Propose one shell command. The user inserts it at the prompt, runs it in a new terminal or declines; you never see its output.",
            json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "explanation": { "type": "string", "description": "One short sentence on what it does" },
                },
                "required": ["command"],
            }),
        ),
        spec(
            "edit_file",
            "Replace exact text in an existing file; prefer it to write_file. Each old_text must match exactly once (unless replace_all), whitespace included, so add surrounding lines. Edits apply in order. The user reviews the diff.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "edits": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_text": { "type": "string" },
                                "new_text": { "type": "string" },
                                "replace_all": { "type": "boolean", "description": "Replace every match" },
                            },
                            "required": ["old_text", "new_text"],
                        },
                    },
                },
                "required": ["path", "edits"],
            }),
        ),
        spec(
            "write_file",
            "Create a text file or replace a whole one; use edit_file to change part of a file. The user reviews the diff.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" }, "content": { "type": "string" } },
                "required": ["path", "content"],
            }),
        ),
        spec(
            "open_file",
            "Open a file in the user's editor, optionally at a line.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "line": { "type": "integer", "description": "1-based" },
                },
                "required": ["path"],
            }),
        ),
        spec(
            "open_url",
            "Open an http(s) URL in the workspace's browser pane.",
            json!({
                "type": "object",
                "properties": { "url": { "type": "string" } },
                "required": ["url"],
            }),
        ),
    ]
}

pub fn skills_description(skills: &[SkillSummary]) -> String {
    let mut names: Vec<String> = skills
        .iter()
        .take(SKILLS_LISTED_MAX)
        .map(|skill| format!("- {}", skill.name))
        .collect();
    let more = skills.len() - names.len();
    if more > 0 {
        names.push(format!("- and {more} more"));
    }
    format!("{LOAD_SKILL_DESCRIPTION} Skills:\n{}", names.join("\n"))
}
