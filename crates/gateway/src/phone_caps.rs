pub const PHONE_BASE_CAPS: [&str; 2] = ["read", "notify"];

pub const PHONE_GRANTABLE_CAPS: [&str; 4] = ["respond", "command", "input", "destructive"];

pub const CAP_ORDER: [&str; 6] = [
    "read",
    "notify",
    "respond",
    "command",
    "input",
    "destructive",
];

pub fn is_grantable_cap(cap: &str) -> bool {
    PHONE_GRANTABLE_CAPS.contains(&cap)
}
