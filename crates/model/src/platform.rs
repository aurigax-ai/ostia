use ostia_base::Platform;

pub fn is_mac(platform: Platform) -> bool {
    platform == Platform::Darwin
}

pub fn is_linux(platform: Platform) -> bool {
    platform == Platform::Linux
}
