#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use ostia_base::host::Platform;
use ostia_contract::external_links::BrowserPage;
use ostia_files::browser_pages::{
    BrowserHost, BrowserLaunch, browser_launch, is_executable, start_browser,
};
use tempfile::TempDir;

const URL: &str = "chrome://inspect/#remote-debugging";

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn host(
    platform: Platform,
    env: BTreeMap<String, String>,
    exists: impl Fn(&str) -> bool + Send + Sync + 'static,
) -> BrowserHost {
    BrowserHost {
        platform,
        env,
        home: "/home/u".into(),
        exists: Arc::new(exists),
    }
}

fn linux(exists: impl Fn(&str) -> bool + Send + Sync + 'static) -> BrowserHost {
    host(
        Platform::Linux,
        env(&[("PATH", "/opt/bin:/usr/bin")]),
        exists,
    )
}

#[test]
fn uses_the_first_installed_linux_binary_with_the_address_as_one_argument() {
    let both = linux(|path| path == "/usr/bin/chromium" || path == "/usr/bin/google-chrome");
    assert_eq!(
        browser_launch(BrowserPage::Chrome, URL, &both),
        Some(BrowserLaunch {
            app: "Google Chrome".to_owned(),
            command: "/usr/bin/google-chrome".to_owned(),
            args: vec![URL.to_owned()],
        })
    );
    let chromium = linux(|path| path == "/usr/bin/chromium");
    assert_eq!(
        browser_launch(BrowserPage::Chrome, URL, &chromium)
            .unwrap()
            .app,
        "Chromium"
    );
}

#[test]
fn answers_null_when_the_browser_is_not_installed_and_ignores_relative_path_entries() {
    assert_eq!(
        browser_launch(BrowserPage::Edge, "edge://settings", &linux(|_| false)),
        None
    );
    let relative = host(Platform::Linux, env(&[("PATH", "bin")]), |_| true);
    assert_eq!(
        browser_launch(BrowserPage::Brave, "brave://settings", &relative),
        None
    );
}

#[test]
fn opens_an_installed_macos_app_bundle_with_open_a() {
    let darwin = host(Platform::Darwin, env(&[]), |path| {
        path == "/Applications/Brave Browser.app"
    });
    assert_eq!(
        browser_launch(BrowserPage::Brave, "brave://settings", &darwin),
        Some(BrowserLaunch {
            app: "Brave Browser".to_owned(),
            command: "open".to_owned(),
            args: vec![
                "-a".to_owned(),
                "Brave Browser".to_owned(),
                "brave://settings".to_owned()
            ],
        })
    );
}

#[test]
fn looks_for_a_macos_bundle_in_the_home_applications_folder_too() {
    let darwin = host(Platform::Darwin, env(&[]), |path| {
        path == "/home/u/Applications/Google Chrome.app"
    });
    assert_eq!(
        browser_launch(BrowserPage::Chrome, URL, &darwin)
            .unwrap()
            .app,
        "Google Chrome"
    );
    let none = host(Platform::Darwin, env(&[]), |_| false);
    assert_eq!(browser_launch(BrowserPage::Chrome, URL, &none), None);
}

#[test]
fn takes_the_binary_names_of_each_linux_browser_in_order() {
    let table = [
        (BrowserPage::Chrome, "google-chrome-stable", "Google Chrome"),
        (BrowserPage::Chrome, "chromium-browser", "Chromium"),
        (BrowserPage::Edge, "microsoft-edge-stable", "Microsoft Edge"),
        (BrowserPage::Edge, "microsoft-edge", "Microsoft Edge"),
        (BrowserPage::Brave, "brave-browser", "Brave"),
        (BrowserPage::Brave, "brave", "Brave"),
    ];
    for (page, binary, app) in table {
        let wanted = format!("/opt/bin/{binary}");
        let found = browser_launch(page, URL, &linux(move |path| path == wanted)).unwrap();
        assert_eq!(found.app, app, "{binary}");
        assert_eq!(found.command, format!("/opt/bin/{binary}"), "{binary}");
    }
}

#[test]
fn searches_every_directory_for_one_binary_before_the_next_binary() {
    let found = browser_launch(
        BrowserPage::Chrome,
        URL,
        &linux(|path| path == "/usr/bin/google-chrome-stable" || path == "/opt/bin/google-chrome"),
    )
    .unwrap();
    assert_eq!(found.command, "/usr/bin/google-chrome-stable");
}

#[test]
fn reads_an_executable_file_as_executable_and_everything_else_as_not() {
    let dir = TempDir::new().unwrap();
    let run = dir.path().join("run");
    let plain = dir.path().join("plain");
    fs::write(&run, "#!/bin/sh\n").unwrap();
    fs::write(&plain, "x").unwrap();
    fs::set_permissions(&run, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&plain, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(is_executable(run.to_str().unwrap()));
    assert!(!is_executable(plain.to_str().unwrap()));
    assert!(!is_executable(dir.path().join("missing").to_str().unwrap()));
}

#[tokio::test]
async fn starts_the_command_without_a_shell_and_answers_true() {
    let dir = TempDir::new().unwrap();
    let out = dir.path().join("args");
    let launch = BrowserLaunch {
        app: "Test".to_owned(),
        command: "/bin/sh".to_owned(),
        args: vec![
            "-c".to_owned(),
            r#"printf '%s' "$1" > "$2""#.to_owned(),
            "sh".to_owned(),
            "a b; c".to_owned(),
            out.to_str().unwrap().to_owned(),
        ],
    };
    assert!(start_browser(&launch, &env(&[("PATH", "/usr/bin:/bin")])).await);
    assert_eq!(wait_for_text(&out).await, "a b; c");
}

#[tokio::test]
async fn answers_false_when_the_command_cannot_start() {
    let launch = BrowserLaunch {
        app: "Missing".to_owned(),
        command: "/nonexistent/browser".to_owned(),
        args: vec![URL.to_owned()],
    };
    assert!(!start_browser(&launch, &env(&[])).await);
}

#[tokio::test]
async fn starts_the_browser_without_the_ostia_variables() {
    let dir = TempDir::new().unwrap();
    let out = dir.path().join("env");
    let launch = BrowserLaunch {
        app: "Test".to_owned(),
        command: "/bin/sh".to_owned(),
        args: vec![
            "-c".to_owned(),
            r#"printf '%s|%s' "$OSTIA_TOKEN" "$KEPT" > "$1""#.to_owned(),
            "sh".to_owned(),
            out.to_str().unwrap().to_owned(),
        ],
    };
    let env = env(&[
        ("OSTIA_TOKEN", "secret"),
        ("KEPT", "yes"),
        ("PATH", "/usr/bin:/bin"),
    ]);
    assert!(start_browser(&launch, &env).await);
    assert_eq!(wait_for_text(&out).await, "|yes");
}

async fn wait_for_text(path: &Path) -> String {
    for _ in 0..200 {
        if let Ok(text) = fs::read_to_string(path)
            && !text.is_empty()
        {
            return text;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the child wrote nothing to {}", path.display());
}
