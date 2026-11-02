#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttachWorkspace {
    Attached(String),
    Refused,
}

pub fn attach_workspace(known: Option<&str>, requested: &str) -> AttachWorkspace {
    let known = known.unwrap_or("");
    if !known.is_empty() && !requested.is_empty() && known != requested {
        return AttachWorkspace::Refused;
    }
    let chosen = if known.is_empty() { requested } else { known };
    AttachWorkspace::Attached(chosen.to_owned())
}
