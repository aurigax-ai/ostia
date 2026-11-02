#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountEntry {
    pub mount_point: String,
    pub fs_type: String,
    pub source: String,
}

const SYSTEM_FS_TYPES: &[&str] = &[
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
];

const SYSTEM_MOUNT_PATHS: &[&str] = &[
    "/",
    "/bin",
    "/boot",
    "/compat/linux/proc",
    "/compat/linux/sys",
    "/dev",
    "/etc",
    "/home",
    "/lib",
    "/lib64",
    "/libexec",
    "/live/cow",
    "/live/image",
    "/media",
    "/mnt",
    "/opt",
    "/rescue",
    "/root",
    "/sbin",
    "/srv",
    "/tmp",
    "/usr",
    "/usr/X11R6",
    "/usr/local",
    "/usr/obj",
    "/usr/ports",
    "/usr/src",
    "/usr/xobj",
    "/var",
    "/var/crash",
    "/var/local",
    "/var/log",
    "/var/log/audit",
    "/var/mail",
    "/var/run",
    "/var/tmp",
    "/proc",
    "/net",
    "/sys",
    "/run",
];

const SYSTEM_MOUNT_PREFIXES: &[&str] = &["/dev/", "/proc/", "/sys/"];

const SYSTEM_DEVICES: &[&str] = &["proc", "devfs", "devpts", "sysfs", "/dev/loop", "/dev/vn"];

fn unescape_mount_field(field: &str) -> String {
    let mut out = String::with_capacity(field.len());
    let mut rest = field;
    while let Some(index) = rest.find('\\') {
        out.push_str(&rest[..index]);
        let after = &rest[index + 1..];
        let digits = after.as_bytes().get(..3);
        match digits {
            Some(octal) if octal.iter().all(|byte| (b'0'..=b'7').contains(byte)) => {
                let code = octal
                    .iter()
                    .fold(0u32, |acc, byte| acc * 8 + u32::from(byte - b'0'));
                out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                rest = &after[3..];
            }
            _ => {
                out.push('\\');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_line(line: &str) -> Option<MountEntry> {
    let mut parts = line.split(" - ");
    let mounted = parts.next().filter(|text| !text.is_empty())?;
    let rest = parts.next().filter(|text| !text.is_empty())?;
    let fields: Vec<&str> = mounted.split(' ').collect();
    let mut rest_fields = rest.split(' ');
    let fs_type = rest_fields.next().filter(|text| !text.is_empty())?;
    let source = rest_fields.next()?;
    if fields.len() < 5 {
        return None;
    }
    Some(MountEntry {
        mount_point: unescape_mount_field(fields[4]),
        fs_type: fs_type.to_string(),
        source: unescape_mount_field(source),
    })
}

pub fn parse_mount_info(text: &str) -> Vec<MountEntry> {
    text.split('\n').filter_map(parse_line).collect()
}

pub fn is_system_internal(mount: &MountEntry) -> bool {
    let path = mount.mount_point.as_str();
    SYSTEM_FS_TYPES.contains(&mount.fs_type.as_str())
        || SYSTEM_MOUNT_PATHS.contains(&path)
        || SYSTEM_MOUNT_PREFIXES
            .iter()
            .any(|prefix| path.starts_with(prefix))
        || path.ends_with("/.gvfs")
        || SYSTEM_DEVICES
            .iter()
            .any(|device| mount.source.starts_with(device))
}

pub fn user_mount_at<'a>(mounts: &'a [MountEntry], path: &str) -> Option<&'a MountEntry> {
    mounts
        .iter()
        .rev()
        .find(|entry| entry.mount_point == path)
        .filter(|mount| !is_system_internal(mount))
}

pub fn mount_allows_trash(mount_info: &str, path: &str) -> bool {
    user_mount_at(&parse_mount_info(mount_info), path).is_some()
}
