#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::FutureExt;
use ostia_base::host::Platform;
use ostia_files::app_handler::HandlerLookup;
use ostia_files::app_links::{AppLinkDeps, app_link_info, open_link};
use ostia_files::browser_pages::{BrowserHost, BrowserLaunch};
use parking_lot::Mutex;
use serde_json::{Value, json};

type Started = Vec<(BrowserLaunch, BTreeMap<String, String>)>;

struct Rig {
    terminal: Arc<Mutex<Option<Value>>>,
    installed: Arc<Mutex<Vec<String>>>,
    opened: Arc<Mutex<Vec<String>>>,
    started: Arc<Mutex<Started>>,
    fail_open: Arc<AtomicBool>,
}

impl Rig {
    fn new() -> Self {
        Self {
            terminal: Arc::new(Mutex::new(None)),
            installed: Arc::new(Mutex::new(Vec::new())),
            opened: Arc::new(Mutex::new(Vec::new())),
            started: Arc::new(Mutex::new(Vec::new())),
            fail_open: Arc::new(AtomicBool::new(false)),
        }
    }

    fn set_terminal(&self, terminal: Value) {
        *self.terminal.lock() = Some(terminal);
    }

    fn install(&self, path: &str) {
        self.installed.lock().push(path.to_owned());
    }

    fn deps(&self) -> AppLinkDeps {
        let terminal = self.terminal.clone();
        let opened = self.opened.clone();
        let fail_open = self.fail_open.clone();
        let started = self.started.clone();
        let installed = self.installed.clone();
        AppLinkDeps {
            read_settings: Arc::new(move || match terminal.lock().clone() {
                Some(terminal) => json!({"terminal": terminal}),
                None => json!({}),
            }),
            open_external: Arc::new(move |href| {
                opened.lock().push(href);
                let ok = !fail_open.swap(false, Ordering::SeqCst);
                async move { ok }.boxed()
            }),
            lookup: HandlerLookup {
                platform: Platform::Linux,
                protocol_app: Arc::new(|_| String::new()),
                query_default: Arc::new(|scheme| {
                    let answer = if scheme == "obsidian" {
                        "obsidian.desktop"
                    } else {
                        ""
                    };
                    async move { answer.to_owned() }.boxed()
                }),
                read_desktop: Arc::new(|_| {
                    async { Some("[Desktop Entry]\nName=Obsidian\nExec=obsidian %u\n".to_owned()) }
                        .boxed()
                }),
            },
            browser: BrowserHost {
                platform: Platform::Linux,
                env: BTreeMap::from([("PATH".to_owned(), "/opt/bin".to_owned())]),
                home: "/home/u".into(),
                exists: Arc::new(move |path| installed.lock().iter().any(|p| p == path)),
            },
            start_browser: Arc::new(move |launch, env| {
                started.lock().push((launch, env));
                async { true }.boxed()
            }),
        }
    }

    fn opened(&self) -> Vec<String> {
        self.opened.lock().clone()
    }
}

async fn info(rig: &Rig, raw: Value) -> Value {
    serde_json::to_value(app_link_info(&rig.deps(), &raw).await).unwrap()
}

async fn open(rig: &Rig, raw: Value, confirmed: Value) -> Value {
    serde_json::to_value(open_link(&rig.deps(), &raw, &confirmed).await).unwrap()
}

#[tokio::test]
async fn names_the_app_that_handles_a_scheme() {
    let rig = Rig::new();
    assert_eq!(
        info(&rig, json!("obsidian://open?vault=a")).await,
        json!({"ok": true, "app": "Obsidian"})
    );
}

#[tokio::test]
async fn names_the_installed_browser_for_a_browser_page() {
    let rig = Rig::new();
    rig.install("/opt/bin/google-chrome-stable");
    assert_eq!(
        info(&rig, json!("chrome://inspect/#remote-debugging")).await,
        json!({"ok": true, "app": "Google Chrome"})
    );
}

#[tokio::test]
async fn answers_no_handler_when_no_app_or_browser_is_there() {
    let rig = Rig::new();
    for raw in ["slack://channel?id=1", "edge://settings"] {
        assert_eq!(
            info(&rig, json!(raw)).await,
            json!({"ok": false, "error": "no-handler"}),
            "{raw}"
        );
    }
}

#[tokio::test]
async fn refuses_a_web_link_and_a_blocked_scheme() {
    let rig = Rig::new();
    for raw in [
        json!("https://example.com"),
        json!("mailto:a@b.c"),
        json!("chrome-extension://x/a"),
        json!(1),
    ] {
        assert_eq!(
            info(&rig, raw.clone()).await,
            json!({"ok": false, "error": "blocked"}),
            "{raw}"
        );
    }
}

#[tokio::test]
async fn does_not_open_an_app_until_the_question_is_answered() {
    let rig = Rig::new();
    assert_eq!(
        open(&rig, json!("obsidian://open?vault=a"), json!(false)).await,
        json!({"ok": false, "error": "not-allowed"})
    );
    assert!(rig.opened().is_empty());
}

#[tokio::test]
async fn opens_an_app_after_a_confirmed_answer_with_spaces_and_chinese_encoded() {
    let rig = Rig::new();
    let raw = "obsidian://advanced-uri?vault=Nexus One&filepath=中.md";
    assert_eq!(
        open(&rig, json!(raw), json!(true)).await,
        json!({"ok": true})
    );
    assert_eq!(
        rig.opened(),
        ["obsidian://advanced-uri?vault=Nexus%20One&filepath=%E4%B8%AD.md"]
    );
}

#[tokio::test]
async fn treats_a_confirmation_that_is_not_exactly_true_as_no_confirmation() {
    let rig = Rig::new();
    for confirmed in [json!("yes"), json!(1), json!(null), json!([true])] {
        assert_eq!(
            open(&rig, json!("obsidian://open"), confirmed.clone()).await,
            json!({"ok": false, "error": "not-allowed"}),
            "{confirmed}"
        );
    }
    assert!(rig.opened().is_empty());
}

#[tokio::test]
async fn opens_an_allowed_scheme_and_everything_when_the_question_is_off() {
    let rig = Rig::new();
    rig.set_terminal(json!({"allowedAppSchemes": ["obsidian"]}));
    assert_eq!(
        open(&rig, json!("obsidian://open"), json!(false)).await,
        json!({"ok": true})
    );
    rig.set_terminal(json!({"askBeforeOpeningApps": false}));
    assert_eq!(
        open(&rig, json!("obsidian://open"), json!(false)).await,
        json!({"ok": true})
    );
    assert_eq!(rig.opened().len(), 2);
}

#[tokio::test]
async fn keeps_asking_for_another_scheme_than_the_allowed_ones() {
    let rig = Rig::new();
    rig.set_terminal(json!({"allowedAppSchemes": ["vscode"]}));
    assert_eq!(
        open(&rig, json!("obsidian://open"), json!(false)).await,
        json!({"ok": false, "error": "not-allowed"})
    );
}

#[tokio::test]
async fn starts_the_installed_browser_for_a_browser_page_with_the_address_as_one_argument() {
    let rig = Rig::new();
    rig.install("/opt/bin/google-chrome-stable");
    assert_eq!(
        open(
            &rig,
            json!("chrome://inspect/#remote-debugging"),
            json!(true)
        )
        .await,
        json!({"ok": true})
    );
    let started = rig.started.lock().clone();
    assert_eq!(
        started,
        vec![(
            BrowserLaunch {
                app: "Google Chrome".to_owned(),
                command: "/opt/bin/google-chrome-stable".to_owned(),
                args: vec!["chrome://inspect/#remote-debugging".to_owned()],
            },
            BTreeMap::from([("PATH".to_owned(), "/opt/bin".to_owned())]),
        )]
    );
    assert!(rig.opened().is_empty());
}

#[tokio::test]
async fn asks_before_starting_a_browser_page_unless_confirmed() {
    let rig = Rig::new();
    rig.install("/opt/bin/google-chrome-stable");
    assert_eq!(
        open(
            &rig,
            json!("chrome://inspect/#remote-debugging"),
            json!(false)
        )
        .await,
        json!({"ok": false, "error": "not-allowed"})
    );
    assert!(rig.started.lock().is_empty());
}

#[tokio::test]
async fn starts_nothing_for_a_browser_page_when_the_browser_is_not_installed() {
    let rig = Rig::new();
    assert_eq!(
        open(&rig, json!("brave://settings"), json!(true)).await,
        json!({"ok": false, "error": "no-handler"})
    );
    assert!(rig.started.lock().is_empty());
}

#[tokio::test]
async fn opens_a_web_or_mail_link_without_a_question() {
    let rig = Rig::new();
    assert_eq!(
        open(&rig, json!("https://example.com/a b"), json!(false)).await,
        json!({"ok": true})
    );
    assert_eq!(
        open(&rig, json!("mailto:a@b.c"), json!(false)).await,
        json!({"ok": true})
    );
    assert_eq!(rig.opened().len(), 2);
}

#[tokio::test]
async fn never_opens_scripts_files_internal_schemes_or_links_with_a_password_even_confirmed() {
    let rig = Rig::new();
    rig.set_terminal(json!({"askBeforeOpeningApps": false}));
    let blocked = [
        json!("javascript:alert(1)"),
        json!("file:///etc/passwd"),
        json!("data:text/html,x"),
        json!("devtools://devtools/a"),
        json!("chrome-extension://x/a"),
        json!("view-source://a"),
        json!("ostia://settings-schema"),
        json!("remote://folder/a"),
        json!("smb://host/share"),
        json!("search-ms://query=a"),
        json!("ms-msdt://id"),
        json!("x-app:do"),
        json!("postgres://u:p@h/db"),
        json!(1),
    ];
    for raw in blocked {
        assert_eq!(
            open(&rig, raw.clone(), json!(true)).await,
            json!({"ok": false, "error": "blocked"}),
            "{raw}"
        );
    }
    assert!(rig.opened().is_empty());
    assert!(rig.started.lock().is_empty());
}

#[tokio::test]
async fn reports_a_failure_when_the_system_cannot_open_the_link() {
    let rig = Rig::new();
    rig.fail_open.store(true, Ordering::SeqCst);
    assert_eq!(
        open(&rig, json!("obsidian://open"), json!(true)).await,
        json!({"ok": false, "error": "failed"})
    );
}

#[tokio::test]
async fn reports_a_failure_when_the_browser_cannot_start() {
    let rig = Rig::new();
    rig.install("/opt/bin/google-chrome-stable");
    let mut deps = rig.deps();
    deps.start_browser = Arc::new(|_, _| async { false }.boxed());
    let result = open_link(&deps, &json!("chrome://inspect/"), &json!(true)).await;
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!({"ok": false, "error": "failed"})
    );
}
