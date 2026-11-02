#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use ostia_base::system_requirements::{InstallHint, MissingRequirement};
use ostia_base::system_requirements_ipc::{
    InstallArgs, SystemRequirementsDeps, SystemRequirementsService, requirements_install_args,
};
use serde_json::{Value, json};
use tokio::sync::oneshot;

fn missing(program: &str, package: &str) -> MissingRequirement {
    MissingRequirement {
        program: program.to_owned(),
        package: package.to_owned(),
        needs: None,
        found: None,
    }
}

type Calls = Arc<Mutex<Vec<(InstallArgs, Value)>>>;

fn deps(missing_now: Vec<MissingRequirement>, calls: &Calls) -> SystemRequirementsDeps {
    let seen = Arc::clone(calls);
    SystemRequirementsDeps {
        owner_window: Arc::new(|id| (id == "ws").then(|| "1".to_owned())),
        work_dir: Arc::new(|_| Some("/work".to_owned())),
        locale: Arc::new(|| Some("en".to_owned())),
        system_extension_enabled: Arc::new(|| true),
        missing: Arc::new(move |_| missing_now.clone()),
        settled: None,
        label: None,
        install_hint: Arc::new(|missing| InstallHint {
            command: None,
            packages: missing.iter().map(|m| m.package.clone()).collect(),
        }),
        invoke_install: Arc::new(move |args, caller| {
            seen.lock().unwrap().push((args, caller));
            Box::pin(async { json!({"ok": true}) })
        }),
    }
}

fn two() -> Vec<MissingRequirement> {
    vec![missing("bwrap", "bubblewrap"), missing("socat", "socat")]
}

#[tokio::test]
async fn sbx_c97_asks_the_system_extension_to_install_exactly_the_missing_packages_for_the_human() {
    let calls: Calls = Arc::default();
    let service = SystemRequirementsService::new(deps(two(), &calls));
    let refused = service
        .install_requirements("2", &json!("sandbox"), &json!("ws"))
        .await;
    assert_eq!(refused["ok"], json!(false));
    assert_eq!(calls.lock().unwrap().len(), 0);
    let accepted = service
        .install_requirements("1", &json!("sandbox"), &json!("ws"))
        .await;
    assert_eq!(accepted, json!({"ok": true}));
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let (args, caller) = &calls[0];
    assert_eq!(
        args.argv[..2],
        ["bubblewrap".to_owned(), "socat".to_owned()]
    );
    assert!(args.argv.contains(&"--reason".to_owned()));
    assert_eq!(args.argv.last().map(String::as_str), Some("--wait"));
    assert_eq!(caller["kind"], json!("user"));
    assert_eq!(caller["workspaceId"], json!("ws"));
    assert_eq!(caller["capabilities"], json!(["shell"]));
}

#[tokio::test]
async fn refuses_with_not_allowed_for_a_feature_or_workspace_that_is_not_a_string_or_a_foreign_window()
 {
    let calls: Calls = Arc::default();
    let service = SystemRequirementsService::new(deps(two(), &calls));
    let not_allowed = json!({"ok": false, "error": "not-allowed"});
    assert_eq!(
        service
            .install_requirements("1", &json!(3), &json!("ws"))
            .await,
        not_allowed
    );
    assert_eq!(
        service
            .install_requirements("1", &json!("sandbox"), &json!(null))
            .await,
        not_allowed
    );
    assert_eq!(
        service
            .install_requirements("1", &json!("sandbox"), &json!("other"))
            .await,
        not_allowed
    );
    assert_eq!(
        service
            .install_requirements("2", &json!("sandbox"), &json!("ws"))
            .await,
        not_allowed
    );
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn answers_ok_without_installing_when_nothing_is_missing() {
    let calls: Calls = Arc::default();
    let service = SystemRequirementsService::new(deps(Vec::new(), &calls));
    assert_eq!(
        service
            .install_requirements("1", &json!("sandbox"), &json!("ws"))
            .await,
        json!({"ok": true})
    );
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn passes_the_work_folder_and_locale_of_the_workspace_and_leaves_out_what_it_does_not_have() {
    let calls: Calls = Arc::default();
    let service = SystemRequirementsService::new(deps(two(), &calls));
    service
        .install_requirements("1", &json!("sandbox"), &json!("ws"))
        .await;
    let mut bare = deps(two(), &calls);
    bare.work_dir = Arc::new(|_| None);
    bare.locale = Arc::new(|| None);
    SystemRequirementsService::new(bare)
        .install_requirements("1", &json!("sandbox"), &json!("ws"))
        .await;
    let calls = calls.lock().unwrap();
    assert_eq!(calls[0].1["workDir"], json!("/work"));
    assert_eq!(calls[0].1["cwd"], json!("/work"));
    assert_eq!(calls[0].1["locale"], json!("en"));
    assert!(calls[1].1.get("workDir").is_none());
    assert!(calls[1].1.get("cwd").is_none());
    assert!(calls[1].1.get("locale").is_none());
}

#[tokio::test]
async fn tells_the_human_which_feature_needs_the_packages_by_its_registered_name() {
    let calls: Calls = Arc::default();
    let mut with_label = deps(vec![missing("gopls", "gopls")], &calls);
    with_label.label = Some(Arc::new(|feature| {
        if feature == "lsp:lsp-gopls/gopls" {
            "gopls".to_owned()
        } else {
            feature.to_owned()
        }
    }));
    SystemRequirementsService::new(with_label)
        .install_requirements("1", &json!("lsp:lsp-gopls/gopls"), &json!("ws"))
        .await;
    let calls = calls.lock().unwrap();
    let argv = &calls[0].0.argv;
    let reason = &argv[argv.iter().position(|arg| arg == "--reason").unwrap() + 1];
    assert!(reason.contains("gopls feature"));
    assert!(!reason.contains("lsp:"));
}

#[test]
fn names_each_package_once_and_the_product_in_the_reason() {
    let args = requirements_install_args(
        "sandbox",
        &[
            missing("a", "pkg"),
            missing("b", "pkg"),
            missing("c", "other"),
        ],
    );
    assert_eq!(
        args.argv,
        vec![
            "pkg".to_owned(),
            "other".to_owned(),
            "--reason".to_owned(),
            "Ostia's sandbox feature needs them".to_owned(),
            "--wait".to_owned(),
        ]
    );
}

#[tokio::test]
async fn ksh_c90_answers_the_settings_requirement_check_only_after_the_login_shell_path_is_known() {
    let found = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (finish, finished) = oneshot::channel::<()>();
    let finished = Arc::new(Mutex::new(Some(finished)));
    let calls: Calls = Arc::default();
    let mut waiting = deps(Vec::new(), &calls);
    let flag = Arc::clone(&found);
    waiting.missing = Arc::new(move |_| {
        if flag.load(std::sync::atomic::Ordering::SeqCst) {
            Vec::new()
        } else {
            vec![missing("tmux", "tmux")]
        }
    });
    waiting.settled = Some(Arc::new(move || {
        let receiver = finished.lock().unwrap().take().unwrap();
        Box::pin(async move {
            let _ = receiver.await;
        }) as Pin<Box<dyn Future<Output = ()> + Send>>
    }));
    waiting.owner_window = Arc::new(|_| None);
    let service = SystemRequirementsService::new(waiting);
    let answer = tokio::spawn({
        let service = service.clone();
        async move { service.requirements(&json!("keep-shells")).await }
    });
    tokio::task::yield_now().await;
    found.store(true, std::sync::atomic::Ordering::SeqCst);
    finish.send(()).unwrap();
    let report = answer.await.unwrap().unwrap();
    assert!(report.missing.is_empty());
    assert!(!report.can_install);
}

#[tokio::test]
async fn answers_nothing_for_a_feature_that_is_not_a_string() {
    let calls: Calls = Arc::default();
    let service = SystemRequirementsService::new(deps(two(), &calls));
    assert!(service.requirements(&json!(5)).await.is_none());
    assert!(service.requirements(&json!(null)).await.is_none());
}

#[tokio::test]
async fn offers_the_install_only_when_something_is_missing_and_the_system_extension_is_on() {
    let calls: Calls = Arc::default();
    let report = SystemRequirementsService::new(deps(two(), &calls))
        .requirements(&json!("sandbox"))
        .await
        .unwrap();
    assert_eq!(report.missing, two());
    assert!(report.can_install);
    assert_eq!(
        report.hint.packages,
        vec!["bubblewrap".to_owned(), "socat".to_owned()]
    );
    let mut off = deps(two(), &calls);
    off.system_extension_enabled = Arc::new(|| false);
    assert!(
        !SystemRequirementsService::new(off)
            .requirements(&json!("sandbox"))
            .await
            .unwrap()
            .can_install
    );
    assert!(
        !SystemRequirementsService::new(deps(Vec::new(), &calls))
            .requirements(&json!("sandbox"))
            .await
            .unwrap()
            .can_install
    );
}
