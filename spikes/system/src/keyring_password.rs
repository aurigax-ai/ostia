use std::collections::HashMap;

#[derive(Debug, thiserror::Error)]
pub enum PasswordError {
    #[error("no credential store: {0}")]
    NoStore(String),
    #[error("keyring search failed: {0}")]
    Search(keyring_core::Error),
    #[error("{0} keyring items match the search, expected exactly 1")]
    MatchCount(usize),
    #[error("reading the item failed: {0}")]
    Read(keyring_core::Error),
}

pub fn read(attributes: &HashMap<&str, &str>) -> Result<Vec<u8>, PasswordError> {
    keyring::Entry::store_status()
        .as_ref()
        .map_err(|error| PasswordError::NoStore(error.to_string()))?;
    let found = keyring_core::Entry::search(attributes).map_err(PasswordError::Search)?;
    match found.as_slice() {
        [only] => only.get_secret().map_err(PasswordError::Read),
        other => Err(PasswordError::MatchCount(other.len())),
    }
}
