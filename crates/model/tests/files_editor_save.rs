#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ostia_model::files::editor_save::save_formatted;
use parking_lot::Mutex;

#[tokio::test]
async fn formats_before_writing_when_format_on_save_is_on() {
    let order = Arc::new(Mutex::new(Vec::new()));
    let format_order = order.clone();
    let write_order = order.clone();
    let ok = save_formatted(
        true,
        move || async move {
            format_order.lock().push("format");
            Ok::<(), String>(())
        },
        move || async move {
            write_order.lock().push("write");
            true
        },
    )
    .await;
    assert_eq!(*order.lock(), ["format", "write"]);
    assert!(ok);
}

#[tokio::test]
async fn only_writes_when_format_on_save_is_off() {
    let formats = Arc::new(AtomicUsize::new(0));
    let counted = formats.clone();
    let ok = save_formatted(
        false,
        move || async move {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok::<(), String>(())
        },
        || async { true },
    )
    .await;
    assert_eq!(formats.load(Ordering::SeqCst), 0);
    assert!(ok);
}

#[tokio::test]
async fn still_writes_when_formatting_fails() {
    let writes = Arc::new(AtomicUsize::new(0));
    let counted = writes.clone();
    save_formatted(
        true,
        || async { Err::<(), _>("no formatter".to_owned()) },
        move || async move {
            counted.fetch_add(1, Ordering::SeqCst);
            true
        },
    )
    .await;
    assert_eq!(writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn gives_back_what_the_write_says() {
    let kept = save_formatted(true, || async { Ok::<(), String>(()) }, || async { false }).await;
    assert!(!kept);
    let failed_format = save_formatted(
        true,
        || async { Err::<(), _>("x".to_owned()) },
        || async { false },
    )
    .await;
    assert!(!failed_format);
}

#[tokio::test]
async fn does_not_write_until_the_format_has_finished() {
    let (release, wait) = tokio::sync::oneshot::channel::<()>();
    let writes = Arc::new(AtomicUsize::new(0));
    let counted = writes.clone();
    let task = tokio::spawn(save_formatted(
        true,
        move || async move {
            let _ = wait.await;
            Ok::<(), String>(())
        },
        move || async move {
            counted.fetch_add(1, Ordering::SeqCst);
            true
        },
    ));
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    release.send(()).unwrap();
    assert!(task.await.unwrap());
    assert_eq!(writes.load(Ordering::SeqCst), 1);
}
