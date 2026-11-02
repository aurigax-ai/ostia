pub use ostia_contract::pane_banner_text::error_banner;

pub fn integration_not_loaded_notice(template: &str, reason: &str) -> String {
    error_banner(&template.replace("{reason}", reason))
}
