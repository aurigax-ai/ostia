use ostia_base::Result;
use ostia_contract::language_servers::{
    LanguageServerInfo, LanguageServerOverrideProblem, LanguageServerOverrideResult,
};
use serde_json::Value;

pub trait ServerCatalog {
    fn servers(&self) -> Vec<LanguageServerInfo>;
    fn refresh(&self);
}

pub fn choose_server_program(
    catalog: &dyn ServerCatalog,
    set_override: &dyn Fn(&str, &Value) -> Result<Option<LanguageServerOverrideProblem>>,
    key: &Value,
    raw: &Value,
) -> Result<LanguageServerOverrideResult> {
    let listed = key
        .as_str()
        .filter(|key| catalog.servers().iter().any(|server| server.key == *key));
    let Some(key) = listed else {
        return Ok(LanguageServerOverrideResult {
            servers: catalog.servers(),
            problem: Some(LanguageServerOverrideProblem::UnknownServer),
        });
    };
    if let Some(problem) = set_override(key, raw)? {
        return Ok(LanguageServerOverrideResult {
            servers: catalog.servers(),
            problem: Some(problem),
        });
    }
    catalog.refresh();
    Ok(LanguageServerOverrideResult {
        servers: catalog.servers(),
        problem: None,
    })
}
