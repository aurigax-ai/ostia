#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use ostia_base::path_guard::is_inside_path;
use ostia_terminal::kept_paths::{kept_host_channel, kept_shells_dir, kept_shells_name};

const USER_DATA: &str = "/home/u/.config/ostia";

#[test]
fn ksh_c61_no_socket_a_sandboxed_shell_can_see_is_its_sandbox_host() {
    let user_data = Path::new(USER_DATA);
    let channel = kept_host_channel(user_data, "w1");
    assert!(is_inside_path(&kept_shells_dir(user_data), &channel));
}

#[test]
fn gives_each_workspace_its_own_host_channel() {
    let user_data = Path::new(USER_DATA);
    assert_ne!(
        kept_host_channel(user_data, "w1"),
        kept_host_channel(user_data, "w2")
    );
    assert_eq!(
        kept_host_channel(user_data, "w1"),
        kept_host_channel(user_data, "w1")
    );
}

#[test]
fn keeps_the_shells_in_a_kept_shells_folder_of_the_user_data_folder() {
    assert_eq!(
        kept_shells_dir(Path::new(USER_DATA)),
        Path::new("/home/u/.config/ostia/kept-shells")
    );
}

#[test]
fn names_the_shells_after_the_first_16_hex_digits_of_the_sha256_of_the_user_data_path() {
    assert_eq!(kept_shells_name(Path::new(USER_DATA)), "6a6ce329fcfd0520");
}

#[test]
fn names_a_host_channel_after_the_hash_of_the_shells_name_a_nul_byte_and_the_workspace_id() {
    let user_data = Path::new(USER_DATA);
    assert_eq!(
        kept_host_channel(user_data, "w1"),
        Path::new("/home/u/.config/ostia/kept-shells/host-707ed00ff7f6daa4.sock")
    );
    assert_eq!(
        kept_host_channel(user_data, "w2"),
        Path::new("/home/u/.config/ostia/kept-shells/host-c30cfbb2bcc74646.sock")
    );
}

#[test]
fn gives_a_different_name_and_channel_to_another_user_data_folder() {
    let other = Path::new("/home/v/.config/ostia");
    assert_ne!(
        kept_shells_name(other),
        kept_shells_name(Path::new(USER_DATA))
    );
    assert_ne!(
        kept_host_channel(other, "w1"),
        kept_host_channel(Path::new(USER_DATA), "w1")
    );
}
