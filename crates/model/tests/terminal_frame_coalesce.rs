#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::terminal::frame_coalesce::FrameCoalesce;

#[test]
fn runs_once_per_frame_however_many_calls_arrive() {
    let mut gate = FrameCoalesce::default();
    let scheduled = (0..500).filter(|_| gate.request()).count();

    assert_eq!(scheduled, 1);
    assert!(gate.take_frame());
    assert!(!gate.take_frame());
}

#[test]
fn schedules_again_after_the_frame_ran() {
    let mut gate = FrameCoalesce::default();
    assert!(gate.request());
    assert!(gate.take_frame());

    assert!(gate.request());
    assert!(gate.take_frame());
}

#[test]
fn does_not_run_after_cancel() {
    let mut gate = FrameCoalesce::default();
    assert!(gate.request());
    gate.cancel();

    assert!(!gate.take_frame());
    assert!(gate.request());
}
