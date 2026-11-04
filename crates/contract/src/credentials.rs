use ostia_base::js::js_trim;
use url::Url;

pub const CREDENTIAL_FIELD_MAX: usize = 1024;

pub fn normalize_origin(raw: &str) -> Option<String> {
    let url = Url::parse(js_trim(raw)).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    Some(url.origin().ascii_serialization())
}
