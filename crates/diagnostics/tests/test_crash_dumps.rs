#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use ostia_diagnostics::test_crash_dumps::crash_dump_dir;

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}

#[test]
fn names_the_folder_a_test_run_asked_for() {
    assert_eq!(
        crash_dump_dir(
            false,
            &env(&[("OSTIA_E2E_CRASH_DUMPS", "/tmp/out/crash-dumps")])
        ),
        Some(PathBuf::from("/tmp/out/crash-dumps"))
    );
}

#[test]
fn keeps_no_crash_dumps_in_a_packaged_app_whatever_the_environment_says() {
    assert_eq!(
        crash_dump_dir(
            true,
            &env(&[("OSTIA_E2E_CRASH_DUMPS", "/tmp/out/crash-dumps")])
        ),
        None
    );
}

#[test]
fn keeps_none_without_the_variable_or_for_a_relative_folder() {
    assert_eq!(crash_dump_dir(false, &env(&[])), None);
    assert_eq!(
        crash_dump_dir(false, &env(&[("OSTIA_E2E_CRASH_DUMPS", "crash-dumps")])),
        None
    );
}

#[test]
fn keeps_none_for_an_empty_variable() {
    assert_eq!(
        crash_dump_dir(false, &env(&[("OSTIA_E2E_CRASH_DUMPS", "")])),
        None
    );
}
