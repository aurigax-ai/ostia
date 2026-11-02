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
async fn a_panic_in_a_job_stops_the_owner_and_later_calls_get_an_error() {
    let terminal = owner();
    terminal.post(|_| panic!("job failed")).unwrap();
    let mut answer = terminal.call(|_| 1).await;
    for _ in 0..50 {
        if answer.is_err() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        answer = terminal.call(|_| 1).await;
    }
    assert!(answer.is_err());
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
