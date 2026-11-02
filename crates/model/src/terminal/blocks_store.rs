#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineAnchor {
    pub line: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandBlock {
    pub id: String,
    pub pane_id: String,
    pub prompt_line: LineAnchor,
    pub input_line: Option<LineAnchor>,
    pub output_start_line: LineAnchor,
    pub end_line: Option<LineAnchor>,
    pub end_col: usize,
    pub command: String,
    pub typed_command: Option<String>,
    pub exit_code: Option<i64>,
    pub cwd: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub seq: Option<i64>,
}
