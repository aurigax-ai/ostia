#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use ostia_browser::guest_first_load::{
    FirstLoadGuest, FirstLoadHold, NavigationDetails, hold_first_load,
};
use parking_lot::Mutex;
use tokio::sync::oneshot;

const PAGE: &str = "https://example.com/restored";

type Deferred = Arc<Mutex<Vec<Box<dyn FnOnce() + Send>>>>;

#[derive(Default)]
struct FakeGuest {
    destroyed: Mutex<bool>,
    stops: Mutex<usize>,
    loads: Mutex<Vec<(String, Option<String>)>>,
}

impl FirstLoadGuest for FakeGuest {
    fn is_destroyed(&self) -> bool {
        *self.destroyed.lock()
    }

    fn stop(&self) {
        *self.stops.lock() += 1;
    }

    fn load_url(&self, url: &str, referrer: Option<&str>) {
        self.loads
            .lock()
            .push((url.to_owned(), referrer.map(str::to_owned)));
    }
}

struct Setup {
    guest: Arc<FakeGuest>,
    hold: FirstLoadHold,
    ready: Option<oneshot::Sender<Result<(), String>>>,
    deferred: Deferred,
}

impl Setup {
    fn start(&self, url: &str) {
        self.hold.navigation_started(&NavigationDetails {
            url: Some(url.to_owned()),
            is_main_frame: true,
            is_same_document: false,
        });
    }

    fn start_with(&self, url: &str, is_main_frame: bool, is_same_document: bool) {
        self.hold.navigation_started(&NavigationDetails {
            url: Some(url.to_owned()),
            is_main_frame,
            is_same_document,
        });
    }

    fn run_deferred(&self) {
        let runs: Vec<_> = self.deferred.lock().drain(..).collect();
        for run in runs {
            run();
        }
    }

    fn release(&mut self) {
        self.ready.take().unwrap().send(Ok(())).unwrap();
    }

    fn refuse(&mut self, reason: &str) {
        self.ready
            .take()
            .unwrap()
            .send(Err(reason.to_owned()))
            .unwrap();
    }

    fn stops(&self) -> usize {
        *self.guest.stops.lock()
    }

    fn loads(&self) -> Vec<(String, Option<String>)> {
        self.guest.loads.lock().clone()
    }
}

fn setup(referrers: &'static [(&'static str, &'static str)]) -> Setup {
    let (tx, rx) = oneshot::channel::<Result<(), String>>();
    let guest = Arc::new(FakeGuest::default());
    let deferred: Deferred = Arc::new(Mutex::new(Vec::new()));
    let hold = hold_first_load(
        guest.clone(),
        async move { rx.await.unwrap_or(Ok(())) },
        move |url| {
            referrers
                .iter()
                .find(|(page, _)| *page == url)
                .map(|(_, referrer)| (*referrer).to_owned())
        },
        {
            let deferred = deferred.clone();
            move |run| deferred.lock().push(run)
        },
    );
    Setup {
        guest,
        hold,
        ready: Some(tx),
        deferred,
    }
}

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(1)).await;
}

#[tokio::test]
async fn stops_the_first_load_and_starts_it_again_once_the_page_scripts_are_registered() {
    let mut s = setup(&[]);
    s.start(PAGE);
    assert_eq!(s.stops(), 0);
    s.run_deferred();
    assert_eq!(s.stops(), 1);
    settle().await;
    assert!(s.loads().is_empty());
    s.release();
    settle().await;
    assert_eq!(s.loads(), [(PAGE.to_owned(), None)]);
}

#[tokio::test]
async fn starts_the_first_load_again_with_the_referrer_it_was_opened_with() {
    let mut s = setup(&[(PAGE, "https://site.example/")]);
    s.start(PAGE);
    s.run_deferred();
    s.release();
    settle().await;
    assert_eq!(
        s.loads(),
        [(PAGE.to_owned(), Some("https://site.example/".to_owned()))]
    );
}

#[tokio::test]
async fn holds_only_the_first_load() {
    let mut s = setup(&[]);
    s.start(PAGE);
    s.run_deferred();
    s.release();
    settle().await;
    s.start("https://example.com/next");
    s.run_deferred();
    settle().await;
    assert_eq!(s.stops(), 1);
    assert_eq!(s.loads().len(), 1);
}

#[tokio::test]
async fn leaves_a_load_alone_that_starts_after_the_scripts_are_registered() {
    let mut s = setup(&[]);
    s.release();
    settle().await;
    s.start(PAGE);
    s.run_deferred();
    settle().await;
    assert_eq!(s.stops(), 0);
    assert!(s.loads().is_empty());
}

#[tokio::test]
async fn does_not_bring_the_held_page_back_over_a_navigation_that_started_meanwhile() {
    let mut s = setup(&[]);
    s.start(PAGE);
    s.run_deferred();
    s.start("https://example.com/typed");
    s.release();
    settle().await;
    assert!(s.loads().is_empty());
}

#[tokio::test]
async fn ignores_subframes_and_same_document_navigations() {
    let mut s = setup(&[]);
    s.start_with("https://example.com/frame", false, false);
    s.start_with(&format!("{PAGE}#part"), true, true);
    s.run_deferred();
    assert_eq!(s.stops(), 0);
    s.start(PAGE);
    s.run_deferred();
    s.start_with("https://example.com/frame", false, false);
    s.release();
    settle().await;
    assert_eq!(s.loads(), [(PAGE.to_owned(), None)]);
}

#[tokio::test]
async fn loads_the_page_even_when_registering_the_scripts_failed() {
    let mut s = setup(&[]);
    s.start(PAGE);
    s.run_deferred();
    s.refuse("detached");
    settle().await;
    assert_eq!(s.loads(), [(PAGE.to_owned(), None)]);
}

#[tokio::test]
async fn touches_nothing_on_a_guest_that_is_gone() {
    let mut s = setup(&[]);
    s.start(PAGE);
    *s.guest.destroyed.lock() = true;
    s.run_deferred();
    s.release();
    settle().await;
    assert_eq!(s.stops(), 0);
    assert!(s.loads().is_empty());
}

#[tokio::test]
async fn ignores_a_navigation_that_has_no_url() {
    let mut s = setup(&[]);
    s.hold.navigation_started(&NavigationDetails {
        url: None,
        is_main_frame: true,
        is_same_document: false,
    });
    s.run_deferred();
    assert_eq!(s.stops(), 0);
    s.start(PAGE);
    s.run_deferred();
    s.release();
    settle().await;
    assert_eq!(s.loads(), [(PAGE.to_owned(), None)]);
}

#[tokio::test]
async fn does_not_load_when_the_guest_is_destroyed_while_the_scripts_register() {
    let mut s = setup(&[]);
    s.start(PAGE);
    s.run_deferred();
    *s.guest.destroyed.lock() = true;
    s.release();
    settle().await;
    assert_eq!(s.stops(), 1);
    assert!(s.loads().is_empty());
}

#[tokio::test]
async fn waits_for_the_deferred_step_before_it_stops_the_load() {
    let s = setup(&[]);
    s.start(PAGE);
    s.start("https://example.com/second");
    assert_eq!(s.deferred.lock().len(), 1);
    assert_eq!(s.stops(), 0);
}
