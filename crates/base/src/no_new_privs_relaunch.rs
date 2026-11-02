use std::collections::BTreeMap;

const RELAUNCHED: &str = "OSTIA_NO_NEW_PRIVS_RELAUNCHED";

pub fn relaunch_without_no_new_privs(
    no_new_privs: bool,
    env: &mut BTreeMap<String, String>,
    launch: &mut dyn FnMut(&BTreeMap<String, String>) -> bool,
    warn: &mut dyn FnMut(&str),
) -> bool {
    let relaunched = env.contains_key(RELAUNCHED);
    env.remove(RELAUNCHED);
    if !no_new_privs {
        return false;
    }
    if relaunched {
        warn("no-new-privs: still set after the systemd relaunch; terminals cannot use sudo");
        return false;
    }
    let mut next = env.clone();
    next.insert(RELAUNCHED.to_owned(), "1".to_owned());
    if launch(&next) {
        return true;
    }
    warn("no-new-privs: could not relaunch through systemd; terminals cannot use sudo");
    false
}
