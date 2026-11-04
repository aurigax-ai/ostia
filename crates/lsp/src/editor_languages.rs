use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_base::js_json::parse_js_json;
use ostia_base::node_path::resolve;
use ostia_contract::editor_languages::{
    EditorLanguage, EditorLanguageContribution, GRAMMAR_FILE_MAX_BYTES, validate_monarch_grammar,
};
use serde_json::Value;

use crate::confined_read::read_confined;

#[derive(Clone, Debug)]
pub struct EditorLanguageSource {
    pub ext_id: String,
    pub dir: PathBuf,
    pub language: EditorLanguageContribution,
}

pub type LanguageSources = Arc<dyn Fn() -> Vec<EditorLanguageSource> + Send + Sync>;
pub type ErrorSink = Arc<dyn Fn(&str, &str) + Send + Sync>;

#[derive(Clone)]
pub struct EditorLanguageDeps {
    pub languages: LanguageSources,
    pub on_error: ErrorSink,
}

pub fn read_grammar(dir: &Path, path: &str) -> Result<Value, String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let file = resolve(Path::new(path), &resolve(dir, &cwd));
    let data = read_confined(dir, &file, GRAMMAR_FILE_MAX_BYTES as u64)?;
    let raw =
        parse_js_json(&String::from_utf8_lossy(&data)).map_err(|_| "not valid JSON".to_owned())?;
    validate_monarch_grammar(&raw)
}

pub fn load_editor_languages(deps: &EditorLanguageDeps) -> Vec<EditorLanguage> {
    let mut loaded: Vec<EditorLanguage> = Vec::new();
    for EditorLanguageSource {
        ext_id,
        dir,
        language,
    } in (deps.languages)()
    {
        if loaded.iter().any(|other| other.id == language.id) {
            (deps.on_error)(
                &ext_id,
                &format!("editor language '{}' is already provided", language.id),
            );
            continue;
        }
        match read_grammar(&dir, &language.grammar) {
            Err(error) => {
                (deps.on_error)(&ext_id, &format!("{}: {error}", language.grammar));
            }
            Ok(grammar) => loaded.push(EditorLanguage {
                id: language.id,
                ext_id,
                name: language.name,
                extensions: language.extensions,
                filenames: language.filenames,
                configuration: language.configuration,
                grammar,
            }),
        }
    }
    loaded
}
