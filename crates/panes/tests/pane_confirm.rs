#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::FutureExt;
use ostia_panes::pane_confirm::{
    CONFIRM_MAX_MS, ConfirmTarget, ListedPane, PaneConfirmDeps, PaneConfirms,
};
use parking_lot::Mutex;
use tokio::time::Instant;

#[derive(Clone, Default)]
struct Scene {
    cursor: Arc<Mutex<Option<i64>>>,
    state: Arc<Mutex<Option<String>>>,
    panes: Arc<Mutex<Vec<ListedPane>>>,
    hooked: Arc<Mutex<Vec<String>>>,
    list_calls: Arc<AtomicUsize>,
    vanish_after: Arc<Mutex<Option<usize>>>,
}

impl Scene {
    fn confirms(&self) -> PaneConfirms {
        let cursor = Arc::clone(&self.cursor);
        let state = Arc::clone(&self.state);
        let panes = Arc::clone(&self.panes);
        let hooked = Arc::clone(&self.hooked);
        let calls = Arc::clone(&self.list_calls);
        let vanish = Arc::clone(&self.vanish_after);
        PaneConfirms::new(PaneConfirmDeps {
            output_cursor: Arc::new(move |_pane_id| *cursor.lock()),
            attention: Arc::new(move |_target| {
                let state = state.lock().clone();
                async move { state }.boxed()
            }),
            panes: Arc::new(move || {
                let seen = calls.fetch_add(1, Ordering::SeqCst) + 1;
                let gone = vanish.lock().is_some_and(|after| seen > after);
                let listed = if gone {
                    Vec::new()
                } else {
                    panes.lock().clone()
                };
                async move { listed }.boxed()
            }),
            delay: Arc::new(|ms| tokio::time::sleep(Duration::from_millis(ms)).boxed()),
            hooks_on: Arc::new(move |agent| hooked.lock().iter().any(|name| name == agent)),
        })
    }

    fn list(&self, panes: &[(&str, Option<&str>)]) {
        *self.panes.lock() = panes
            .iter()
            .map(|(pane_id, agent)| ListedPane {
                pane_id: (*pane_id).to_owned(),
                agent: agent.map(str::to_owned),
            })
            .collect();
    }
}

fn target() -> ConfirmTarget {
    ConfirmTarget {
        external_id: "ext-1".to_owned(),
        pane_id: "p1".to_owned(),
    }
}

async fn elapsed_of<T>(work: impl std::future::Future<Output = T>) -> (T, Duration) {
    let started = Instant::now();
    let value = work.await;
    (value, started.elapsed())
}

#[tokio::test(start_paused = true)]
async fn confirms_a_pane_gone_at_the_first_look_with_no_wait() {
    let scene = Scene::default();
    let (result, waited) = elapsed_of(scene.confirms().confirm_gone(&target())).await;
    assert_eq!(result, Ok(()));
    assert_eq!(waited, Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn confirms_a_pane_that_closes_while_it_waits() {
    let scene = Scene::default();
    scene.list(&[("p1", None), ("p2", None)]);
    *scene.vanish_after.lock() = Some(4);
    let (result, waited) = elapsed_of(scene.confirms().confirm_gone(&target())).await;
    assert_eq!(result, Ok(()));
    assert_eq!(waited, Duration::from_millis(200));
}

#[tokio::test(start_paused = true)]
async fn keeps_other_panes_out_of_the_answer_when_it_checks_that_one_is_gone() {
    let scene = Scene::default();
    scene.list(&[("p2", None)]);
    assert_eq!(scene.confirms().confirm_gone(&target()).await, Ok(()));
}

#[tokio::test(start_paused = true)]
async fn reports_a_pane_still_open_after_three_seconds_and_says_the_human_was_asked() {
    let scene = Scene::default();
    scene.list(&[("p1", None)]);
    let (result, waited) = elapsed_of(scene.confirms().confirm_gone(&target())).await;
    assert_eq!(
        result,
        Err(
            "still-open: ext-1 is still open; the human was asked about its unsaved files"
                .to_owned()
        )
    );
    assert_eq!(waited, Duration::from_millis(3000));
}

#[tokio::test(start_paused = true)]
async fn confirms_input_false_at_once_when_the_pane_has_no_output_cursor() {
    let scene = Scene::default();
    let (seen, waited) = elapsed_of(scene.confirms().confirm_input(&target(), Some(5), 1000)).await;
    assert!(!seen);
    assert_eq!(waited, Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn confirms_input_when_the_output_cursor_moves_past_the_one_before() {
    let scene = Scene::default();
    *scene.cursor.lock() = Some(5);
    let confirms = scene.confirms();
    let cursor = Arc::clone(&scene.cursor);
    let mover = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        *cursor.lock() = Some(9);
    });
    let (seen, waited) = elapsed_of(confirms.confirm_input(&target(), Some(5), 1000)).await;
    mover.await.unwrap();
    assert!(seen);
    assert!(waited >= Duration::from_millis(120) && waited < Duration::from_millis(200));
}

#[tokio::test(start_paused = true)]
async fn confirms_input_true_at_once_when_the_cursor_is_already_past_the_one_before() {
    let scene = Scene::default();
    *scene.cursor.lock() = Some(9);
    let (seen, waited) = elapsed_of(scene.confirms().confirm_input(&target(), Some(5), 1000)).await;
    assert!(seen);
    assert_eq!(waited, Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn gives_up_on_input_after_the_wait_when_the_cursor_does_not_move() {
    let scene = Scene::default();
    *scene.cursor.lock() = Some(5);
    let (seen, waited) = elapsed_of(scene.confirms().confirm_input(&target(), Some(5), 200)).await;
    assert!(!seen);
    assert_eq!(waited, Duration::from_millis(200));
}

#[tokio::test(start_paused = true)]
async fn never_confirms_input_when_the_cursor_was_unknown_before() {
    let scene = Scene::default();
    *scene.cursor.lock() = Some(50);
    let (seen, waited) = elapsed_of(scene.confirms().confirm_input(&target(), None, 200)).await;
    assert!(!seen);
    assert_eq!(waited, Duration::from_millis(200));
}

#[test]
fn caps_the_input_wait_at_ten_seconds() {
    assert_eq!(CONFIRM_MAX_MS, 10_000);
}

#[tokio::test(start_paused = true)]
async fn confirms_a_submit_when_the_agent_starts_or_waits_on_a_turn() {
    for state in ["working", "waiting"] {
        let scene = Scene::default();
        *scene.state.lock() = Some(state.to_owned());
        let (result, waited) = elapsed_of(scene.confirms().confirm_submitted(&target())).await;
        assert_eq!(result, Ok(()), "{state}");
        assert_eq!(waited, Duration::ZERO, "{state}");
    }
}

#[tokio::test(start_paused = true)]
async fn confirms_a_submit_that_starts_a_turn_while_it_waits() {
    let scene = Scene::default();
    *scene.state.lock() = Some("idle".to_owned());
    let confirms = scene.confirms();
    let state = Arc::clone(&scene.state);
    let starter = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        *state.lock() = Some("working".to_owned());
    });
    let (result, waited) = elapsed_of(confirms.confirm_submitted(&target())).await;
    starter.await.unwrap();
    assert_eq!(result, Ok(()));
    assert!(waited >= Duration::from_millis(1000) && waited < Duration::from_millis(1100));
}

#[tokio::test(start_paused = true)]
async fn tells_the_caller_how_to_press_enter_when_no_turn_starts_in_five_seconds() {
    for state in [None, Some("idle"), Some("done"), Some("error")] {
        let scene = Scene::default();
        *scene.state.lock() = state.map(str::to_owned);
        let (result, waited) = elapsed_of(scene.confirms().confirm_submitted(&target())).await;
        assert_eq!(
            result,
            Err("not-submitted: ext-1 shows the text at its prompt but did not start a turn after Enter; press Enter with ostia pane key ext-1 enter, or read it with ostia pane read".to_owned()),
            "{state:?}"
        );
        assert_eq!(waited, Duration::from_millis(5000), "{state:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn watches_a_submit_only_for_a_listed_pane_with_an_agent_whose_hooks_are_on() {
    let scene = Scene::default();
    scene.hooked.lock().push("claude".to_owned());
    assert!(!scene.confirms().watches_submit(&target()).await);
    scene.list(&[("p2", Some("claude"))]);
    assert!(!scene.confirms().watches_submit(&target()).await);
    scene.list(&[("p1", None)]);
    assert!(!scene.confirms().watches_submit(&target()).await);
    scene.list(&[("p1", Some(""))]);
    assert!(!scene.confirms().watches_submit(&target()).await);
    scene.list(&[("p1", Some("codex"))]);
    assert!(!scene.confirms().watches_submit(&target()).await);
    scene.list(&[("p1", Some("claude"))]);
    assert!(scene.confirms().watches_submit(&target()).await);
}

#[tokio::test(start_paused = true)]
async fn does_not_watch_a_submit_when_the_agent_is_already_in_a_turn() {
    let scene = Scene::default();
    scene.hooked.lock().push("claude".to_owned());
    scene.list(&[("p1", Some("claude"))]);
    for (state, expected) in [
        (Some("working"), false),
        (Some("waiting"), false),
        (Some("idle"), true),
        (Some("done"), true),
        (None, true),
    ] {
        *scene.state.lock() = state.map(str::to_owned);
        assert_eq!(
            scene.confirms().watches_submit(&target()).await,
            expected,
            "{state:?}"
        );
    }
}
