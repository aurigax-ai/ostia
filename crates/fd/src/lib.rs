use std::os::fd::{BorrowedFd, RawFd};

pub fn borrow_fd<'a>(raw: RawFd) -> Option<BorrowedFd<'a>> {
    if raw < 0 {
        return None;
    }
    Some(unsafe { BorrowedFd::borrow_raw(raw) })
}
