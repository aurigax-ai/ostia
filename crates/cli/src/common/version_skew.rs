use std::fs;
use std::path::{Path, PathBuf};

pub trait SkewMark {
    fn read(&self) -> Option<String>;
    fn write(&self, mark: &str) -> bool;
}

pub struct SkewMarkFile {
    path: PathBuf,
}

impl SkewMark for SkewMarkFile {
    fn read(&self) -> Option<String> {
        fs::read(&self.path)
            .ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    fn write(&self, mark: &str) -> bool {
        fs::write(&self.path, mark).is_ok()
    }
}

pub fn skew_mark_file(path: &Path) -> SkewMarkFile {
    SkewMarkFile {
        path: path.to_owned(),
    }
}

pub fn version_skew_warning(
    app: Option<&str>,
    cli: Option<&str>,
    warned: &impl SkewMark,
) -> Option<String> {
    let app = app.filter(|version| !version.is_empty())?;
    let cli = cli.filter(|version| !version.is_empty())?;
    if app == cli {
        return None;
    }
    let mark = format!("{app}|{cli}");
    if warned.read().as_deref() == Some(mark.as_str()) {
        return None;
    }
    if !warned.write(&mark) {
        return None;
    }
    Some(format!(
        "ostia: the app runs {app}, this CLI is {cli}; restart Ostia"
    ))
}
