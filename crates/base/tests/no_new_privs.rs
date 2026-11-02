#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cell::RefCell;
use std::io;

use ostia_base::host::Platform;
use ostia_base::no_new_privs::{parse_no_new_privs, read_no_new_privs};

fn status(flag: &str) -> String {
    format!("Name:\tostia\nNoNewPrivs:\t{flag}\nSeccomp:\t0\n")
}

#[test]
fn reads_1_as_set_and_0_as_clear() {
    assert!(parse_no_new_privs(&status("1")));
    assert!(!parse_no_new_privs(&status("0")));
}

#[test]
fn is_clear_when_the_line_is_missing() {
    assert!(!parse_no_new_privs("Name:\tostia\n"));
}

#[test]
fn reads_only_a_line_that_is_exactly_the_flag_set_to_1() {
    assert!(!parse_no_new_privs(&status("10")));
    assert!(!parse_no_new_privs(&status("2")));
    assert!(parse_no_new_privs("NoNewPrivs: 1"));
    assert!(parse_no_new_privs(&status("1  ")));
    assert!(!parse_no_new_privs("XNoNewPrivs:\t1\n"));
}

#[test]
fn reads_proc_self_status_on_linux() {
    let paths = RefCell::new(Vec::new());
    let read = |path: &str| -> io::Result<String> {
        paths.borrow_mut().push(path.to_owned());
        Ok(status("1"))
    };
    assert!(read_no_new_privs(Platform::Linux, read));
    assert_eq!(*paths.borrow(), vec!["/proc/self/status".to_owned()]);
}

#[test]
fn is_clear_off_linux_without_reading() {
    let read = |_: &str| -> io::Result<String> { panic!("read") };
    assert!(!read_no_new_privs(Platform::Darwin, read));
}

#[test]
fn is_clear_when_the_file_cannot_be_read() {
    assert!(!read_no_new_privs(Platform::Linux, |_| Err(
        io::Error::from(io::ErrorKind::NotFound)
    )));
}
