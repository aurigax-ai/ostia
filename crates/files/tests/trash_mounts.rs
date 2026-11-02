#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_files::trash_mounts::{
    MountEntry, is_system_internal, mount_allows_trash, parse_mount_info, user_mount_at,
};

fn mount(mount_point: &str, fs_type: &str, source: &str) -> MountEntry {
    MountEntry {
        mount_point: mount_point.to_string(),
        fs_type: fs_type.to_string(),
        source: source.to_string(),
    }
}

#[test]
fn parses_the_mount_point_file_system_type_and_source_of_each_line() {
    let text = "36 35 98:0 /mnt1 /mnt/data rw,noatime master:1 - ext4 /dev/sdb1 rw,errors=remount-ro\n40 35 0:21 / /proc rw - proc proc rw";
    let entries = parse_mount_info(text);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].mount_point, "/mnt/data");
    assert_eq!(entries[0].fs_type, "ext4");
    assert_eq!(entries[0].source, "/dev/sdb1");
    assert_eq!(entries[1].mount_point, "/proc");
    assert_eq!(entries[1].fs_type, "proc");
    assert_eq!(entries[1].source, "proc");
}

#[test]
fn unescapes_octal_sequences_in_the_mount_point_and_the_source() {
    let text = "1 0 8:1 / /media/my\\040disk rw - vfat /dev/disk\\040one rw";
    let entries = parse_mount_info(text);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].mount_point, "/media/my disk");
    assert_eq!(entries[0].source, "/dev/disk one");
    let backslash = parse_mount_info("1 0 8:1 / /mnt/a\\134b rw - ext4 /dev/sda1 rw");
    assert_eq!(backslash[0].mount_point, "/mnt/a\\b");
}

#[test]
fn skips_lines_that_are_empty_or_have_no_separator_or_too_few_fields() {
    let table = [
        "",
        "garbage",
        "1 0 8:1 / /mnt/x rw",
        "1 0 8:1 / - ext4 /dev/sda1",
        "1 0 8:1 / /mnt/x rw - ",
        "1 0 8:1 / /mnt/x rw - ext4",
        " - ext4 /dev/sda1",
    ];
    for line in table {
        assert!(parse_mount_info(line).is_empty(), "line {line:?}");
    }
}

#[test]
fn keeps_good_lines_around_a_bad_one() {
    let text =
        "1 0 8:1 / /mnt/a rw - ext4 /dev/sda1 rw\nbad\n2 0 8:2 / /mnt/b rw - xfs /dev/sdb1 rw\n";
    let entries = parse_mount_info(text);
    let points: Vec<&str> = entries
        .iter()
        .map(|entry| entry.mount_point.as_str())
        .collect();
    assert_eq!(points, ["/mnt/a", "/mnt/b"]);
}

#[test]
fn counts_a_mount_of_a_system_file_system_type_as_internal() {
    for fs_type in [
        "adfs",
        "afs",
        "auto",
        "autofs",
        "autofs4",
        "cgroup",
        "cgroup2",
        "configfs",
        "cxfs",
        "debugfs",
        "devfs",
        "devpts",
        "devtmpfs",
        "ecryptfs",
        "efivarfs",
        "fdescfs",
        "fusectl",
        "gfs",
        "gfs2",
        "gpfs",
        "hugetlbfs",
        "kernfs",
        "linprocfs",
        "linsysfs",
        "lustre",
        "lustre_lite",
        "mfs",
        "mqueue",
        "ncpfs",
        "nfsd",
        "nullfs",
        "ocfs2",
        "overlay",
        "proc",
        "procfs",
        "pstore",
        "ptyfs",
        "rootfs",
        "rpc_pipefs",
        "securityfs",
        "selinuxfs",
        "sysfs",
        "tmpfs",
        "usbfs",
    ] {
        assert!(
            is_system_internal(&mount("/mnt/user", fs_type, "/dev/sdx1")),
            "type {fs_type}"
        );
    }
}

#[test]
fn counts_a_mount_at_a_system_path_or_below_a_system_prefix_as_internal() {
    for path in [
        "/",
        "/bin",
        "/boot",
        "/dev",
        "/etc",
        "/home",
        "/lib",
        "/media",
        "/mnt",
        "/opt",
        "/root",
        "/run",
        "/srv",
        "/sys",
        "/tmp",
        "/usr",
        "/usr/local",
        "/var",
        "/var/log",
        "/proc",
        "/net",
        "/dev/shm",
        "/proc/sys/fs/binfmt_misc",
        "/sys/fs/cgroup",
        "/home/u/.gvfs",
    ] {
        assert!(
            is_system_internal(&mount(path, "ext4", "/dev/sdx1")),
            "path {path}"
        );
    }
}

#[test]
fn counts_a_mount_from_a_system_device_as_internal() {
    for source in [
        "proc",
        "devfs",
        "devpts",
        "sysfs",
        "/dev/loop0",
        "/dev/vn1",
        "procfs",
    ] {
        assert!(
            is_system_internal(&mount("/mnt/user", "ext4", source)),
            "source {source}"
        );
    }
}

#[test]
fn does_not_count_a_user_mount_as_internal() {
    for (point, fs_type, source) in [
        ("/mnt/data", "ext4", "/dev/sdb1"),
        ("/media/u/usb", "vfat", "/dev/sdc1"),
        ("/home/u/share", "cifs", "//host/share"),
        ("/mntx", "xfs", "/dev/sdd1"),
        ("/devices", "ext4", "/dev/sde1"),
    ] {
        assert!(
            !is_system_internal(&mount(point, fs_type, source)),
            "mount {point}"
        );
    }
}

#[test]
fn finds_the_last_mount_at_a_path_and_refuses_it_when_it_is_internal() {
    let mounts = [
        mount("/mnt/data", "ext4", "/dev/sdb1"),
        mount("/mnt/data", "xfs", "/dev/sdc1"),
        mount("/mnt/over", "ext4", "/dev/sdd1"),
        mount("/mnt/over", "tmpfs", "tmpfs"),
        mount("/mnt/other", "ext4", "/dev/sde1"),
    ];
    assert_eq!(
        user_mount_at(&mounts, "/mnt/data").unwrap().source,
        "/dev/sdc1"
    );
    assert!(user_mount_at(&mounts, "/mnt/over").is_none());
    assert!(user_mount_at(&mounts, "/mnt/missing").is_none());
    assert!(user_mount_at(&mounts, "/mnt/dat").is_none());
}

#[test]
fn allows_trash_on_a_user_mount_in_mountinfo_text_and_refuses_the_rest() {
    let text = "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:2 / /mnt/data rw - ext4 /dev/sdb1 rw\n3 1 0:5 / /mnt/ram rw - tmpfs tmpfs rw\n";
    assert!(mount_allows_trash(text, "/mnt/data"));
    assert!(!mount_allows_trash(text, "/"));
    assert!(!mount_allows_trash(text, "/mnt/ram"));
    assert!(!mount_allows_trash(text, "/mnt/none"));
    assert!(!mount_allows_trash("", "/mnt/data"));
}
