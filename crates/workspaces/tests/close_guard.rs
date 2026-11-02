#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ostia_workspaces::close_guard::{
    CloseGuard, PaneProcess, QuitAnswer, QuitCheck, RunningGroup, Window, WorkspaceName,
    confirm_quit, freeze_all, groups_from_ptys, parse_quit_answer, parse_running_groups,
    with_scratch_files,
};
use serde_json::{Value, json};

const RUNNING_ANSWER: Duration = Duration::from_millis(2_000);

struct Replier {
    guard: CloseGuard,
    running: Value,
    reply: String,
    questions: Arc<Mutex<Vec<Value>>>,
}

struct FakeWindow {
    id: u64,
    loading: AtomicBool,
    crashed: AtomicBool,
    destroyed: AtomicBool,
    minimized: AtomicBool,
    focuses: AtomicUsize,
    restores: AtomicUsize,
    sent: Mutex<Vec<(String, Vec<Value>)>>,
    replier: Option<Replier>,
}

impl FakeWindow {
    fn build(id: u64, replier: Option<Replier>) -> Arc<Self> {
        Arc::new(Self {
            id,
            loading: AtomicBool::new(false),
            crashed: AtomicBool::new(false),
            destroyed: AtomicBool::new(false),
            minimized: AtomicBool::new(false),
            focuses: AtomicUsize::new(0),
            restores: AtomicUsize::new(0),
            sent: Mutex::new(Vec::new()),
            replier,
        })
    }

    fn channels(&self) -> Vec<String> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|(channel, _)| channel.clone())
            .collect()
    }

    fn request_id(&self, index: usize) -> u64 {
        self.sent.lock().unwrap()[index].1[0].as_u64().unwrap()
    }

    fn focus_count(&self) -> usize {
        self.focuses.load(Ordering::SeqCst)
    }

    fn restore_count(&self) -> usize {
        self.restores.load(Ordering::SeqCst)
    }
}

impl Window for FakeWindow {
    fn id(&self) -> u64 {
        self.id
    }

    fn is_destroyed(&self) -> bool {
        self.destroyed.load(Ordering::SeqCst)
    }

    fn is_loading(&self) -> bool {
        self.loading.load(Ordering::SeqCst)
    }

    fn is_crashed(&self) -> bool {
        self.crashed.load(Ordering::SeqCst)
    }

    fn is_minimized(&self) -> bool {
        self.minimized.load(Ordering::SeqCst)
    }

    fn restore(&self) {
        self.restores.fetch_add(1, Ordering::SeqCst);
    }

    fn focus(&self) {
        self.focuses.fetch_add(1, Ordering::SeqCst);
    }

    fn send(&self, channel: &str, args: &[Value]) {
        self.sent
            .lock()
            .unwrap()
            .push((channel.to_owned(), args.to_vec()));
        let Some(replier) = &self.replier else {
            return;
        };
        if channel == "window:confirm-close" {
            replier.questions.lock().unwrap().push(args[1].clone());
        }
        let request_id = args[0].as_u64().unwrap();
        let guard = replier.guard.clone();
        let id = self.id;
        let running = channel == "window:running";
        let value = if running {
            replier.running.clone()
        } else {
            json!(replier.reply)
        };
        let gone = !running && replier.reply == "gone";
        tokio::spawn(async move {
            if gone {
                guard.window_gone(id);
            } else {
                guard.answer(id, request_id, value);
            }
        });
    }
}

fn silent_window(id: u64) -> Arc<FakeWindow> {
    FakeWindow::build(id, None)
}

fn answering_window(
    guard: &CloseGuard,
    id: u64,
    running: Value,
    reply: &str,
    questions: &Arc<Mutex<Vec<Value>>>,
) -> Arc<FakeWindow> {
    FakeWindow::build(
        id,
        Some(Replier {
            guard: guard.clone(),
            running,
            reply: reply.to_owned(),
            questions: questions.clone(),
        }),
    )
}

fn crashed_window(id: u64) -> Arc<FakeWindow> {
    let win = silent_window(id);
    win.crashed.store(true, Ordering::SeqCst);
    win
}

fn dynamic(win: &Arc<FakeWindow>) -> Arc<dyn Window> {
    win.clone()
}

fn workspace(id: &str, name: &str) -> WorkspaceName {
    WorkspaceName {
        id: id.to_owned(),
        name: name.to_owned(),
    }
}

fn process(pane: &str, workspace: &str, program: Option<&str>, agent_running: bool) -> PaneProcess {
    PaneProcess {
        pane_id: pane.to_owned(),
        workspace_id: workspace.to_owned(),
        program: program.map(str::to_owned),
        agent_running,
    }
}

fn group(
    workspace_id: &str,
    workspace: &str,
    commands: &[&str],
    agents: &[&str],
    files: &[&str],
) -> RunningGroup {
    RunningGroup {
        workspace_id: workspace_id.to_owned(),
        workspace: workspace.to_owned(),
        commands: strings(commands),
        agents: strings(agents),
        files: strings(files),
        scratch_files: None,
        unanswered: false,
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[derive(Default)]
struct Spec {
    workspaces: BTreeMap<u64, Vec<WorkspaceName>>,
    processes: Vec<PaneProcess>,
    kept: Vec<String>,
    kept_shells: Vec<String>,
    native: Option<QuitAnswer>,
}

struct Built {
    check: QuitCheck,
    asked: Arc<Mutex<Vec<Vec<RunningGroup>>>>,
    asked_kept: Arc<Mutex<Vec<usize>>>,
}

impl Built {
    fn asked(&self) -> Vec<Vec<RunningGroup>> {
        self.asked.lock().unwrap().clone()
    }

    fn asked_kept(&self) -> Vec<usize> {
        self.asked_kept.lock().unwrap().clone()
    }
}

fn check(spec: Spec) -> Built {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let asked_kept = Arc::new(Mutex::new(Vec::new()));
    let native = spec.native.unwrap_or(QuitAnswer::Cancel);
    let processes = spec.processes;
    let workspaces = spec.workspaces;
    let recorded = asked.clone();
    let recorded_kept = asked_kept.clone();
    Built {
        check: QuitCheck {
            scratch_files: Box::new(|_| 0),
            kept: spec.kept,
            kept_shells: spec.kept_shells,
            workspaces_of: Box::new(move |win| {
                workspaces.get(&win.id()).cloned().unwrap_or_default()
            }),
            processes: Box::new(move || processes.clone()),
            confirm_native: Box::new(move |groups, kept_shells| {
                recorded.lock().unwrap().push(groups.to_vec());
                recorded_kept.lock().unwrap().push(kept_shells);
                Box::pin(async move { native })
            }),
        },
        asked,
        asked_kept,
    }
}

fn no_questions() -> Arc<Mutex<Vec<Value>>> {
    Arc::new(Mutex::new(Vec::new()))
}

mod ask {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn gives_up_on_a_window_that_never_answers_once_the_timeout_passes() {
        let guard = CloseGuard::new();
        let win = silent_window(7);
        let pending = tokio::spawn(guard.ask(
            dynamic(&win),
            "window:running",
            Value::Null,
            json!(["gone"]),
            Some(Duration::from_millis(1000)),
            None,
        ));
        tokio::time::advance(Duration::from_millis(999)).await;
        tokio::task::yield_now().await;
        assert!(!pending.is_finished());
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(pending.await.unwrap(), json!(["gone"]));
    }

    #[tokio::test(start_paused = true)]
    async fn takes_the_window_answer_when_it_comes_before_the_timeout() {
        let guard = CloseGuard::new();
        let win = silent_window(9);
        let pending = guard.ask(
            dynamic(&win),
            "window:running",
            Value::Null,
            json!([]),
            Some(Duration::from_millis(1000)),
            None,
        );
        guard.answer(9, win.request_id(0), json!(["answered"]));
        assert_eq!(pending.await, json!(["answered"]));
        tokio::time::advance(Duration::from_millis(1000)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn sends_the_request_and_starts_the_timeout_when_called_not_when_first_polled() {
        let guard = CloseGuard::new();
        let win = silent_window(9);
        let pending = guard.ask(
            dynamic(&win),
            "window:running",
            json!(["p1"]),
            json!("gone"),
            Some(Duration::from_millis(1000)),
            None,
        );
        assert_eq!(win.channels(), vec!["window:running".to_owned()]);
        assert_eq!(win.sent.lock().unwrap()[0].1[1], json!(["p1"]));
        tokio::time::advance(Duration::from_millis(1000)).await;
        let outcome = tokio::time::timeout(Duration::from_millis(1), pending).await;
        assert_eq!(outcome.unwrap(), json!("gone"));
    }

    #[tokio::test(start_paused = true)]
    async fn answers_the_gone_value_at_once_without_sending_to_a_window_that_cannot_answer() {
        let guard = CloseGuard::new();
        for flag in ["loading", "crashed", "destroyed"] {
            let win = silent_window(9);
            match flag {
                "loading" => win.loading.store(true, Ordering::SeqCst),
                "crashed" => win.crashed.store(true, Ordering::SeqCst),
                _ => win.destroyed.store(true, Ordering::SeqCst),
            }
            let result = guard
                .ask(
                    dynamic(&win),
                    "window:running",
                    Value::Null,
                    json!("gone"),
                    None,
                    None,
                )
                .await;
            assert_eq!(result, json!("gone"), "{flag}");
            assert!(win.channels().is_empty(), "{flag}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn uses_the_late_value_on_timeout_and_the_gone_value_when_the_window_goes() {
        let guard = CloseGuard::new();
        let slow = silent_window(7);
        let late = guard
            .ask(
                dynamic(&slow),
                "window:running",
                Value::Null,
                json!("gone"),
                Some(Duration::from_millis(500)),
                Some(json!("late")),
            )
            .await;
        assert_eq!(late, json!("late"));
        let leaving = silent_window(8);
        let pending = guard.ask(
            dynamic(&leaving),
            "window:running",
            Value::Null,
            json!("gone"),
            Some(Duration::from_millis(500)),
            Some(json!("late")),
        );
        guard.window_gone(8);
        assert_eq!(pending.await, json!("gone"));
    }

    #[tokio::test(start_paused = true)]
    async fn ignores_an_answer_from_another_window_or_for_another_request_and_settles_only_once() {
        let guard = CloseGuard::new();
        let win = silent_window(9);
        let pending = guard.ask(
            dynamic(&win),
            "window:running",
            Value::Null,
            json!("gone"),
            Some(Duration::from_millis(500)),
            Some(json!("late")),
        );
        let request_id = win.request_id(0);
        guard.answer(8, request_id, json!("stranger"));
        guard.answer(9, request_id + 100, json!("other request"));
        guard.answer(9, request_id, json!("first"));
        guard.answer(9, request_id, json!("second"));
        assert_eq!(pending.await, json!("first"));
    }

    #[tokio::test(start_paused = true)]
    async fn gives_each_request_its_own_id() {
        let guard = CloseGuard::new();
        let win = silent_window(9);
        let first = guard.ask(
            dynamic(&win),
            "window:running",
            Value::Null,
            json!("gone"),
            None,
            None,
        );
        let second = guard.ask(
            dynamic(&win),
            "window:running",
            Value::Null,
            json!("gone"),
            None,
            None,
        );
        assert_ne!(win.request_id(0), win.request_id(1));
        guard.answer(9, win.request_id(1), json!("two"));
        guard.answer(9, win.request_id(0), json!("one"));
        assert_eq!(first.await, json!("one"));
        assert_eq!(second.await, json!("two"));
    }
}

mod confirm_quit {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn quits_without_asking_when_a_window_is_still_booting_and_holds_no_workspace_yet() {
        let guard = CloseGuard::new();
        let win = silent_window(7);
        let built = check(Spec::default());
        let start = tokio::time::Instant::now();
        let approved =
            confirm_quit(&guard, &[dynamic(&win)], Some(&dynamic(&win)), &built.check).await;
        assert_eq!(approved, QuitAnswer::Quit);
        assert_eq!(start.elapsed(), RUNNING_ANSWER);
        assert_eq!(win.channels(), vec!["window:running".to_owned()]);
    }

    #[tokio::test(start_paused = true)]
    async fn counts_a_window_that_misses_the_deadline_as_may_be_running_and_asks_in_another_window()
    {
        let guard = CloseGuard::new();
        let slow = silent_window(7);
        let questions = no_questions();
        let fast = answering_window(&guard, 8, json!([]), "cancel", &questions);
        let built = check(Spec {
            workspaces: BTreeMap::from([(7, vec![workspace("w1", "api")])]),
            ..Spec::default()
        });
        let approved = confirm_quit(
            &guard,
            &[dynamic(&slow), dynamic(&fast)],
            Some(&dynamic(&slow)),
            &built.check,
        )
        .await;
        assert_eq!(approved, QuitAnswer::Cancel);
        assert_eq!(built.asked(), Vec::<Vec<RunningGroup>>::new());
        assert_eq!(
            *questions.lock().unwrap(),
            vec![json!({
                "groups": [{
                    "workspaceId": "w1",
                    "workspace": "api",
                    "commands": [],
                    "files": [],
                    "unanswered": true
                }],
                "keptShells": []
            })]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn asks_in_a_native_dialog_when_no_window_can_show_one() {
        let guard = CloseGuard::new();
        let win = silent_window(7);
        let built = check(Spec {
            workspaces: BTreeMap::from([(7, vec![workspace("w1", "api")])]),
            processes: vec![process("p1", "w1", Some("make"), false)],
            native: Some(QuitAnswer::Quit),
            ..Spec::default()
        });
        let approved =
            confirm_quit(&guard, &[dynamic(&win)], Some(&dynamic(&win)), &built.check).await;
        assert_eq!(approved, QuitAnswer::Quit);
        let mut expected = group("w1", "api", &["make"], &[], &[]);
        expected.unanswered = true;
        assert_eq!(built.asked(), vec![vec![expected]]);
    }

    #[tokio::test(start_paused = true)]
    async fn quitting_while_the_window_is_too_busy_to_answer_asks_instead_of_quitting() {
        let guard = CloseGuard::new();
        let win = silent_window(7);
        let built = check(Spec {
            workspaces: BTreeMap::from([(7, vec![workspace("w1", "api")])]),
            processes: vec![process("p1", "w1", None, false)],
            ..Spec::default()
        });
        let approved =
            confirm_quit(&guard, &[dynamic(&win)], Some(&dynamic(&win)), &built.check).await;
        assert_eq!(approved, QuitAnswer::Cancel);
        let mut expected = group("w1", "api", &[], &[], &[]);
        expected.unanswered = true;
        assert_eq!(built.asked(), vec![vec![expected]]);
    }

    #[tokio::test(start_paused = true)]
    async fn reads_the_ptys_of_a_crashed_window_instead_of_quitting_past_its_agents() {
        let guard = CloseGuard::new();
        let win = crashed_window(7);
        let built = check(Spec {
            workspaces: BTreeMap::from([(7, vec![workspace("w1", "api")])]),
            processes: vec![process("p1", "w1", None, true)],
            ..Spec::default()
        });
        let approved = confirm_quit(&guard, &[dynamic(&win)], None, &built.check).await;
        assert_eq!(approved, QuitAnswer::Cancel);
        assert_eq!(
            built.asked(),
            vec![vec![group("w1", "api", &[], &[""], &[])]]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn quits_at_once_when_a_crashed_window_has_only_idle_shells() {
        let guard = CloseGuard::new();
        let win = crashed_window(7);
        let built = check(Spec {
            workspaces: BTreeMap::from([(7, vec![workspace("w1", "api")])]),
            processes: vec![process("p1", "w1", None, false)],
            ..Spec::default()
        });
        let approved = confirm_quit(&guard, &[dynamic(&win)], None, &built.check).await;
        assert_eq!(approved, QuitAnswer::Quit);
        assert_eq!(built.asked(), Vec::<Vec<RunningGroup>>::new());
    }

    #[tokio::test(start_paused = true)]
    async fn quitting_with_an_agent_idle_at_its_prompt_and_auto_resume_on_asks_nothing() {
        let guard = CloseGuard::new();
        let win = answering_window(&guard, 9, json!([]), "cancel", &no_questions());
        let built = check(Spec {
            workspaces: BTreeMap::from([(9, vec![workspace("w1", "api")])]),
            processes: vec![process("p1", "w1", Some("claude"), true)],
            ..Spec::default()
        });
        let approved =
            confirm_quit(&guard, &[dynamic(&win)], Some(&dynamic(&win)), &built.check).await;
        assert_eq!(approved, QuitAnswer::Quit);
        assert_eq!(win.focus_count(), 0);
        assert_eq!(built.asked(), Vec::<Vec<RunningGroup>>::new());
    }

    #[tokio::test(start_paused = true)]
    async fn asks_in_the_window_that_answered_with_what_it_runs() {
        let guard = CloseGuard::new();
        let win = answering_window(
            &guard,
            9,
            json!([{
                "workspaceId": "w1",
                "workspace": "api",
                "commands": ["sleep 100"],
                "files": []
            }]),
            "quit",
            &no_questions(),
        );
        let built = check(Spec::default());
        let approved =
            confirm_quit(&guard, &[dynamic(&win)], Some(&dynamic(&win)), &built.check).await;
        assert_eq!(approved, QuitAnswer::Quit);
        assert!(win.focus_count() > 0);
        assert_eq!(built.asked(), Vec::<Vec<RunningGroup>>::new());
    }

    #[tokio::test(start_paused = true)]
    async fn quits_without_asking_when_every_window_answers_that_nothing_runs() {
        let guard = CloseGuard::new();
        let win = answering_window(&guard, 9, json!([]), "cancel", &no_questions());
        let built = check(Spec::default());
        let approved =
            confirm_quit(&guard, &[dynamic(&win)], Some(&dynamic(&win)), &built.check).await;
        assert_eq!(approved, QuitAnswer::Quit);
        assert_eq!(win.focus_count(), 0);
        assert_eq!(built.asked(), Vec::<Vec<RunningGroup>>::new());
    }

    #[tokio::test(start_paused = true)]
    async fn asks_in_the_window_that_asked_to_quit_when_it_answered_and_restores_it_if_minimized() {
        let guard = CloseGuard::new();
        let running = json!([{
            "workspaceId": "w1",
            "workspace": "api",
            "commands": ["sleep 100"],
            "files": []
        }]);
        let first_questions = no_questions();
        let second_questions = no_questions();
        let first = answering_window(&guard, 9, running.clone(), "quit", &first_questions);
        let second = answering_window(&guard, 10, running, "quit", &second_questions);
        second.minimized.store(true, Ordering::SeqCst);
        let built = check(Spec::default());
        let approved = confirm_quit(
            &guard,
            &[dynamic(&first), dynamic(&second)],
            Some(&dynamic(&second)),
            &built.check,
        )
        .await;
        assert_eq!(approved, QuitAnswer::Quit);
        assert!(first_questions.lock().unwrap().is_empty());
        assert_eq!(second_questions.lock().unwrap().len(), 1);
        assert_eq!(second.restore_count(), 1);
        assert_eq!(second.focus_count(), 1);
        assert_eq!(first.focus_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn answers_for_a_window_that_goes_while_it_is_asked_quit_or_keep_shells_by_what_was_offered()
     {
        let running = json!([{
            "workspaceId": "w1",
            "workspace": "api",
            "commands": ["sleep 100"],
            "files": []
        }]);
        let guard = CloseGuard::new();
        let win = answering_window(&guard, 9, running.clone(), "gone", &no_questions());
        let built = check(Spec::default());
        let approved =
            confirm_quit(&guard, &[dynamic(&win)], Some(&dynamic(&win)), &built.check).await;
        assert_eq!(approved, QuitAnswer::Quit);
        let offering = answering_window(&guard, 10, running, "gone", &no_questions());
        let built = check(Spec {
            kept: strings(&["p1"]),
            kept_shells: strings(&["p1"]),
            ..Spec::default()
        });
        let approved = confirm_quit(
            &guard,
            &[dynamic(&offering)],
            Some(&dynamic(&offering)),
            &built.check,
        )
        .await;
        assert_eq!(approved, QuitAnswer::KeepShells);
    }
}

mod confirm_quit_with_kept_shells {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn ksh_c97_asks_about_the_kept_shells_even_when_nothing_else_would_be_lost() {
        let guard = CloseGuard::new();
        let questions = no_questions();
        let win = answering_window(&guard, 9, json!([]), "keep-shells", &questions);
        let built = check(Spec {
            kept: strings(&["p1"]),
            kept_shells: strings(&["p1"]),
            ..Spec::default()
        });
        let approved =
            confirm_quit(&guard, &[dynamic(&win)], Some(&dynamic(&win)), &built.check).await;
        assert_eq!(approved, QuitAnswer::KeepShells);
        assert_eq!(
            *questions.lock().unwrap(),
            vec![json!({"groups": [], "keptShells": ["p1"]})]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn ksh_c98_ends_the_kept_shells_when_the_window_answers_quit() {
        let guard = CloseGuard::new();
        let win = answering_window(&guard, 9, json!([]), "quit", &no_questions());
        let built = check(Spec {
            kept: strings(&["p1"]),
            kept_shells: strings(&["p1"]),
            ..Spec::default()
        });
        let approved =
            confirm_quit(&guard, &[dynamic(&win)], Some(&dynamic(&win)), &built.check).await;
        assert_eq!(approved, QuitAnswer::Quit);
    }

    #[tokio::test(start_paused = true)]
    async fn ksh_c99_offers_the_kept_shells_in_the_native_dialog_when_no_window_can_show_one() {
        let guard = CloseGuard::new();
        let win = crashed_window(7);
        let built = check(Spec {
            workspaces: BTreeMap::from([(7, vec![workspace("w1", "api")])]),
            processes: vec![process("p1", "w1", Some("claude"), true)],
            kept: strings(&["p1"]),
            kept_shells: strings(&["p1"]),
            native: Some(QuitAnswer::KeepShells),
        });
        let approved = confirm_quit(&guard, &[dynamic(&win)], None, &built.check).await;
        assert_eq!(approved, QuitAnswer::KeepShells);
        assert_eq!(built.asked(), vec![Vec::<RunningGroup>::new()]);
        assert_eq!(built.asked_kept(), vec![1]);
    }
}

#[test]
fn takes_keep_shells_only_when_keeping_was_offered_and_reads_anything_else_as_cancel() {
    assert_eq!(
        parse_quit_answer(&json!("keep-shells"), true),
        QuitAnswer::KeepShells
    );
    assert_eq!(
        parse_quit_answer(&json!("keep-shells"), false),
        QuitAnswer::Cancel
    );
    assert_eq!(parse_quit_answer(&json!("quit"), true), QuitAnswer::Quit);
    assert_eq!(parse_quit_answer(&json!(true), false), QuitAnswer::Cancel);
    assert_eq!(parse_quit_answer(&Value::Null, true), QuitAnswer::Cancel);
}

#[test]
fn lists_foreground_programs_and_running_agents_per_workspace_and_skips_kept_panes() {
    let groups = groups_from_ptys(
        &[workspace("w1", "api"), workspace("w2", "web")],
        &[
            process("p1", "w1", Some("make"), false),
            process("p2", "w1", Some("claude"), true),
            process("p3", "w1", None, false),
            process("p4", "w2", Some("sleep"), false),
        ],
        &BTreeSet::from(["p4".to_owned()]),
        false,
    );
    assert_eq!(
        groups,
        vec![
            group("w1", "api", &["make"], &["claude"], &[]),
            group("w2", "web", &[], &[], &[]),
        ]
    );
}

#[test]
fn marks_every_group_unanswered_when_the_window_did_not_answer() {
    let groups = groups_from_ptys(&[workspace("w1", "api")], &[], &BTreeSet::new(), true);
    assert_eq!(groups.len(), 1);
    assert!(groups[0].unanswered);
}

mod parse_running_groups_of_a_window_answer {
    use super::*;

    #[test]
    fn keeps_well_formed_groups_from_every_window_and_clips_what_it_shows() {
        let groups = parse_running_groups(&json!([
            {"workspaceId": "w1", "workspace": "api", "commands": ["sleep 100", 7], "files": ["/a.ts"]},
            {"workspaceId": 3, "workspace": "bad"},
            "nope",
            {"workspaceId": "w2", "workspace": "web", "commands": ["x".repeat(2000)]}
        ]));
        assert_eq!(
            groups,
            vec![
                group("w1", "api", &["sleep 100"], &[], &["/a.ts"]),
                group("w2", "web", &["x".repeat(512).as_str()], &[], &[]),
            ]
        );
    }

    #[test]
    fn keeps_the_agents_a_window_names_apart_from_its_shell_commands() {
        let groups = parse_running_groups(&json!([
            {"workspaceId": "w1", "workspace": "api", "commands": [], "agents": ["claude", 3], "files": []},
            {"workspaceId": "w2", "workspace": "web", "commands": ["make"], "agents": "claude", "files": []}
        ]));
        assert_eq!(
            groups,
            vec![
                group("w1", "api", &[], &["claude"], &[]),
                group("w2", "web", &["make"], &[], &[]),
            ]
        );
    }

    #[test]
    fn treats_anything_but_an_array_as_nothing_running() {
        assert_eq!(
            parse_running_groups(&Value::Null),
            Vec::<RunningGroup>::new()
        );
        assert_eq!(
            parse_running_groups(&json!({"workspaceId": "w1"})),
            Vec::<RunningGroup>::new()
        );
    }

    #[test]
    fn caps_the_groups_at_64_and_each_list_at_32_strings_after_dropping_the_wrong_types() {
        let groups: Vec<Value> = (0..70)
            .map(|index| json!({"workspaceId": format!("w{index}"), "workspace": "x"}))
            .collect();
        assert_eq!(parse_running_groups(&Value::Array(groups)).len(), 64);
        let mut commands: Vec<Value> = (0..10).map(|index| json!(index)).collect();
        commands.extend((0..40).map(|index| json!(format!("c{index}"))));
        let parsed = parse_running_groups(&json!([
            {"workspaceId": "w1", "workspace": "api", "commands": commands}
        ]));
        assert_eq!(parsed[0].commands.len(), 32);
        assert_eq!(parsed[0].commands[0], "c0");
        assert_eq!(parsed[0].commands[31], "c31");
    }

    #[test]
    fn clips_the_workspace_id_and_name_to_512_characters() {
        let long = "y".repeat(900);
        let parsed = parse_running_groups(&json!([
            {"workspaceId": long, "workspace": long}
        ]));
        assert_eq!(parsed[0].workspace_id.len(), 512);
        assert_eq!(parsed[0].workspace.len(), 512);
    }
}

mod scratch_files_in_a_group {
    use super::*;

    #[test]
    fn adds_the_scratch_folder_file_count_from_main_and_drops_groups_with_nothing_to_ask_about() {
        let groups = parse_running_groups(&json!([
            {"workspaceId": "w1", "workspace": "Scratch", "commands": [], "files": [], "scratchFiles": 999},
            {"workspaceId": "w2", "workspace": "Scratch 2", "commands": [], "files": []},
            {"workspaceId": "w3", "workspace": "api", "commands": ["sleep 100"], "files": []},
            {"workspaceId": "w4", "workspace": "agents", "commands": [], "agents": ["codex"], "files": []}
        ]));
        let counts: BTreeMap<&str, usize> = BTreeMap::from([("w1", 2), ("w2", 0)]);
        let kept = with_scratch_files(&groups, |id| counts.get(id).copied().unwrap_or(0));
        let mut scratch = group("w1", "Scratch", &[], &[], &[]);
        scratch.scratch_files = Some(2);
        assert_eq!(
            kept,
            vec![
                scratch,
                group("w3", "api", &["sleep 100"], &[], &[]),
                group("w4", "agents", &[], &["codex"], &[]),
            ]
        );
    }

    #[test]
    fn keeps_a_window_that_did_not_answer_even_with_nothing_it_knows_of() {
        let mut silent = group("w1", "api", &[], &[], &[]);
        silent.unanswered = true;
        assert_eq!(with_scratch_files(&[silent.clone()], |_| 0), vec![silent]);
    }
}

#[tokio::test(start_paused = true)]
async fn freezes_every_window_that_is_not_destroyed_and_sends_no_request_id() {
    let live = silent_window(1);
    let gone = silent_window(2);
    gone.destroyed.store(true, Ordering::SeqCst);
    freeze_all(&[dynamic(&live), dynamic(&gone)]);
    assert_eq!(live.channels(), vec!["window:freeze".to_owned()]);
    assert!(live.sent.lock().unwrap()[0].1.is_empty());
    assert!(gone.channels().is_empty());
}
