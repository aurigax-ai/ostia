use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LineMatch {
    pub line: u64,
    pub column: usize,
    pub text: String,
    pub ranges: Vec<(usize, usize)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<LineMatch>,
}
