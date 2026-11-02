#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_model::workspaces::core_watch::{CoreFeature, CoreWatch};
use parking_lot::Mutex;
use tokio::runtime::Handle;

type Calls = Arc<Mutex<Vec<(CoreFeature, Vec<String>)>>>;

fn watcher() -> (CoreWatch, Calls) {
    let calls: Calls = Arc::default();
    let sink = Arc::clone(&calls);
    let watch = CoreWatch::new(Handle::current(), move |feature, ids| {
        sink.lock().push((feature, ids))
    });
    (watch, calls)
}

async fn settle() {
    tokio::task::yield_now().await;
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[tokio::test]
async fn tells_main_nothing_until_something_on_screen_shows_a_workspace() {
    let (_watch, calls) = watcher();
    settle().await;
    assert!(calls.lock().is_empty());
}

#[tokio::test]
async fn sends_one_sorted_set_for_several_items_mounted_in_the_same_tick() {
    let (watch, calls) = watcher();
    let _a = watch.watch_workspace(CoreFeature::Git, "w2");
    let _b = watch.watch_workspace(CoreFeature::Git, "w1");
    let _c = watch.watch_workspace(CoreFeature::Git, "w1");
    settle().await;
    assert_eq!(
        calls.lock().as_slice(),
        [(CoreFeature::Git, ids(&["w1", "w2"]))]
    );
}

#[tokio::test]
async fn keeps_a_workspace_while_another_item_still_shows_it_and_sends_an_empty_set_after_the_last()
{
    let (watch, calls) = watcher();
    let mut first = watch.watch_workspace(CoreFeature::Ports, "w1");
    let mut second = watch.watch_workspace(CoreFeature::Ports, "w1");
    settle().await;
    first.release();
    settle().await;
    assert_eq!(watch.watched_workspaces(CoreFeature::Ports), ids(&["w1"]));
    assert_eq!(calls.lock().len(), 1);
    second.release();
    second.release();
    settle().await;
    assert_eq!(
        calls.lock().last().unwrap(),
        &(CoreFeature::Ports, ids(&[]))
    );
    assert_eq!(calls.lock().len(), 2);
}

#[tokio::test]
async fn keeps_the_two_features_apart() {
    let (watch, calls) = watcher();
    let _git = watch.watch_workspace(CoreFeature::Git, "w1");
    let _ports = watch.watch_workspace(CoreFeature::Ports, "w2");
    settle().await;
    assert_eq!(watch.watched_workspaces(CoreFeature::Git), ids(&["w1"]));
    assert_eq!(watch.watched_workspaces(CoreFeature::Ports), ids(&["w2"]));
    let calls = calls.lock();
    assert_eq!(calls.len(), 2);
    assert!(calls.contains(&(CoreFeature::Git, ids(&["w1"]))));
    assert!(calls.contains(&(CoreFeature::Ports, ids(&["w2"]))));
}

#[tokio::test]
async fn sends_nothing_when_the_set_did_not_change() {
    let (watch, calls) = watcher();
    let _first = watch.watch_workspace(CoreFeature::Git, "w1");
    settle().await;
    let _second = watch.watch_workspace(CoreFeature::Git, "w1");
    settle().await;
    assert_eq!(calls.lock().len(), 1);
}

#[tokio::test]
async fn sends_nothing_when_a_workspace_is_shown_and_released_in_the_same_tick() {
    let (watch, calls) = watcher();
    let mut release = watch.watch_workspace(CoreFeature::Git, "w1");
    release.release();
    settle().await;
    assert!(calls.lock().is_empty());
    assert!(watch.watched_workspaces(CoreFeature::Git).is_empty());
}

#[tokio::test]
async fn releases_a_workspace_when_its_handle_is_dropped() {
    let (watch, calls) = watcher();
    let release = watch.watch_workspace(CoreFeature::Git, "w1");
    settle().await;
    drop(release);
    settle().await;
    assert_eq!(calls.lock().last().unwrap(), &(CoreFeature::Git, ids(&[])));
}

#[tokio::test]
async fn forgets_every_watch_and_the_last_sent_set_on_reset() {
    let (watch, calls) = watcher();
    let _first = watch.watch_workspace(CoreFeature::Git, "w1");
    settle().await;
    watch.reset();
    assert!(watch.watched_workspaces(CoreFeature::Git).is_empty());
    let _again = watch.watch_workspace(CoreFeature::Git, "w1");
    settle().await;
    assert_eq!(calls.lock().len(), 2);
}

#[test]
fn delivers_from_a_thread_that_has_no_runtime_and_releases_on_drop_there() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let calls: Calls = Arc::default();
    let sink = Arc::clone(&calls);
    let watch = CoreWatch::new(runtime.handle().clone(), move |feature, ids| {
        sink.lock().push((feature, ids))
    });
    let held = watch.watch_workspace(CoreFeature::Git, "w1");
    wait_for(&calls, 1);
    drop(held);
    wait_for(&calls, 2);
    assert_eq!(
        calls.lock().as_slice(),
        [
            (CoreFeature::Git, ids(&["w1"])),
            (CoreFeature::Git, ids(&[]))
        ]
    );
}

fn wait_for(calls: &Calls, count: usize) {
    for _ in 0..200 {
        if calls.lock().len() >= count {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("no delivery");
}
