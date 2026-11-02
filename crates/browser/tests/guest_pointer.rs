#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use ostia_base::Clock;
use ostia_browser::guest_pointer::{GUEST_POINTER_DOWN, PointerOwner, announce_guest_pointer};

struct FakeOwner {
    destroyed: bool,
    sent: Mutex<Vec<(u32, i64)>>,
}

impl PointerOwner for FakeOwner {
    fn is_destroyed(&self) -> bool {
        self.destroyed
    }

    fn send_pointer_down(&self, guest_id: u32, at: i64) {
        self.sent.lock().unwrap().push((guest_id, at));
    }
}

fn setup(destroyed: bool) -> (ostia_browser::guest_pointer::GuestPointer, Arc<FakeOwner>) {
    let owner = Arc::new(FakeOwner {
        destroyed,
        sent: Mutex::new(Vec::new()),
    });
    let clock: Clock = Arc::new(|| 1234);
    let pointer = announce_guest_pointer(7, owner.clone(), clock);
    (pointer, owner)
}

#[test]
fn tells_the_owner_window_which_guest_the_human_pressed_in() {
    let (pointer, owner) = setup(false);
    pointer.before_mouse_event("mouseDown");
    assert_eq!(*owner.sent.lock().unwrap(), vec![(7, 1234)]);
}

#[test]
fn stays_quiet_for_moves_releases_and_keys() {
    let (pointer, owner) = setup(false);
    for kind in ["mouseMove", "mouseUp", "mouseWheel"] {
        pointer.before_mouse_event(kind);
    }
    assert!(owner.sent.lock().unwrap().is_empty());
}

#[test]
fn stays_quiet_once_the_owner_window_is_destroyed() {
    let (pointer, owner) = setup(true);
    pointer.before_mouse_event("mouseDown");
    assert!(owner.sent.lock().unwrap().is_empty());
}

#[test]
fn tells_the_owner_again_for_every_press() {
    let (pointer, owner) = setup(false);
    pointer.before_mouse_event("mouseDown");
    pointer.before_mouse_event("mouseUp");
    pointer.before_mouse_event("mouseDown");
    assert_eq!(owner.sent.lock().unwrap().len(), 2);
}

#[test]
fn uses_the_channel_name_the_window_listens_on() {
    assert_eq!(GUEST_POINTER_DOWN, "guest-input:pointer-down");
}
