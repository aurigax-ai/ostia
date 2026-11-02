use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};

const ARCHIVE_SCHEME: &str = "archive:";

const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchivePath {
    pub archive: String,
    pub entry: String,
}

pub fn is_archive_path(path: Option<&str>) -> bool {
    path.is_some_and(|path| path.starts_with(ARCHIVE_SCHEME))
}

pub fn archive_root(real_path: &str) -> String {
    format!(
        "{ARCHIVE_SCHEME}{}!",
        utf8_percent_encode(real_path, URI_COMPONENT)
    )
}

pub fn parse_archive_path(path: &str) -> Option<ArchivePath> {
    let rest = path.strip_prefix(ARCHIVE_SCHEME)?;
    let bang = rest.find('!').filter(|&index| index > 0)?;
    let after = &rest[bang + 1..];
    if !after.is_empty() && !after.starts_with('/') {
        return None;
    }
    let archive = decode_uri_component(&rest[..bang])?;
    if !archive.starts_with('/') {
        return None;
    }
    Some(ArchivePath {
        archive,
        entry: after
            .trim_start_matches('/')
            .trim_end_matches('/')
            .to_owned(),
    })
}

fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let well_formed = bytes.iter().enumerate().all(|(index, &byte)| {
        byte != b'%'
            || bytes
                .get(index + 1..index + 3)
                .is_some_and(|pair| pair.iter().all(u8::is_ascii_hexdigit))
    });
    if !well_formed {
        return None;
    }
    percent_decode_str(text)
        .decode_utf8()
        .ok()
        .map(|decoded| decoded.into_owned())
}
