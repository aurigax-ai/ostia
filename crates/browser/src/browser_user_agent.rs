use ostia_base::js::{JS_SPACE_CLASS, js_trim};
use regex::{Regex, RegexBuilder};

fn remove_first(agent: &str, pattern: &Regex) -> String {
    pattern.replace(agent, "").into_owned()
}

pub fn browser_user_agent(default_agent: &str, app_name: &str) -> String {
    let non_space = format!("[^{JS_SPACE_CLASS}]");
    let without_electron = match Regex::new(&format!(" Electron/{non_space}+")) {
        Ok(pattern) => remove_first(default_agent, &pattern),
        Err(_) => default_agent.to_owned(),
    };
    let app_token = RegexBuilder::new(&format!(" {}/{non_space}+", regex::escape(app_name)))
        .case_insensitive(true)
        .build();
    let without_app = match app_token {
        Ok(pattern) => remove_first(&without_electron, &pattern),
        Err(_) => without_electron,
    };
    js_trim(&without_app).to_owned()
}
