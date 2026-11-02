#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cell::RefCell;
use std::rc::Rc;

use ostia_base::{EventHub, OwnerThread};

struct NotSend {
    lines: Rc<RefCell<Vec<String>>>,
}

fn owner() -> OwnerThread<NotSend> {
    OwnerThread::spawn("test-owner", || NotSend {
        lines: Rc::new(RefCell::new(Vec::new())),
    })
    .unwrap()
}

#[tokio::test]
async fn a_type_that_is_not_send_lives_on_its_owner_thread() {
    let terminal = owner();
    terminal
        .post(|state| state.lines.borrow_mut().push("one".to_owned()))
        .unwrap();
    let copy = terminal.clone();
    let count = tokio::spawn(async move {
        copy.call(|state| {
            state.lines.borrow_mut().push("two".to_owned());
            state.lines.borrow().len()
        })
        .await
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn jobs_run_in_the_order_they_were_sent() {
    let terminal = owner();
    for index in 0..100 {
        terminal
            .post(move |state| state.lines.borrow_mut().push(index.to_string()))
            .unwrap();
    }
    let lines = terminal
        .call(|state| state.lines.borrow().clone())
        .await
        .unwrap();
    let expected: Vec<String> = (0..100).map(|index| index.to_string()).collect();
    assert_eq!(lines, expected);
}

#[tokio::test]
async fn a_panic_in_a_job_loses_only_that_job() {
    let terminal = owner();
    terminal
        .post(|state| state.lines.borrow_mut().push("before".to_owned()))
        .unwrap();
    terminal.post(|_| panic!("job failed")).unwrap();
    terminal
        .post(|state| state.lines.borrow_mut().push("queued".to_owned()))
        .unwrap();
    let failing = terminal.call(|_| -> u32 { panic!("call failed") }).await;
    assert!(failing.is_err());
    let lines = terminal
        .call(|state| state.lines.borrow().clone())
        .await
        .unwrap();
    assert_eq!(lines, ["before", "queued"]);
}

#[tokio::test]
async fn a_panic_in_init_gives_later_callers_an_error() {
    let terminal = OwnerThread::<u32>::spawn("test-owner", || panic!("init failed")).unwrap();
    assert!(terminal.call(|state| *state).await.is_err());
}

#[test]
fn every_subscriber_gets_every_event_in_order() {
    let hub = EventHub::<u32>::default();
    let mut first = hub.subscribe();
    let mut second = hub.clone().subscribe();
    hub.emit(1);
    hub.emit(2);
    assert_eq!(first.try_recv().unwrap(), 1);
    assert_eq!(first.try_recv().unwrap(), 2);
    assert_eq!(second.try_recv().unwrap(), 1);
    assert_eq!(second.try_recv().unwrap(), 2);
}

#[test]
fn a_closed_subscriber_does_not_stop_the_others() {
    let hub = EventHub::<u32>::default();
    let closed = hub.subscribe();
    let mut open = hub.subscribe();
    drop(closed);
    hub.emit(7);
    assert_eq!(open.try_recv().unwrap(), 7);
}
