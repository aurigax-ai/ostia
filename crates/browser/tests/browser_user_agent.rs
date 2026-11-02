#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_browser::browser_user_agent::browser_user_agent;

const ELECTRON: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ostia/0.4.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36";

#[test]
fn reads_as_the_chrome_it_is_built_on_without_the_electron_and_app_tokens_sites_treat_as_a_bot() {
    assert_eq!(
        browser_user_agent(ELECTRON, "ostia"),
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36"
    );
}

#[test]
fn removes_the_app_token_whatever_the_product_is_called_and_leaves_other_agents_alone() {
    let renamed = ELECTRON.replace("ostia/", "My.App/");
    assert!(!browser_user_agent(&renamed, "my.app").contains("App/"));
    let chrome = "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36";
    assert_eq!(browser_user_agent(chrome, "ostia"), chrome);
}

#[test]
fn trims_the_ends_and_keeps_a_token_that_only_looks_like_the_app_name() {
    assert_eq!(
        browser_user_agent("  Mozilla/5.0 Chrome/130 Electron/33.0.0  ", "ostia"),
        "Mozilla/5.0 Chrome/130"
    );
    assert_eq!(
        browser_user_agent("Mozilla/5.0 ostiax/1 Chrome/130", "ostia"),
        "Mozilla/5.0 ostiax/1 Chrome/130"
    );
}

#[test]
fn removes_only_the_first_electron_token_and_matches_the_app_name_without_case() {
    assert_eq!(
        browser_user_agent("A Electron/1 B Electron/2 C OSTIA/9 D", "ostia"),
        "A B Electron/2 C D"
    );
}
