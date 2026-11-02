use crate::git::ChangeArea;

const SHORT_SHA_UNITS: usize = 7;

pub fn change_diff_title(name: &str, area: ChangeArea, code: &str) -> String {
    let label = if code == "D" {
        "Deleted"
    } else {
        match area {
            ChangeArea::Staged => "Index",
            ChangeArea::Unstaged | ChangeArea::Conflicted => "Working Tree",
            ChangeArea::Untracked => "Untracked",
        }
    };
    format!("{name} ({label})")
}

pub fn commit_diff_title(name: &str, sha: &str) -> String {
    let short = short_sha(sha);
    format!("{name} ({short}^) ↔ {name} ({short})")
}

pub fn files_diff_title(original: &str, modified: &str) -> String {
    format!("{original} ↔ {modified}")
}

fn short_sha(sha: &str) -> &str {
    let mut units = 0;
    for (index, ch) in sha.char_indices() {
        units += ch.len_utf16();
        if units > SHORT_SHA_UNITS {
            return &sha[..index];
        }
    }
    sha
}
