#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use ostia_base::events::EventHub;
use ostia_panes::start_confirm::{
    EntryStatus, EntryView, START_TIMING, StartOutcome, StartReport, StartTiming, StartWatch,
    TurnProbe, TurnReport, TurnWatch, confirm_start, confirm_turn, start_message,
};
use parking_lot::Mutex;
use tokio::task::JoinHandle;

#[derive(Clone)]
struct Scene {
    entry: Arc<Mutex<EntryView>>,
    output: Arc<Mutex<String>>,
    agent_started: Arc<Mutex<bool>>,
    changes: EventHub<()>,
}

impl Scene {
    fn new(status: EntryStatus) -> Self {
        Self {
            entry: Arc::new(Mutex::new(EntryView {
                pane_id: "p1".to_owned(),
                status,
                exit_code: None,
            })),
            output: Arc::new(Mutex::new(String::new())),
            agent_started: Arc::new(Mutex::new(false)),
            changes: EventHub::default(),
        }
    }

    fn set(&self, status: EntryStatus, exit_code: Option<i64>) {
        let mut entry = self.entry.lock();
        entry.status = status;
        entry.exit_code = exit_code;
    }

    fn print(&self, text: &str) {
        *self.output.lock() = text.to_owned();
    }

    fn watch(&self, agent_hook: bool, timing: StartTiming) -> StartWatch {
        let entry = Arc::clone(&self.entry);
        let output = Arc::clone(&self.output);
        let started = Arc::clone(&self.agent_started);
        StartWatch {
            entry: Arc::new(move || entry.lock().clone()),
            output: Arc::new(move || output.lock().clone()),
            agent_hook,
            agent_started: Arc::new(move |pane_id| pane_id == "p1" && *started.lock()),
            changes: self.changes.clone(),
            timing,
        }
    }
}

fn ms(value: u64) -> Duration {
    Duration::from_millis(value)
}

fn slow_poll() -> StartTiming {
    StartTiming {
        poll: Duration::from_secs(3600),
        ..START_TIMING
    }
}

fn run(scene: &Scene, agent_hook: bool, timing: StartTiming) -> JoinHandle<StartReport> {
    tokio::spawn(confirm_start(scene.watch(agent_hook, timing)))
}

async fn pass(duration: Duration) {
    tokio::time::advance(duration).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

async fn ready<T>(handle: JoinHandle<T>) -> T {
    pass(Duration::ZERO).await;
    assert!(handle.is_finished(), "still waiting");
    handle.await.unwrap()
}

fn lines(report: &StartReport) -> Vec<&str> {
    report
        .output
        .as_ref()
        .unwrap()
        .iter()
        .map(String::as_str)
        .collect()
}

#[test]
fn keeps_the_ts_timing_numbers() {
    assert_eq!(START_TIMING.settle, ms(1000));
    assert_eq!(START_TIMING.process, ms(15_000));
    assert_eq!(START_TIMING.agent, ms(60_000));
    assert_eq!(START_TIMING.turn, ms(20_000));
    assert_eq!(START_TIMING.poll, ms(200));
}

#[tokio::test(start_paused = true)]
async fn says_a_command_started_once_it_ran_for_the_settle_time() {
    let scene = Scene::new(EntryStatus::Running);
    let handle = run(&scene, false, START_TIMING);
    pass(ms(800)).await;
    assert!(!handle.is_finished());
    pass(ms(600)).await;
    let report = ready(handle).await;
    assert_eq!(report.status, StartOutcome::Started);
    assert_eq!(report.exit_code, None);
    assert_eq!(report.reason, None);
    assert_eq!(report.output, None);
}

#[tokio::test(start_paused = true)]
async fn counts_the_settle_time_from_the_first_time_it_saw_the_command_running() {
    let scene = Scene::new(EntryStatus::Starting);
    let handle = run(&scene, false, START_TIMING);
    pass(ms(5000)).await;
    scene.set(EntryStatus::Running, None);
    pass(ms(600)).await;
    assert!(!handle.is_finished());
    pass(ms(1000)).await;
    assert_eq!(ready(handle).await.status, StartOutcome::Started);
}

#[tokio::test(start_paused = true)]
async fn reports_a_command_that_ended_with_zero_as_exited_with_its_output() {
    let scene = Scene::new(EntryStatus::Exited);
    scene.set(EntryStatus::Exited, Some(0));
    scene.print("built\ndone\n");
    let report = ready(run(&scene, false, START_TIMING)).await;
    assert_eq!(report.status, StartOutcome::Exited);
    assert_eq!(report.exit_code, Some(0));
    assert_eq!(lines(&report), vec!["built", "done"]);
    assert_eq!(report.reason, None);
}

#[tokio::test(start_paused = true)]
async fn reports_a_command_that_ended_with_a_code_as_failed_with_the_code_in_the_reason() {
    let scene = Scene::new(EntryStatus::Exited);
    scene.set(EntryStatus::Exited, Some(2));
    scene.print("boom\n");
    let report = ready(run(&scene, false, START_TIMING)).await;
    assert_eq!(report.status, StartOutcome::Failed);
    assert_eq!(report.exit_code, Some(2));
    assert_eq!(
        report.reason.as_deref(),
        Some("the command ended with exit code 2")
    );
    assert_eq!(lines(&report), vec!["boom"]);
}

#[tokio::test(start_paused = true)]
async fn reports_a_command_that_ended_with_no_code_as_failed_without_a_code() {
    let scene = Scene::new(EntryStatus::Exited);
    let report = ready(run(&scene, false, START_TIMING)).await;
    assert_eq!(report.status, StartOutcome::Failed);
    assert_eq!(report.exit_code, None);
    assert_eq!(
        report.reason.as_deref(),
        Some("the command ended with exit code unknown")
    );
    assert_eq!(report.output, Some(Vec::new()));
}

#[tokio::test(start_paused = true)]
async fn reports_a_closed_tab_as_failed_with_no_output() {
    let scene = Scene::new(EntryStatus::Closed);
    scene.print("left over\n");
    let report = ready(run(&scene, false, START_TIMING)).await;
    assert_eq!(report.status, StartOutcome::Failed);
    assert_eq!(report.reason.as_deref(), Some("its tab was closed"));
    assert_eq!(report.output, None);
    assert_eq!(report.exit_code, None);
}

#[tokio::test(start_paused = true)]
async fn times_out_when_the_tab_never_reaches_a_ready_prompt() {
    let scene = Scene::new(EntryStatus::Starting);
    let handle = run(&scene, false, START_TIMING);
    pass(ms(14_000)).await;
    assert!(!handle.is_finished());
    pass(ms(2000)).await;
    let report = ready(handle).await;
    assert_eq!(report.status, StartOutcome::TimedOut);
    assert_eq!(
        report.reason.as_deref(),
        Some("the command did not start: its tab never reached a ready prompt")
    );
}

#[tokio::test(start_paused = true)]
async fn says_started_for_an_agent_as_soon_as_it_reports_its_start_while_the_command_runs() {
    let scene = Scene::new(EntryStatus::Running);
    *scene.agent_started.lock() = true;
    let report = ready(run(&scene, true, START_TIMING)).await;
    assert_eq!(report.status, StartOutcome::Started);
}

#[tokio::test(start_paused = true)]
async fn waits_for_the_agent_to_report_its_start_and_does_not_count_the_settle_time() {
    let scene = Scene::new(EntryStatus::Running);
    let handle = run(&scene, true, START_TIMING);
    pass(ms(5000)).await;
    assert!(!handle.is_finished());
    *scene.agent_started.lock() = true;
    pass(ms(400)).await;
    assert_eq!(ready(handle).await.status, StartOutcome::Started);
}

#[tokio::test(start_paused = true)]
async fn times_out_when_the_agent_does_not_report_its_start() {
    let scene = Scene::new(EntryStatus::Running);
    let handle = run(&scene, true, START_TIMING);
    pass(ms(59_000)).await;
    assert!(!handle.is_finished());
    pass(ms(2000)).await;
    let report = ready(handle).await;
    assert_eq!(report.status, StartOutcome::TimedOut);
    assert_eq!(
        report.reason.as_deref(),
        Some("the agent did not report its start")
    );
}

#[tokio::test(start_paused = true)]
async fn times_out_an_agent_whose_tab_never_got_ready_with_the_prompt_reason() {
    let scene = Scene::new(EntryStatus::Starting);
    let handle = run(&scene, true, START_TIMING);
    pass(ms(61_000)).await;
    let report = ready(handle).await;
    assert_eq!(report.status, StartOutcome::TimedOut);
    assert_eq!(
        report.reason.as_deref(),
        Some("the command did not start: its tab never reached a ready prompt")
    );
}

#[tokio::test(start_paused = true)]
async fn fails_an_agent_that_ended_before_it_started_also_with_exit_code_zero() {
    for (code, reason) in [
        (
            Some(0),
            "the agent's command ended with exit code 0 before the agent started",
        ),
        (
            Some(1),
            "the agent's command ended with exit code 1 before the agent started",
        ),
        (None, "the agent's command ended before the agent started"),
    ] {
        let scene = Scene::new(EntryStatus::Exited);
        scene.set(EntryStatus::Exited, code);
        let report = ready(run(&scene, true, START_TIMING)).await;
        assert_eq!(report.status, StartOutcome::Failed, "{code:?}");
        assert_eq!(report.reason.as_deref(), Some(reason), "{code:?}");
        assert_eq!(report.exit_code, code, "{code:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn counts_an_agent_that_exited_as_failed_even_when_it_reported_its_start() {
    let scene = Scene::new(EntryStatus::Exited);
    scene.set(EntryStatus::Exited, Some(0));
    *scene.agent_started.lock() = true;
    let report = ready(run(&scene, true, START_TIMING)).await;
    assert_eq!(report.status, StartOutcome::Failed);
}

#[tokio::test(start_paused = true)]
async fn counts_a_closed_tab_before_an_agent_start() {
    let scene = Scene::new(EntryStatus::Closed);
    *scene.agent_started.lock() = true;
    let report = ready(run(&scene, true, START_TIMING)).await;
    assert_eq!(report.status, StartOutcome::Failed);
    assert_eq!(report.reason.as_deref(), Some("its tab was closed"));
}

#[tokio::test(start_paused = true)]
async fn looks_again_when_the_change_signal_fires_without_waiting_for_the_poll() {
    let scene = Scene::new(EntryStatus::Running);
    let handle = run(&scene, true, slow_poll());
    pass(ms(10)).await;
    assert!(!handle.is_finished());
    *scene.agent_started.lock() = true;
    scene.changes.emit(());
    assert_eq!(ready(handle).await.status, StartOutcome::Started);
}

#[tokio::test(start_paused = true)]
async fn looks_again_on_the_poll_when_no_signal_comes() {
    let scene = Scene::new(EntryStatus::Running);
    let timing = StartTiming {
        poll: ms(500),
        ..START_TIMING
    };
    let handle = run(&scene, true, timing);
    pass(ms(100)).await;
    *scene.agent_started.lock() = true;
    pass(ms(100)).await;
    assert!(!handle.is_finished());
    pass(ms(400)).await;
    assert_eq!(ready(handle).await.status, StartOutcome::Started);
}

#[tokio::test(start_paused = true)]
async fn keeps_the_last_twenty_lines_of_output_and_drops_trailing_white_space() {
    let scene = Scene::new(EntryStatus::Exited);
    scene.set(EntryStatus::Exited, Some(0));
    let text: String = (1..=25).map(|n| format!("l{n}\n")).collect::<String>() + "\n  \n";
    scene.print(&text);
    let report = ready(run(&scene, false, START_TIMING)).await;
    let want: Vec<String> = (6..=25).map(|n| format!("l{n}")).collect();
    assert_eq!(report.output, Some(want));
}

#[tokio::test(start_paused = true)]
async fn gives_no_lines_for_output_that_is_only_white_space() {
    let scene = Scene::new(EntryStatus::Exited);
    scene.set(EntryStatus::Exited, Some(0));
    scene.print("  \n\t\n");
    let report = ready(run(&scene, false, START_TIMING)).await;
    assert_eq!(report.output, Some(Vec::new()));
}

#[tokio::test(start_paused = true)]
async fn keeps_leading_blank_lines_of_a_short_output() {
    let scene = Scene::new(EntryStatus::Exited);
    scene.set(EntryStatus::Exited, Some(0));
    scene.print("\nfirst\nsecond  \n");
    let report = ready(run(&scene, false, START_TIMING)).await;
    assert_eq!(lines(&report), vec!["", "first", "second"]);
}

struct Probe {
    state: Arc<Mutex<Option<String>>>,
    session: Arc<Mutex<Option<String>>>,
}

impl TurnProbe for Probe {
    async fn turn_state(&self, _pane_id: &str) -> Option<String> {
        self.state.lock().clone()
    }

    async fn session(&self, _pane_id: &str) -> Option<String> {
        self.session.lock().clone()
    }
}

struct Turn {
    scene: Scene,
    state: Arc<Mutex<Option<String>>>,
    session: Arc<Mutex<Option<String>>>,
}

impl Turn {
    fn new(status: EntryStatus) -> Self {
        Self {
            scene: Scene::new(status),
            state: Arc::new(Mutex::new(None)),
            session: Arc::new(Mutex::new(None)),
        }
    }

    fn run(&self, timing: StartTiming) -> JoinHandle<TurnReport> {
        let entry = Arc::clone(&self.scene.entry);
        let watch = TurnWatch {
            entry: Arc::new(move || entry.lock().clone()),
            probe: Probe {
                state: Arc::clone(&self.state),
                session: Arc::clone(&self.session),
            },
            changes: self.scene.changes.clone(),
            timing,
        };
        tokio::spawn(confirm_turn(watch))
    }
}

#[tokio::test(start_paused = true)]
async fn confirms_a_turn_for_each_state_that_shows_the_agent_took_the_prompt() {
    for state in ["working", "waiting", "done", "error"] {
        let turn = Turn::new(EntryStatus::Running);
        *turn.state.lock() = Some(state.to_owned());
        let report = ready(turn.run(START_TIMING)).await;
        assert!(report.turn_started, "{state}");
        assert_eq!(report.session, None, "{state}");
    }
}

#[tokio::test(start_paused = true)]
async fn does_not_confirm_a_turn_for_a_state_that_is_not_one_of_the_four() {
    for state in [None, Some("idle"), Some("starting"), Some("")] {
        let turn = Turn::new(EntryStatus::Running);
        *turn.state.lock() = state.map(str::to_owned);
        let handle = turn.run(START_TIMING);
        pass(ms(19_000)).await;
        assert!(!handle.is_finished(), "{state:?}");
        pass(ms(2000)).await;
        let report = ready(handle).await;
        assert!(!report.turn_started, "{state:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn gives_up_on_a_turn_when_the_command_ended_or_its_tab_closed() {
    for status in [EntryStatus::Exited, EntryStatus::Closed] {
        let turn = Turn::new(status);
        *turn.state.lock() = Some("working".to_owned());
        let report = ready(turn.run(START_TIMING)).await;
        assert!(!report.turn_started, "{status:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn confirms_a_turn_that_starts_later_on_the_next_change_signal() {
    let turn = Turn::new(EntryStatus::Running);
    let handle = turn.run(slow_poll());
    pass(ms(50)).await;
    assert!(!handle.is_finished());
    *turn.state.lock() = Some("working".to_owned());
    turn.scene.changes.emit(());
    assert!(ready(handle).await.turn_started);
}

#[tokio::test(start_paused = true)]
async fn adds_the_session_when_there_is_one_and_leaves_it_out_when_empty() {
    let turn = Turn::new(EntryStatus::Running);
    *turn.state.lock() = Some("done".to_owned());
    *turn.session.lock() = Some("s-42".to_owned());
    let report = ready(turn.run(START_TIMING)).await;
    assert_eq!(report.session.as_deref(), Some("s-42"));

    let empty = Turn::new(EntryStatus::Running);
    *empty.state.lock() = Some("done".to_owned());
    *empty.session.lock() = Some(String::new());
    assert_eq!(ready(empty.run(START_TIMING)).await.session, None);
}

#[tokio::test(start_paused = true)]
async fn reads_the_session_also_when_the_turn_did_not_start() {
    let turn = Turn::new(EntryStatus::Closed);
    *turn.session.lock() = Some("s-7".to_owned());
    let report = ready(turn.run(START_TIMING)).await;
    assert!(!report.turn_started);
    assert_eq!(report.session.as_deref(), Some("s-7"));
}

fn report(status: StartOutcome) -> StartReport {
    StartReport {
        status,
        turn_started: None,
        session: None,
        exit_code: None,
        output: None,
        reason: None,
    }
}

#[test]
fn words_the_message_with_only_the_head_when_there_is_nothing_more() {
    assert_eq!(
        start_message("build", "p1", &report(StartOutcome::Started)),
        "ostia: build (p1) started"
    );
}

#[test]
fn words_the_message_with_the_code_the_reason_and_the_output_lines() {
    let full = StartReport {
        exit_code: Some(2),
        reason: Some("the command ended with exit code 2".to_owned()),
        output: Some(vec!["l1".to_owned(), "l2".to_owned()]),
        ..report(StartOutcome::Failed)
    };
    assert_eq!(
        start_message("build", "p1", &full),
        "ostia: build (p1) failed, exit code 2: the command ended with exit code 2\nl1\nl2"
    );
}

#[test]
fn writes_exit_code_zero_and_leaves_out_an_empty_reason_and_empty_output() {
    let zero = StartReport {
        exit_code: Some(0),
        output: Some(Vec::new()),
        reason: Some(String::new()),
        ..report(StartOutcome::Exited)
    };
    assert_eq!(
        start_message("job", "p9", &zero),
        "ostia: job (p9) exited, exit code 0"
    );
}

#[test]
fn spells_each_outcome_as_the_ts_word_in_the_message() {
    for (status, word) in [
        (StartOutcome::Started, "started"),
        (StartOutcome::Exited, "exited"),
        (StartOutcome::Failed, "failed"),
        (StartOutcome::TimedOut, "timed-out"),
    ] {
        assert_eq!(
            start_message("n", "p", &report(status)),
            format!("ostia: n (p) {word}")
        );
    }
}

struct HungProbe;

impl TurnProbe for HungProbe {
    async fn turn_state(&self, _pane_id: &str) -> Option<String> {
        std::future::pending().await
    }

    async fn session(&self, _pane_id: &str) -> Option<String> {
        None
    }
}

#[tokio::test(start_paused = true)]
async fn reports_no_turn_after_the_turn_timeout_when_the_state_probe_never_returns() {
    let scene = Scene::new(EntryStatus::Running);
    let entry = Arc::clone(&scene.entry);
    let watch = TurnWatch {
        entry: Arc::new(move || entry.lock().clone()),
        probe: HungProbe,
        changes: scene.changes.clone(),
        timing: START_TIMING,
    };
    let handle = tokio::spawn(confirm_turn(watch));
    pass(ms(19_000)).await;
    assert!(!handle.is_finished());
    pass(ms(2000)).await;
    assert!(!ready(handle).await.turn_started);
}
