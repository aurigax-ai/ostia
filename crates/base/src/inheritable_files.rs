use std::fs::{self, File};
use std::os::fd::OwnedFd;
use std::path::Path;
use std::process::Command;

use command_fds::{CommandFdExt, FdMapping};

use crate::error::{Result, io_error};
use crate::host::Platform;

const O_CLOEXEC: u32 = 0o2_000_000;
const FIRST_SHARED_FD: i32 = 3;
const DEV_NULL: &str = "/dev/null";

#[derive(Debug)]
pub struct InheritedFilesRelease {
    _dev_null: Option<OwnedFd>,
}

fn open_flags(fd: i32) -> Option<u32> {
    let info = fs::read_to_string(format!("/proc/self/fdinfo/{fd}")).ok()?;
    info.lines().find_map(|line| {
        let digits: String = line
            .strip_prefix("flags:")?
            .trim_start_matches(crate::js::is_js_space)
            .chars()
            .take_while(|ch| ('0'..='7').contains(ch))
            .collect();
        u32::from_str_radix(&digits, 8).ok()
    })
}

pub fn inheritable_fds(platform: Platform) -> Vec<i32> {
    if platform != Platform::Linux {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir("/proc/self/fd") else {
        return Vec::new();
    };
    let mut fds: Vec<i32> = entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<i32>().ok())
        .filter(|fd| *fd >= FIRST_SHARED_FD)
        .filter(|fd| open_flags(*fd).is_some_and(|flags| flags & O_CLOEXEC == 0))
        .collect();
    fds.sort_unstable();
    fds
}

pub fn without_inherited_files(
    command: &mut Command,
    fds: &[i32],
) -> Result<InheritedFilesRelease> {
    if fds.is_empty() {
        return Ok(InheritedFilesRelease { _dev_null: None });
    }
    let dev_null = OwnedFd::from(File::open(DEV_NULL).map_err(io_error(Path::new(DEV_NULL)))?);
    let mappings = fds
        .iter()
        .map(|fd| {
            Ok(FdMapping {
                parent_fd: dev_null.try_clone()?,
                child_fd: *fd,
            })
        })
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(io_error(Path::new(DEV_NULL)))?;
    command
        .fd_mappings(mappings)
        .map_err(|collision| std::io::Error::other(collision.to_string()))
        .map_err(io_error(Path::new(DEV_NULL)))?;
    Ok(InheritedFilesRelease {
        _dev_null: Some(dev_null),
    })
}
