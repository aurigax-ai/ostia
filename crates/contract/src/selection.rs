#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectionView {
    Source,
    Preview,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextRange {
    pub start_line: u32,
    pub end_line: u32,
    pub start_column: Option<u32>,
    pub end_column: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SelectionCapture {
    Text {
        file: String,
        view: SelectionView,
        range: TextRange,
        text: String,
    },
    Image {
        file: String,
        image_width: u32,
        image_height: u32,
        region: Option<Region>,
    },
    PdfText {
        file: String,
        first_page: u32,
        last_page: u32,
        text: String,
    },
    PdfRegion {
        file: String,
        page: u32,
        page_width: f64,
        page_height: f64,
        region: Option<Region>,
        text: Option<String>,
    },
    Cells {
        file: String,
        sheet: String,
        range: String,
        rows: u32,
        columns: u32,
        csv: String,
    },
    Terminal {
        cwd: Option<String>,
        command: Option<String>,
        text: String,
    },
    PageText {
        url: String,
        title: String,
        text: String,
    },
    PreviewError {
        file: String,
        count: u32,
        text: String,
    },
}

pub fn needs_image(capture: &SelectionCapture) -> bool {
    matches!(
        capture,
        SelectionCapture::Image { .. } | SelectionCapture::PdfRegion { .. }
    )
}
