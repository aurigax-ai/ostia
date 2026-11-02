use ostia_base::js_json::parse_js_json;
use serde_json::Value;

pub const VIEWER_SELECTION_PATH: &str = "/~selection";
pub const VIEWER_OPEN_PATH: &str = "/~open";
pub const VIEWER_EDIT_SOURCE_PATH: &str = "/~edit-source";
pub const VIEWER_FIND_KEYS_PATH: &str = "/~find-keys";

pub const VIEWER_TEXT_MAX: usize = 256 * 1024;
pub const VIEWER_CSV_MAX: usize = 256 * 1024;
pub const VIEWER_CELLS_MAX: usize = 10_000;
pub const VIEWER_IMAGE_MAX: usize = 25 * 1024 * 1024;
pub const VIEWER_FRAME_MAX: usize = 16_384;
pub const VIEWER_OPEN_HREF_MAX: usize = 4096;
pub const VIEWER_SELECTION_BODY_MAX: usize = VIEWER_IMAGE_MAX + 4 * VIEWER_TEXT_MAX;

const LENGTH_BYTES: usize = 4;
const UTF8_BOM: [u8; 3] = [0xef, 0xbb, 0xbf];

#[derive(Clone, Debug, PartialEq)]
pub struct ViewerSelectionBody {
    pub meta: Value,
    pub png: Option<Vec<u8>>,
}

pub fn encode_viewer_selection(meta: &Value, png: Option<&[u8]>) -> Vec<u8> {
    let json = serde_json::to_vec(meta).unwrap_or_default();
    let length = u32::try_from(json.len()).unwrap_or(u32::MAX);
    let mut body = Vec::with_capacity(LENGTH_BYTES + json.len() + png.map_or(0, <[u8]>::len));
    body.extend_from_slice(&length.to_be_bytes());
    body.extend_from_slice(&json);
    if let Some(png) = png {
        body.extend_from_slice(png);
    }
    body
}

pub fn decode_viewer_selection(body: &[u8]) -> Option<ViewerSelectionBody> {
    let (length, rest) = body.split_first_chunk::<LENGTH_BYTES>()?;
    let json_length = usize::try_from(u32::from_be_bytes(*length)).ok()?;
    if json_length > rest.len() {
        return None;
    }
    let (json, tail) = rest.split_at(json_length);
    let json = json.strip_prefix(&UTF8_BOM).unwrap_or(json);
    let meta = parse_js_json(std::str::from_utf8(json).ok()?).ok()?;
    let png = (!tail.is_empty()).then(|| tail.to_vec());
    Some(ViewerSelectionBody { meta, png })
}
