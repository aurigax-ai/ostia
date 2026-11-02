#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::future::BoxFuture;
use ostia_approvals::user_presence::{
    FallbackLines, FallbackPrompt, FallbackText, PKCHECK_PATHS, PRESENCE_TIMEOUT, PkcheckRun,
    Platform, PresenceAsk, PresenceFailure, PresenceHint, PresenceResult, PresenceVia,
    UserPresenceDeps, fallback_answer, fallback_lines, install_polkit_command, name_confirmed,
    run_pkcheck, verify_user_presence,
};
use ostia_contract::script_tokens::POLKIT_ACTION;
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
enum Step<T: Clone> {
    Value(T),
    Fail(&'static str),
    Never,
}

#[derive(Debug, Clone, PartialEq)]
enum Call {
    CanPrompt,
    Prompt(String),
    Pkcheck(Vec<String>, Duration),
    Confirm(FallbackPrompt),
}

struct Fake {
    platform: Platform,
    can_prompt: Result<bool, &'static str>,
    prompt: Step<()>,
    policy_installed: bool,
    pkcheck: Step<PkcheckRun>,
    confirm: Step<Option<bool>>,
    pid: u32,
    timeout: Option<Duration>,
    calls: Mutex<Vec<Call>>,
    stops: Mutex<Vec<CancellationToken>>,
}

impl Fake {
    fn base() -> Self {
        Self {
            platform: Platform::Darwin,
            can_prompt: Ok(true),
            prompt: Step::Value(()),
            policy_installed: true,
            pkcheck: Step::Value(run(Some(0), "")),
            confirm: Step::Value(Some(true)),
            pid: 4242,
            timeout: Some(Duration::from_millis(1_000)),
            calls: Mutex::new(Vec::new()),
            stops: Mutex::new(Vec::new()),
        }
    }

    fn mac(prompt: Step<()>) -> Self {
        Self {
            prompt,
            ..Self::base()
        }
    }

    fn linux(pkcheck: Step<PkcheckRun>) -> Self {
        Self {
            platform: Platform::Linux,
            pkcheck,
            ..Self::base()
        }
    }

    fn other(confirm: Step<Option<bool>>) -> Self {
        Self {
            platform: Platform::Other("win32".to_string()),
            confirm,
            ..Self::base()
        }
    }

    fn with_timeout(mut self, millis: u64) -> Self {
        self.timeout = Some(Duration::from_millis(millis));
        self
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().clone()
    }

    fn confirm_calls(&self) -> Vec<FallbackPrompt> {
        self.calls()
            .into_iter()
            .filter_map(|call| match call {
                Call::Confirm(prompt) => Some(prompt),
                _ => None,
            })
            .collect()
    }

    fn prompted(&self) -> bool {
        self.calls()
            .iter()
            .any(|call| matches!(call, Call::Prompt(_)))
    }

    fn pkchecked(&self) -> bool {
        self.calls()
            .iter()
            .any(|call| matches!(call, Call::Pkcheck(..)))
    }
}

async fn play<T: Clone + Send + 'static>(step: Step<T>) -> Result<T, String> {
    match step {
        Step::Value(value) => Ok(value),
        Step::Fail(message) => Err(message.to_string()),
        Step::Never => std::future::pending().await,
    }
}

impl UserPresenceDeps for Fake {
    fn platform(&self) -> Platform {
        self.platform.clone()
    }

    fn pid(&self) -> u32 {
        self.pid
    }

    fn timeout(&self) -> Option<Duration> {
        self.timeout
    }

    fn touch_id_can_prompt(&self) -> Result<bool, String> {
        self.calls.lock().push(Call::CanPrompt);
        self.can_prompt.map_err(str::to_string)
    }

    fn touch_id_prompt(&self, reason: &str) -> BoxFuture<'_, Result<(), String>> {
        self.calls.lock().push(Call::Prompt(reason.to_string()));
        Box::pin(play(self.prompt.clone()))
    }

    fn policy_installed(&self) -> bool {
        self.policy_installed
    }

    fn pkcheck(
        &self,
        args: &[String],
        timeout: Duration,
    ) -> BoxFuture<'_, Result<PkcheckRun, String>> {
        self.calls
            .lock()
            .push(Call::Pkcheck(args.to_vec(), timeout));
        Box::pin(play(self.pkcheck.clone()))
    }

    fn confirm(
        &self,
        prompt: FallbackPrompt,
        stop: CancellationToken,
    ) -> BoxFuture<'_, Result<Option<bool>, String>> {
        self.calls.lock().push(Call::Confirm(prompt));
        self.stops.lock().push(stop);
        Box::pin(play(self.confirm.clone()))
    }
}

fn ask() -> PresenceAsk {
    PresenceAsk {
        reason: "generate the script token \"ceo\"".to_string(),
        name: "ceo".to_string(),
    }
}

fn run(code: Option<i32>, stderr: &str) -> PkcheckRun {
    PkcheckRun {
        code,
        stderr: stderr.to_string(),
        missing: false,
        timed_out: false,
    }
}

fn missing_run() -> PkcheckRun {
    PkcheckRun {
        missing: true,
        ..run(None, "")
    }
}

fn timed_out_run() -> PkcheckRun {
    PkcheckRun {
        timed_out: true,
        ..run(None, "")
    }
}

fn allowed(via: PresenceVia) -> PresenceResult {
    PresenceResult::Allowed { via }
}

fn refused(code: PresenceFailure, detail: &str) -> PresenceResult {
    PresenceResult::Refused {
        code,
        detail: detail.to_string(),
        hint: None,
    }
}

fn code_of(result: &PresenceResult) -> PresenceFailure {
    match result {
        PresenceResult::Refused { code, .. } => *code,
        PresenceResult::Allowed { via } => panic!("expected a refusal, got allowed via {via:?}"),
    }
}

fn detail_of(result: &PresenceResult) -> String {
    match result {
        PresenceResult::Refused { detail, .. } => detail.clone(),
        PresenceResult::Allowed { via } => panic!("expected a refusal, got allowed via {via:?}"),
    }
}

fn hint_of(result: &PresenceResult) -> Option<PresenceHint> {
    match result {
        PresenceResult::Refused { hint, .. } => *hint,
        PresenceResult::Allowed { .. } => None,
    }
}

#[tokio::test(start_paused = true)]
async fn passes_once_touch_id_or_the_password_it_falls_back_to_succeeds_with_our_reason() {
    let fake = Fake::mac(Step::Value(()));
    assert_eq!(
        verify_user_presence(&ask(), &fake).await,
        allowed(PresenceVia::TouchId)
    );
    assert!(fake.calls().contains(&Call::Prompt(ask().reason)));
    assert!(fake.confirm_calls().is_empty());
}

#[tokio::test(start_paused = true)]
async fn refuses_whatever_the_system_prompt_rejects_with_without_the_ostia_dialog() {
    for message in [
        "Canceled by user.",
        "使用者已取消。",
        "Application retry limit exceeded.",
    ] {
        let fake = Fake::mac(Step::Fail(message));
        assert_eq!(
            verify_user_presence(&ask(), &fake).await,
            refused(
                PresenceFailure::Failed,
                &format!("Touch ID did not confirm: {message}")
            ),
            "{message}"
        );
        assert!(fake.confirm_calls().is_empty(), "{message}");
    }
}

#[tokio::test(start_paused = true)]
async fn refuses_with_timeout_when_the_prompt_is_never_answered() {
    let fake = Fake::mac(Step::Never).with_timeout(10);
    let result = verify_user_presence(&ask(), &fake).await;
    assert_eq!(
        result,
        refused(PresenceFailure::Timeout, "Touch ID got no answer in time")
    );
    assert!(fake.confirm_calls().is_empty());
}

#[tokio::test(start_paused = true)]
async fn asks_with_the_ostia_dialog_when_the_mac_has_no_touch_id_or_cannot_tell() {
    for (what, can_prompt) in [("has no Touch ID", Ok(false)), ("cannot tell", Err("boom"))] {
        let fake = Fake {
            can_prompt,
            ..Fake::base()
        };
        assert_eq!(
            verify_user_presence(&ask(), &fake).await,
            allowed(PresenceVia::Confirm),
            "{what}"
        );
        assert!(!fake.prompted(), "{what}");
        assert_eq!(
            fake.confirm_calls(),
            vec![FallbackPrompt {
                reason: ask().reason,
                name: ask().name,
                polkit_hint: false,
            }],
            "{what}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn asks_polkit_for_the_ostia_action_on_this_process() {
    let fake = Fake::linux(Step::Value(run(Some(0), "")));
    assert_eq!(
        verify_user_presence(&ask(), &fake).await,
        allowed(PresenceVia::Polkit)
    );
    assert!(fake.calls().contains(&Call::Pkcheck(
        vec![
            "--action-id".to_string(),
            POLKIT_ACTION.to_string(),
            "--process".to_string(),
            "4242".to_string(),
            "--allow-user-interaction".to_string(),
        ],
        Duration::from_millis(1_000),
    )));
    assert!(fake.confirm_calls().is_empty());
}

#[tokio::test(start_paused = true)]
async fn refuses_when_the_action_is_installed_and_polkit_says_no_never_falling_back_to_the_ostia_dialog()
 {
    let table = [
        (
            "refused",
            run(Some(1), "Not authorized."),
            PresenceFailure::Failed,
        ),
        (
            "without an agent",
            run(Some(2), "No authentication agent found."),
            PresenceFailure::Unavailable,
        ),
        (
            "dismissed",
            run(Some(3), "Authentication dialog was dismissed"),
            PresenceFailure::Cancelled,
        ),
        ("timed out", timed_out_run(), PresenceFailure::Timeout),
        (
            "missing pkcheck",
            missing_run(),
            PresenceFailure::Unavailable,
        ),
        (
            "not told about the action",
            run(
                Some(127),
                &format!("Action {POLKIT_ACTION} is not registered"),
            ),
            PresenceFailure::Failed,
        ),
        (
            "broken",
            run(Some(127), "Error checking for authorization"),
            PresenceFailure::Failed,
        ),
    ];
    for (what, polkit, code) in table {
        let fake = Fake::linux(Step::Value(polkit));
        let result = verify_user_presence(&ask(), &fake).await;
        assert_eq!(code_of(&result), code, "{what}");
        assert!(fake.confirm_calls().is_empty(), "{what}");
    }
}

#[tokio::test(start_paused = true)]
async fn tells_the_user_to_install_an_agent_when_the_action_is_installed_but_no_agent_answers() {
    let fake = Fake::linux(Step::Value(run(Some(2), "No authentication agent found.")));
    let result = verify_user_presence(&ask(), &fake).await;
    assert_eq!(code_of(&result), PresenceFailure::Unavailable);
    assert_eq!(hint_of(&result), Some(PresenceHint::PolkitAgent));
    assert!(detail_of(&result).contains("install and start the one for your desktop"));
}

#[tokio::test(start_paused = true)]
async fn asks_with_the_ostia_dialog_and_the_install_hint_only_when_the_polkit_action_is_not_installed()
 {
    let fake = Fake {
        policy_installed: false,
        ..Fake::linux(Step::Value(run(Some(0), "")))
    };
    assert_eq!(
        verify_user_presence(&ask(), &fake).await,
        allowed(PresenceVia::Confirm)
    );
    assert!(!fake.pkchecked());
    assert_eq!(
        fake.confirm_calls(),
        vec![FallbackPrompt {
            reason: ask().reason,
            name: ask().name,
            polkit_hint: true,
        }]
    );
}

#[tokio::test(start_paused = true)]
async fn refuses_with_failed_when_running_pkcheck_throws() {
    let fake = Fake::linux(Step::Fail("EMFILE"));
    let result = verify_user_presence(&ask(), &fake).await;
    assert_eq!(code_of(&result), PresenceFailure::Failed);
    assert_eq!(detail_of(&result), "system authentication failed: EMFILE");
    assert!(fake.confirm_calls().is_empty());
}

#[tokio::test(start_paused = true)]
async fn is_the_only_way_on_a_platform_with_no_system_authentication() {
    let fake = Fake::other(Step::Value(Some(true)));
    assert_eq!(
        verify_user_presence(&ask(), &fake).await,
        allowed(PresenceVia::Confirm)
    );
    assert!(!fake.prompted());
    assert!(!fake.pkchecked());
    assert_eq!(
        fake.confirm_calls(),
        vec![FallbackPrompt {
            reason: ask().reason,
            name: ask().name,
            polkit_hint: false,
        }]
    );
}

#[tokio::test(start_paused = true)]
async fn refuses_when_the_dialog_is_declined_never_answered_impossible_to_show_or_broken() {
    let table = [
        (
            "declined",
            Step::Value(Some(false)),
            None,
            PresenceFailure::Cancelled,
        ),
        (
            "never answered",
            Step::Never,
            Some(10),
            PresenceFailure::Timeout,
        ),
        (
            "impossible to show",
            Step::Value(None),
            None,
            PresenceFailure::Unavailable,
        ),
        (
            "broken",
            Step::Fail("no display"),
            None,
            PresenceFailure::Failed,
        ),
    ];
    for (what, confirm, timeout, code) in table {
        let mut fake = Fake::other(confirm);
        if let Some(millis) = timeout {
            fake = fake.with_timeout(millis);
        }
        let result = verify_user_presence(&ask(), &fake).await;
        assert_eq!(code_of(&result), code, "{what}");
    }
}

#[tokio::test(start_paused = true)]
async fn closes_the_page_when_the_confirmation_times_out() {
    let fake = Fake::other(Step::Never).with_timeout(20);
    let result = verify_user_presence(&ask(), &fake).await;
    assert_eq!(code_of(&result), PresenceFailure::Timeout);
    let stops = fake.stops.lock();
    assert_eq!(stops.len(), 1);
    assert!(stops[0].is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn stops_the_dialog_after_every_answer() {
    for confirm in [
        Step::Value(Some(true)),
        Step::Value(Some(false)),
        Step::Value(None),
        Step::Fail("no display"),
    ] {
        let fake = Fake::other(confirm);
        verify_user_presence(&ask(), &fake).await;
        let stops = fake.stops.lock();
        assert_eq!(stops.len(), 1);
        assert!(stops[0].is_cancelled());
    }
}

#[tokio::test(start_paused = true)]
async fn waits_two_minutes_for_an_answer_when_the_deps_set_no_timeout() {
    assert_eq!(PRESENCE_TIMEOUT, Duration::from_millis(120_000));
    let fake = Fake {
        timeout: None,
        ..Fake::mac(Step::Never)
    };
    let started = tokio::time::Instant::now();
    let result = verify_user_presence(&ask(), &fake).await;
    assert_eq!(code_of(&result), PresenceFailure::Timeout);
    assert_eq!(started.elapsed(), Duration::from_millis(120_000));
}

#[tokio::test(start_paused = true)]
async fn passes_the_polkit_timeout_through_to_pkcheck() {
    let fake = Fake {
        timeout: None,
        ..Fake::linux(Step::Value(run(Some(0), "")))
    };
    verify_user_presence(&ask(), &fake).await;
    assert!(fake.calls().iter().any(
        |call| matches!(call, Call::Pkcheck(_, timeout) if *timeout == Duration::from_millis(120_000))
    ));
}

#[tokio::test(start_paused = true)]
async fn words_every_refusal_exactly_as_the_ts_code_does() {
    let polkit = |polkit: PkcheckRun| async move {
        let fake = Fake::linux(Step::Value(polkit));
        verify_user_presence(&ask(), &fake).await
    };
    let table = [
        (
            "refused with stderr",
            polkit(run(Some(1), "Not authorized.\n")).await,
            refused(PresenceFailure::Failed, "polkit refused: Not authorized."),
        ),
        (
            "refused without stderr",
            polkit(run(Some(1), "  \n")).await,
            refused(PresenceFailure::Failed, "polkit refused"),
        ),
        (
            "dismissed",
            polkit(run(Some(3), "ignored text")).await,
            refused(
                PresenceFailure::Cancelled,
                "the polkit prompt was dismissed",
            ),
        ),
        (
            "timed out",
            polkit(timed_out_run()).await,
            refused(PresenceFailure::Timeout, "polkit got no answer in time"),
        ),
        (
            "missing with stderr",
            polkit(PkcheckRun {
                stderr: "not in /usr/bin/pkcheck, /bin/pkcheck".to_string(),
                ..missing_run()
            })
            .await,
            refused(
                PresenceFailure::Unavailable,
                "pkcheck is not installed: not in /usr/bin/pkcheck, /bin/pkcheck",
            ),
        ),
        (
            "other code",
            polkit(run(Some(127), "Error checking for authorization\n")).await,
            refused(
                PresenceFailure::Failed,
                "pkcheck exited with 127: Error checking for authorization",
            ),
        ),
        (
            "killed by a signal",
            polkit(run(None, "")).await,
            refused(PresenceFailure::Failed, "pkcheck exited with a signal"),
        ),
        (
            "timed out wins over the exit code",
            polkit(PkcheckRun {
                code: Some(0),
                ..timed_out_run()
            })
            .await,
            refused(PresenceFailure::Timeout, "polkit got no answer in time"),
        ),
        (
            "missing wins over timed out",
            polkit(PkcheckRun {
                missing: true,
                timed_out: true,
                ..run(None, "")
            })
            .await,
            refused(PresenceFailure::Unavailable, "pkcheck is not installed"),
        ),
    ];
    for (what, got, want) in table {
        assert_eq!(got, want, "{what}");
    }
}

#[tokio::test(start_paused = true)]
async fn words_the_agent_refusal_with_the_agent_names_the_hint_and_the_stderr() {
    let fake = Fake::linux(Step::Value(run(
        Some(2),
        "No authentication agent found.\n",
    )));
    assert_eq!(
        verify_user_presence(&ask(), &fake).await,
        PresenceResult::Refused {
            code: PresenceFailure::Unavailable,
            detail: "no polkit authentication agent is running; install and start the one for your desktop (polkit-gnome, polkit-kde-agent-1, lxqt-policykit or mate-polkit) and try again: No authentication agent found.".to_string(),
            hint: Some(PresenceHint::PolkitAgent),
        }
    );
    let bare = Fake::linux(Step::Value(run(Some(2), "")));
    assert!(detail_of(&verify_user_presence(&ask(), &bare).await).ends_with("and try again"));
}

#[tokio::test(start_paused = true)]
async fn words_the_fallback_reason_for_each_way_the_system_prompt_cannot_run() {
    let mac = Fake {
        can_prompt: Ok(false),
        confirm: Step::Value(None),
        ..Fake::base()
    };
    assert_eq!(
        verify_user_presence(&ask(), &mac).await,
        refused(
            PresenceFailure::Unavailable,
            "Touch ID is not available on this Mac, and no window can ask instead"
        )
    );
    let linux = Fake {
        policy_installed: false,
        confirm: Step::Value(None),
        ..Fake::linux(Step::Value(run(Some(0), "")))
    };
    assert_eq!(
        verify_user_presence(&ask(), &linux).await,
        refused(
            PresenceFailure::Unavailable,
            &format!(
                "the polkit action {POLKIT_ACTION} is not installed, and no window can ask instead"
            )
        )
    );
    let other = Fake::other(Step::Value(None));
    assert_eq!(
        verify_user_presence(&ask(), &other).await,
        refused(
            PresenceFailure::Unavailable,
            "no system authentication on win32, and no window can ask instead"
        )
    );
}

#[tokio::test(start_paused = true)]
async fn words_the_dialog_refusals_exactly_as_the_ts_code_does() {
    let table = [
        (
            Step::Value(Some(false)),
            refused(PresenceFailure::Cancelled, "the confirmation was declined"),
        ),
        (
            Step::Fail("no display"),
            refused(
                PresenceFailure::Failed,
                "the confirmation failed: no display",
            ),
        ),
    ];
    for (confirm, want) in table {
        let fake = Fake::other(confirm);
        assert_eq!(verify_user_presence(&ask(), &fake).await, want);
    }
    let slow = Fake::other(Step::Never).with_timeout(10);
    assert_eq!(
        verify_user_presence(&ask(), &slow).await,
        refused(
            PresenceFailure::Timeout,
            "the confirmation got no answer in time"
        )
    );
}

#[tokio::test(start_paused = true)]
async fn never_shows_the_ostia_dialog_after_a_touch_id_prompt_that_the_user_answered_with_an_error()
{
    let fake = Fake::mac(Step::Fail("Canceled by user."));
    verify_user_presence(&ask(), &fake).await;
    assert!(fake.confirm_calls().is_empty());
    assert!(fake.stops.lock().is_empty());
}

static SCRIPTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn lock_scripts() -> tokio::sync::MutexGuard<'static, ()> {
    SCRIPTS.lock().await
}

fn fake_bin(dir: &Path, name: &str, script: &str) -> PathBuf {
    let file = dir.join(name);
    fs::write(&file, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
    file
}

#[tokio::test]
async fn runs_the_first_pkcheck_that_exists_and_reports_its_exit_code_and_stderr() {
    let _scripts = lock_scripts().await;
    let dir = tempfile::tempdir().unwrap();
    let second = fake_bin(dir.path(), "second", "echo \"second $@\" >&2; exit 3");
    fake_bin(dir.path(), "pkcheck", "exit 0");
    let args = vec!["--action-id".to_string(), "x".to_string()];
    let got = run_pkcheck(
        &args,
        Duration::from_millis(5_000),
        &[dir.path().join("gone"), second],
    )
    .await;
    assert_eq!(got, run(Some(3), "second --action-id x\n"));
}

#[tokio::test]
async fn looks_only_at_the_fixed_paths_not_path() {
    let _scripts = lock_scripts().await;
    let dir = tempfile::tempdir().unwrap();
    fake_bin(dir.path(), "pkcheck", "exit 0");
    let got = run_pkcheck(
        &[],
        Duration::from_millis(5_000),
        &[dir.path().join("nope")],
    )
    .await;
    assert_eq!(got.code, None);
    assert!(got.missing);
    assert!(!got.timed_out);
}

#[tokio::test]
async fn stops_a_pkcheck_that_never_answers() {
    let _scripts = lock_scripts().await;
    let dir = tempfile::tempdir().unwrap();
    let slow = fake_bin(dir.path(), "slow", "exec sleep 30");
    let started = std::time::Instant::now();
    let got = run_pkcheck(&[], Duration::from_millis(50), &[slow]).await;
    assert!(got.timed_out, "got {got:?}");
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn reports_the_missing_paths_in_the_stderr_of_a_missing_pkcheck() {
    let dir = tempfile::tempdir().unwrap();
    let one = dir.path().join("one");
    let two = dir.path().join("two");
    let got = run_pkcheck(
        &[],
        Duration::from_millis(5_000),
        &[one.clone(), two.clone()],
    )
    .await;
    assert_eq!(
        got,
        PkcheckRun {
            code: None,
            stderr: format!("not in {}, {}", one.display(), two.display()),
            missing: true,
            timed_out: false,
        }
    );
}

#[tokio::test]
async fn reports_a_pkcheck_that_cannot_start_with_no_code_and_the_error_text() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("not-executable");
    fs::write(&file, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    let got = run_pkcheck(&[], Duration::from_millis(5_000), &[file]).await;
    assert_eq!(got.code, None);
    assert!(!got.stderr.is_empty());
    assert!(!got.missing);
    assert!(!got.timed_out);
}

#[tokio::test]
async fn reports_the_exit_code_of_a_pkcheck_that_ends_inside_the_timeout_without_a_timed_out_flag()
{
    let _scripts = lock_scripts().await;
    let dir = tempfile::tempdir().unwrap();
    let quick = fake_bin(dir.path(), "quick", "exit 1");
    let got = run_pkcheck(&[], Duration::from_millis(5_000), &[quick]).await;
    assert_eq!(got, run(Some(1), ""));
}

#[test]
fn looks_for_pkcheck_in_usr_bin_and_bin_by_default() {
    assert_eq!(PKCHECK_PATHS, ["/usr/bin/pkcheck", "/bin/pkcheck"]);
}

fn english() -> FallbackText {
    FallbackText {
        title: "Confirm it is you".to_string(),
        message: "Allow {product} to {reason}?".to_string(),
        type_name: "Type \"{name}\" to allow it".to_string(),
        detail_mac: "This Mac has no Touch ID, so {product} asks here instead.".to_string(),
        detail_linux: "System authentication is not set up for {product}, so it asks here instead. To confirm with your password or fingerprint through polkit, run: {command}".to_string(),
        detail_other: "This computer has no system authentication {product} can use, so it asks here instead.".to_string(),
        confirm: "Allow".to_string(),
        cancel: "Cancel".to_string(),
    }
}

fn zh_hant() -> FallbackText {
    FallbackText {
        title: "確認是你本人".to_string(),
        message: "要讓 {product} {reason}嗎？".to_string(),
        type_name: "輸入「{name}」才能允許".to_string(),
        detail_mac: "這台 Mac 沒有 Touch ID，所以 {product} 改在這裡確認。".to_string(),
        detail_linux: "這台電腦沒有啟用 {product} 的系統驗證，所以改在這裡確認。要改用密碼或指紋（polkit）確認，請執行：{command}".to_string(),
        detail_other: "這台電腦沒有 {product} 能用的系統驗證，所以改在這裡確認。".to_string(),
        confirm: "允許".to_string(),
        cancel: "取消".to_string(),
    }
}

fn prompt(name: &str, platform: &Platform, reason: &str) -> FallbackPrompt {
    FallbackPrompt {
        reason: reason.to_string(),
        name: name.to_string(),
        polkit_hint: *platform == Platform::Linux,
    }
}

fn lines(name: &str, platform: Platform, text: &FallbackText, reason: &str) -> FallbackLines {
    let command = install_polkit_command("/opt/Ostia/resources");
    fallback_lines(&prompt(name, &platform, reason), &platform, text, &command)
}

#[test]
fn keeps_allow_disabled_until_the_token_name_is_typed_exactly() {
    for wrong in ["", "ce", "CEO", "ceo ", " ceo", "x", "ceoo"] {
        assert!(!name_confirmed(wrong, "ceo"), "{wrong:?}");
    }
    assert!(name_confirmed("ceo", "ceo"));
    assert!(name_confirmed("<b>\"x\"</b>", "<b>\"x\"</b>"));
}

#[test]
fn accepts_an_allow_only_for_the_exact_name_whatever_the_page_says() {
    assert_eq!(
        fallback_answer("ostia-presence:allow:ceo", "ceo"),
        Some(true)
    );
    assert_eq!(
        fallback_answer("ostia-presence:allow:ceo2", "ceo"),
        Some(false)
    );
    assert_eq!(fallback_answer("ostia-presence:allow:", "ceo"), Some(false));
    assert_eq!(fallback_answer("Confirm it is you", "ceo"), None);
}

#[test]
fn answers_cancel_for_the_cancel_title() {
    assert_eq!(fallback_answer("ostia-presence:cancel", "ceo"), Some(false));
    assert_eq!(fallback_answer("ostia-presence:cancel", ""), Some(false));
}

#[test]
fn answers_nothing_for_a_title_that_only_looks_like_the_markers() {
    for title in [
        "",
        "ostia-presence:cancelled",
        "ostia-presence:cance",
        "OSTIA-PRESENCE:ALLOW:ceo",
        " ostia-presence:allow:ceo",
        "ostia-presence:allow",
    ] {
        assert_eq!(fallback_answer(title, "ceo"), None, "{title:?}");
    }
}

#[test]
fn tells_a_linux_user_how_to_turn_on_polkit_with_a_path_sudo_can_find() {
    let command = install_polkit_command("/opt/Ostia/resources");
    assert_eq!(
        command,
        "sudo \"/opt/Ostia/resources/bin/ostia\" install-polkit"
    );
    let got = lines("ceo", Platform::Linux, &zh_hant(), "產生腳本權杖「ceo」");
    assert_eq!(got.message, "要讓 Ostia 產生腳本權杖「ceo」嗎？");
    assert_eq!(got.type_name, "輸入「ceo」才能允許");
    assert!(got.detail.contains(&command));
    let mac = lines(
        "ceo",
        Platform::Darwin,
        &english(),
        "generate the script token \"ceo\"",
    );
    assert!(!mac.detail.contains("install-polkit"));
}

#[test]
fn fills_the_english_lines_for_each_platform() {
    let reason = "generate the script token \"ceo\"";
    let command = install_polkit_command("/opt/Ostia/resources");
    let linux = lines("ceo", Platform::Linux, &english(), reason);
    assert_eq!(
        linux,
        FallbackLines {
            title: "Confirm it is you".to_string(),
            message: "Allow Ostia to generate the script token \"ceo\"?".to_string(),
            detail: format!(
                "System authentication is not set up for Ostia, so it asks here instead. To confirm with your password or fingerprint through polkit, run: {command}"
            ),
            type_name: "Type \"ceo\" to allow it".to_string(),
            confirm: "Allow".to_string(),
            cancel: "Cancel".to_string(),
        }
    );
    assert_eq!(
        lines("ceo", Platform::Darwin, &english(), reason).detail,
        "This Mac has no Touch ID, so Ostia asks here instead."
    );
    assert_eq!(
        lines(
            "ceo",
            Platform::Other("win32".to_string()),
            &english(),
            reason
        )
        .detail,
        "This computer has no system authentication Ostia can use, so it asks here instead."
    );
}

#[test]
fn picks_the_detail_by_platform_and_the_polkit_hint_as_ts_does() {
    let text = english();
    let command = install_polkit_command("/opt/Ostia/resources");
    let table = [
        (Platform::Darwin, true, text.detail_mac.as_str()),
        (Platform::Darwin, false, text.detail_mac.as_str()),
        (Platform::Linux, true, text.detail_linux.as_str()),
        (Platform::Linux, false, text.detail_other.as_str()),
        (
            Platform::Other("win32".to_string()),
            true,
            text.detail_linux.as_str(),
        ),
        (
            Platform::Other("win32".to_string()),
            false,
            text.detail_other.as_str(),
        ),
    ];
    for (platform, polkit_hint, template) in table {
        let prompt = FallbackPrompt {
            reason: "r".to_string(),
            name: "n".to_string(),
            polkit_hint,
        };
        let got = fallback_lines(&prompt, &platform, &text, &command);
        let want = template
            .replace("{product}", "Ostia")
            .replace("{command}", &command);
        assert_eq!(got.detail, want, "{platform:?} hint {polkit_hint}");
    }
}

#[test]
fn keeps_an_unknown_placeholder_and_fills_the_product_name_everywhere_after_filling_the_values() {
    let mut text = english();
    text.message = "{reason} {unknown} {product}".to_string();
    let got = lines("{product}", Platform::Darwin, &text, "a {product} b");
    assert_eq!(got.message, "a Ostia b {unknown} Ostia");
    assert_eq!(got.type_name, "Type \"Ostia\" to allow it");
}

#[test]
fn leaves_the_name_and_reason_as_plain_text_without_escaping() {
    let got = lines("<b>\"x\"</b>", Platform::Darwin, &english(), "run <script>");
    assert_eq!(got.type_name, "Type \"<b>\"x\"</b>\" to allow it");
    assert_eq!(got.message, "Allow Ostia to run <script>?");
}
