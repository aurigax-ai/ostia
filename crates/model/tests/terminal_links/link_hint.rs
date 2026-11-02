#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ostia_model::terminal_links::link_hint::LinkHint;

struct Fixture {
    visible: Arc<AtomicBool>,
    published: Arc<Mutex<Vec<Option<String>>>>,
    hint: LinkHint<String>,
}

impl Fixture {
    fn hint_after_400() -> Self {
        let visible = Arc::new(AtomicBool::new(true));
        let published = Arc::new(Mutex::new(Vec::new()));
        let hint = LinkHint::new(
            tokio::runtime::Handle::current(),
            Duration::from_millis(400),
            {
                let visible = visible.clone();
                move || visible.load(Ordering::SeqCst)
            },
            {
                let published = published.clone();
                move |hint| published.lock().unwrap().push(hint)
            },
        );
        Self {
            visible,
            published,
            hint,
        }
    }

    fn published(&self) -> Vec<Option<String>> {
        self.published.lock().unwrap().clone()
    }
}

async fn advance(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    tokio::task::yield_now().await;
}

#[tokio::test(start_paused = true)]
async fn shows_the_hint_once_the_pointer_has_stayed_on_the_link_for_the_delay() {
    let fixture = Fixture::hint_after_400();
    fixture.hint.show(|| Some("box".to_owned()));
    advance(399).await;
    assert_eq!(fixture.published(), Vec::<Option<String>>::new());
    advance(1).await;
    assert_eq!(fixture.published(), [Some("box".to_owned())]);
}

#[tokio::test(start_paused = true)]
async fn never_shows_a_hint_whose_timer_was_pending_when_it_was_hidden() {
    let fixture = Fixture::hint_after_400();
    fixture.hint.show(|| Some("box".to_owned()));
    advance(200).await;
    fixture.hint.hide();
    advance(1_000).await;
    assert_eq!(fixture.published(), Vec::<Option<String>>::new());
}

#[tokio::test(start_paused = true)]
async fn clears_a_shown_hint_once_and_publishes_nothing_for_a_hide_with_no_hint_out() {
    let fixture = Fixture::hint_after_400();
    fixture.hint.hide();
    fixture.hint.show(|| Some("box".to_owned()));
    advance(400).await;
    fixture.hint.hide();
    fixture.hint.hide();
    assert_eq!(fixture.published(), [Some("box".to_owned()), None]);
}

#[tokio::test(start_paused = true)]
async fn never_shows_a_hint_whose_pane_stopped_being_visible_while_its_timer_was_pending() {
    let fixture = Fixture::hint_after_400();
    let measured = Arc::new(AtomicUsize::new(0));
    fixture.hint.show({
        let measured = measured.clone();
        move || {
            measured.fetch_add(1, Ordering::SeqCst);
            Some("box".to_owned())
        }
    });
    fixture.visible.store(false, Ordering::SeqCst);
    advance(1_000).await;
    assert_eq!(measured.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.published(), Vec::<Option<String>>::new());
}

#[tokio::test(start_paused = true)]
async fn shows_only_the_link_hovered_last() {
    let fixture = Fixture::hint_after_400();
    fixture.hint.show(|| Some("first".to_owned()));
    advance(300).await;
    fixture.hint.show(|| Some("second".to_owned()));
    advance(400).await;
    assert_eq!(fixture.published(), [Some("second".to_owned())]);
}

#[tokio::test(start_paused = true)]
async fn shows_nothing_when_the_link_cannot_be_measured() {
    let fixture = Fixture::hint_after_400();
    fixture.hint.show(|| None);
    advance(400).await;
    assert_eq!(fixture.published(), Vec::<Option<String>>::new());
}

#[test]
fn shows_from_a_thread_that_has_no_runtime() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let published = Arc::new(Mutex::new(Vec::new()));
    let hint = LinkHint::new(
        runtime.handle().clone(),
        Duration::from_millis(20),
        || true,
        {
            let published = published.clone();
            move |hint: Option<String>| published.lock().unwrap().push(hint)
        },
    );
    hint.show(|| Some("box".to_owned()));
    for _ in 0..200 {
        if !published.lock().unwrap().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(*published.lock().unwrap(), [Some("box".to_owned())]);
    hint.hide();
    assert_eq!(published.lock().unwrap().len(), 2);
}
