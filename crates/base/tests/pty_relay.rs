#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io;

use ostia_base::host::Platform;
use ostia_base::pty_relay::{needs_pty_relay, terminal_injection_off};

fn refuses(_: &str) -> io::Result<String> {
    Ok("0\n".to_owned())
}

fn allows(_: &str) -> io::Result<String> {
    Ok("1\n".to_owned())
}

fn unreadable(_: &str) -> io::Result<String> {
    Err(io::Error::from(io::ErrorKind::NotFound))
}

#[test]
fn is_true_only_when_the_kernel_refuses_tiocsti() {
    assert!(terminal_injection_off(refuses));
    assert!(!terminal_injection_off(allows));
    assert!(!terminal_injection_off(unreadable));
}

#[test]
fn reads_the_legacy_tiocsti_switch() {
    let asked = std::cell::RefCell::new(Vec::new());
    terminal_injection_off(|path| {
        asked.borrow_mut().push(path.to_owned());
        refuses(path)
    });
    assert_eq!(
        *asked.borrow(),
        vec!["/proc/sys/dev/tty/legacy_tiocsti".to_owned()]
    );
}

#[test]
fn relays_on_linux_wherever_keys_could_be_injected_into_the_panes_terminal() {
    assert!(needs_pty_relay(false, allows, Platform::Linux));
    assert!(needs_pty_relay(false, unreadable, Platform::Linux));
    assert!(!needs_pty_relay(false, refuses, Platform::Linux));
}

#[test]
fn relays_when_forced_whatever_the_kernel_says() {
    assert!(needs_pty_relay(true, refuses, Platform::Linux));
}

#[test]
fn never_relays_on_another_platform() {
    assert!(!needs_pty_relay(true, allows, Platform::Darwin));
}
