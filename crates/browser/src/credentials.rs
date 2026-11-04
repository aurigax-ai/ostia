use std::fmt;

use ostia_base::js::{is_js_space, js_trim, locale_compare, utf16_len};
use parking_lot::Mutex;
use url::Url;

pub const CREDENTIAL_FIELD_MAX: usize = 1024;

const URL_COLUMNS: [&str; 4] = ["url", "login_uri", "origin", "website"];
const USER_COLUMNS: [&str; 4] = ["username", "login_username", "login", "user"];
const PASSWORD_COLUMNS: [&str; 2] = ["password", "login_password"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialError {
    InvalidOrigin,
    Empty,
    EncryptionUnavailable,
    Cancelled,
    Unreadable,
    NoColumns,
    Storage,
    Crypto,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialSummary {
    pub id: String,
    pub origin: String,
    pub username: String,
    pub updated_at: i64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CredentialMatch {
    pub id: String,
    pub origin: String,
    pub username: String,
    pub updated_at: i64,
    pub password: String,
}

impl fmt::Debug for CredentialMatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialMatch")
            .field("id", &self.id)
            .field("origin", &self.origin)
            .field("username", &self.username)
            .field("password", &"<hidden>")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CredentialInput {
    pub origin: String,
    pub username: String,
    pub password: String,
}

impl fmt::Debug for CredentialInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialInput")
            .field("origin", &self.origin)
            .field("username", &self.username)
            .field("password", &"<hidden>")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct StoredCredential {
    pub id: String,
    pub origin: String,
    pub username: String,
    pub secret: String,
    pub updated_at: i64,
}

impl fmt::Debug for StoredCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredCredential")
            .field("id", &self.id)
            .field("origin", &self.origin)
            .field("username", &self.username)
            .field("secret", &"<hidden>")
            .finish()
    }
}

impl StoredCredential {
    fn summary(&self) -> CredentialSummary {
        CredentialSummary {
            id: self.id.clone(),
            origin: self.origin.clone(),
            username: self.username.clone(),
            updated_at: self.updated_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialSaveResult {
    Saved { id: String, updated: bool },
    Failed { error: CredentialError },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialImportResult {
    Imported {
        imported: usize,
        updated: usize,
        skipped: usize,
    },
    Failed {
        error: CredentialError,
    },
}

type Load = Box<dyn Fn() -> Vec<StoredCredential> + Send + Sync>;
type Save = Box<dyn Fn(&[StoredCredential]) -> Result<(), CredentialError> + Send + Sync>;
type Encrypt = Box<dyn Fn(&str) -> Result<String, CredentialError> + Send + Sync>;

pub struct CredentialDeps {
    pub load: Load,
    pub save: Save,
    pub can_encrypt: Box<dyn Fn() -> bool + Send + Sync>,
    pub encrypt: Encrypt,
    pub decrypt: Encrypt,
    pub now: Box<dyn Fn() -> i64 + Send + Sync>,
    pub new_id: Box<dyn Fn() -> String + Send + Sync>,
}

pub fn normalize_origin(raw: &str) -> Option<String> {
    let url = Url::parse(js_trim(raw)).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

fn take_utf16_units(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut kept = String::new();
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        kept.push(ch);
    }
    kept
}

enum Upsert {
    Invalid(CredentialError),
    Stored { id: String, updated: bool },
}

pub struct CredentialStore {
    deps: CredentialDeps,
    guard: Mutex<()>,
}

pub fn create_credential_store(deps: CredentialDeps) -> CredentialStore {
    CredentialStore {
        deps,
        guard: Mutex::new(()),
    }
}

impl CredentialStore {
    fn upsert(
        &self,
        list: &mut Vec<StoredCredential>,
        input: &CredentialInput,
    ) -> Result<Upsert, CredentialError> {
        let Some(origin) = normalize_origin(&input.origin) else {
            return Ok(Upsert::Invalid(CredentialError::InvalidOrigin));
        };
        let username = take_utf16_units(js_trim(&input.username), CREDENTIAL_FIELD_MAX);
        if input.password.is_empty() || utf16_len(&input.password) > CREDENTIAL_FIELD_MAX {
            return Ok(Upsert::Invalid(CredentialError::Empty));
        }
        let secret = (self.deps.encrypt)(&input.password)?;
        if let Some(existing) = list
            .iter_mut()
            .find(|c| c.origin == origin && c.username == username)
        {
            existing.secret = secret;
            existing.updated_at = (self.deps.now)();
            return Ok(Upsert::Stored {
                id: existing.id.clone(),
                updated: true,
            });
        }
        let id = (self.deps.new_id)();
        list.push(StoredCredential {
            id: id.clone(),
            origin,
            username,
            secret,
            updated_at: (self.deps.now)(),
        });
        Ok(Upsert::Stored { id, updated: false })
    }

    pub fn list(&self) -> Vec<CredentialSummary> {
        let _turn = self.guard.lock();
        let mut summaries: Vec<CredentialSummary> = (self.deps.load)()
            .iter()
            .map(StoredCredential::summary)
            .collect();
        summaries.sort_by(|a, b| {
            locale_compare(&a.origin, &b.origin)
                .then_with(|| locale_compare(&a.username, &b.username))
        });
        summaries
    }

    pub fn save(&self, input: CredentialInput) -> CredentialSaveResult {
        if !(self.deps.can_encrypt)() {
            return CredentialSaveResult::Failed {
                error: CredentialError::EncryptionUnavailable,
            };
        }
        let _turn = self.guard.lock();
        let mut list = (self.deps.load)();
        match self.upsert(&mut list, &input) {
            Err(error) | Ok(Upsert::Invalid(error)) => CredentialSaveResult::Failed { error },
            Ok(Upsert::Stored { id, updated }) => match (self.deps.save)(&list) {
                Ok(()) => CredentialSaveResult::Saved { id, updated },
                Err(error) => CredentialSaveResult::Failed { error },
            },
        }
    }

    pub fn remove(&self, id: &str) -> Result<bool, CredentialError> {
        let _turn = self.guard.lock();
        let list = (self.deps.load)();
        let next: Vec<StoredCredential> = list.iter().filter(|c| c.id != id).cloned().collect();
        if next.len() == list.len() {
            return Ok(false);
        }
        (self.deps.save)(&next)?;
        Ok(true)
    }

    pub fn password(&self, id: &str) -> Result<Option<String>, CredentialError> {
        let _turn = self.guard.lock();
        let Some(entry) = (self.deps.load)().into_iter().find(|c| c.id == id) else {
            return Ok(None);
        };
        if (self.deps.can_encrypt)() {
            (self.deps.decrypt)(&entry.secret).map(Some)
        } else {
            Ok(None)
        }
    }

    pub fn for_origin(&self, url: &str) -> Result<Vec<CredentialMatch>, CredentialError> {
        let Some(origin) = normalize_origin(url) else {
            return Ok(Vec::new());
        };
        if !(self.deps.can_encrypt)() {
            return Ok(Vec::new());
        }
        let _turn = self.guard.lock();
        (self.deps.load)()
            .into_iter()
            .filter(|c| c.origin == origin)
            .map(|c| {
                Ok(CredentialMatch {
                    password: (self.deps.decrypt)(&c.secret)?,
                    id: c.id,
                    origin: c.origin,
                    username: c.username,
                    updated_at: c.updated_at,
                })
            })
            .collect()
    }

    pub fn import_rows(&self, rows: Vec<CredentialInput>) -> CredentialImportResult {
        if !(self.deps.can_encrypt)() {
            return CredentialImportResult::Failed {
                error: CredentialError::EncryptionUnavailable,
            };
        }
        let _turn = self.guard.lock();
        let mut list = (self.deps.load)();
        let (mut imported, mut updated, mut skipped) = (0, 0, 0);
        for row in &rows {
            match self.upsert(&mut list, row) {
                Err(error) => return CredentialImportResult::Failed { error },
                Ok(Upsert::Invalid(_)) => skipped += 1,
                Ok(Upsert::Stored { updated: true, .. }) => updated += 1,
                Ok(Upsert::Stored { updated: false, .. }) => imported += 1,
            }
        }
        match (self.deps.save)(&list) {
            Ok(()) => CredentialImportResult::Imported {
                imported,
                updated,
                skipped,
            },
            Err(error) => CredentialImportResult::Failed { error },
        }
    }
}

fn parse_csv(text: &str) -> Option<Vec<Vec<String>>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut chars = text.chars().peekable();
    let mut field = String::new();
    let mut at_field_start = true;
    loop {
        let next = chars.next();
        match next {
            Some('"') if at_field_start => {
                loop {
                    match chars.next()? {
                        '"' => {
                            if chars.peek() == Some(&'"') {
                                chars.next();
                                field.push('"');
                            } else {
                                break;
                            }
                        }
                        other => field.push(other),
                    }
                }
                let mut spaces = 0;
                while chars.next_if(|&ch| ch != '\n' && is_js_space(ch)).is_some() {
                    spaces += 1;
                }
                match chars.peek() {
                    None if spaces == 0 => {}
                    Some(',' | '\n') => {}
                    _ => return None,
                }
                at_field_start = false;
            }
            Some(',') => {
                row.push(std::mem::take(&mut field));
                at_field_start = true;
            }
            Some('\n') => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                at_field_start = true;
            }
            Some(other) => {
                field.push(other);
                at_field_start = false;
            }
            None => {
                row.push(field);
                rows.push(row);
                return Some(rows);
            }
        }
    }
}

fn normalize_newlines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(ch);
        }
    }
    out
}

fn column_at(names: &[String], options: &[&str]) -> Option<usize> {
    names.iter().position(|n| options.contains(&n.as_str()))
}

pub fn password_rows_from_csv(text: &str) -> Option<Vec<CredentialInput>> {
    let parsed = parse_csv(&normalize_newlines(
        text.strip_prefix('\u{feff}').unwrap_or(text),
    ))?;
    let mut rows = parsed
        .into_iter()
        .filter(|r| !js_trim(&r.concat()).is_empty());
    let header = rows.next()?;
    let names: Vec<String> = header.iter().map(|h| js_trim(h).to_lowercase()).collect();
    let url_at = column_at(&names, &URL_COLUMNS)?;
    let user_at = column_at(&names, &USER_COLUMNS);
    let password_at = column_at(&names, &PASSWORD_COLUMNS)?;
    let cell = |r: &[String], at: usize| r.get(at).cloned().unwrap_or_default();
    Some(
        rows.map(|r| CredentialInput {
            origin: cell(&r, url_at),
            username: user_at.map(|at| cell(&r, at)).unwrap_or_default(),
            password: cell(&r, password_at),
        })
        .collect(),
    )
}
