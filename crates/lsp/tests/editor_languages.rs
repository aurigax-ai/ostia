#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::sync::{Arc, Mutex};

use ostia_contract::editor_languages::{
    EditorLanguage, EditorLanguageConfiguration, EditorLanguageContribution, GRAMMAR_FILE_MAX_BYTES,
};
use ostia_lsp::editor_languages::{
    EditorLanguageDeps, EditorLanguageSource, load_editor_languages, read_grammar,
};
use serde_json::{Value, json};
use tempfile::TempDir;

fn grammar() -> Value {
    json!({"tokenizer": {"root": [["[a-z]+", "identifier"]]}})
}

fn contribution(id: &str, grammar_file: &str) -> EditorLanguageContribution {
    EditorLanguageContribution {
        id: id.to_owned(),
        name: "Gleam".to_owned(),
        extensions: vec![".gleam".to_owned()],
        filenames: Vec::new(),
        configuration: EditorLanguageConfiguration {
            line_comment: Some("//".to_owned()),
            ..EditorLanguageConfiguration::default()
        },
        grammar: grammar_file.to_owned(),
    }
}

fn extension_in() -> (TempDir, std::path::PathBuf) {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("ext");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("gleam.monarch.json"), grammar().to_string()).unwrap();
    (root, dir)
}

fn read(dir: &Path, path: &str) -> Result<Value, String> {
    read_grammar(dir, path)
}

#[test]
fn reads_a_grammar_file_inside_the_extension() {
    let (_root, dir) = extension_in();
    assert_eq!(read(&dir, "gleam.monarch.json"), Ok(grammar()));
}

#[test]
fn refuses_a_link_a_file_outside_the_extension_an_oversized_file_and_bad_json() {
    let (root, dir) = extension_in();
    fs::write(root.path().join("outside.json"), grammar().to_string()).unwrap();
    symlink(root.path().join("outside.json"), dir.join("link.json")).unwrap();
    fs::write(dir.join("big.json"), " ".repeat(GRAMMAR_FILE_MAX_BYTES + 1)).unwrap();
    fs::write(dir.join("broken.json"), "{").unwrap();
    fs::write(
        dir.join("regex.json"),
        json!({"tokenizer": {"root": [["(", "x"]]}}).to_string(),
    )
    .unwrap();
    assert_eq!(read(&dir, "link.json"), Err("symlink refused".to_owned()));
    assert_eq!(
        read(&dir, "../outside.json"),
        Err("outside the extension".to_owned())
    );
    assert_eq!(read(&dir, "missing.json"), Err("missing".to_owned()));
    assert!(read(&dir, "big.json").is_err());
    assert_eq!(read(&dir, "broken.json"), Err("not valid JSON".to_owned()));
    let regex = read(&dir, "regex.json").unwrap_err();
    assert!(
        regex.contains("does not start with a regular expression that compiles"),
        "{regex}"
    );
}

#[test]
fn loads_each_language_with_its_grammar_and_skips_one_that_is_broken_or_already_provided() {
    let (_root, dir) = extension_in();
    fs::write(dir.join("broken.json"), "{").unwrap();
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&errors);
    let sources = vec![
        EditorLanguageSource {
            ext_id: "a".to_owned(),
            dir: dir.clone(),
            language: contribution("gleam", "gleam.monarch.json"),
        },
        EditorLanguageSource {
            ext_id: "b".to_owned(),
            dir: dir.clone(),
            language: contribution("gleam", "gleam.monarch.json"),
        },
        EditorLanguageSource {
            ext_id: "c".to_owned(),
            dir: dir.clone(),
            language: contribution("other", "broken.json"),
        },
    ];
    let deps = EditorLanguageDeps {
        languages: Arc::new(move || sources.clone()),
        on_error: Arc::new(move |ext_id, error| {
            sink.lock().unwrap().push(format!("{ext_id}: {error}"));
        }),
    };
    assert_eq!(
        load_editor_languages(&deps),
        vec![EditorLanguage {
            ext_id: "a".to_owned(),
            id: "gleam".to_owned(),
            name: "Gleam".to_owned(),
            extensions: vec![".gleam".to_owned()],
            filenames: Vec::new(),
            configuration: EditorLanguageConfiguration {
                line_comment: Some("//".to_owned()),
                ..EditorLanguageConfiguration::default()
            },
            grammar: grammar(),
        }]
    );
    assert_eq!(
        *errors.lock().unwrap(),
        [
            "b: editor language 'gleam' is already provided",
            "c: broken.json: not valid JSON",
        ]
    );
}

#[test]
fn loads_nothing_and_reports_nothing_when_no_extension_contributes_a_language() {
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&errors);
    let deps = EditorLanguageDeps {
        languages: Arc::new(Vec::new),
        on_error: Arc::new(move |ext_id, error| {
            sink.lock().unwrap().push(format!("{ext_id}: {error}"));
        }),
    };
    assert!(load_editor_languages(&deps).is_empty());
    assert!(errors.lock().unwrap().is_empty());
}

#[test]
fn reports_a_grammar_that_the_contract_refuses_with_the_file_name_in_front() {
    let (_root, dir) = extension_in();
    fs::write(dir.join("empty.json"), "{\"tokenizer\": {}}").unwrap();
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&errors);
    let deps = EditorLanguageDeps {
        languages: Arc::new(move || {
            vec![EditorLanguageSource {
                ext_id: "a".to_owned(),
                dir: dir.clone(),
                language: contribution("gleam", "empty.json"),
            }]
        }),
        on_error: Arc::new(move |ext_id, error| {
            sink.lock().unwrap().push(format!("{ext_id}: {error}"));
        }),
    };
    assert!(load_editor_languages(&deps).is_empty());
    assert_eq!(
        *errors.lock().unwrap(),
        ["a: empty.json: tokenizer must have 1-200 states"]
    );
}
