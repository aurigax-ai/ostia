use ostia_contract::dict::Dict;
use ostia_contract::files_api::ArchiveEntryProblem;

fn line_key(reason: ArchiveEntryProblem) -> &'static str {
    match reason {
        ArchiveEntryProblem::Encrypted => "archiveEncrypted",
        ArchiveEntryProblem::Link => "archiveLink",
        ArchiveEntryProblem::UnzipLimit => "archiveUnzipLimit",
        ArchiveEntryProblem::Gone => "archiveGone",
    }
}

pub fn archive_problem_text(dict: &Dict, reason: ArchiveEntryProblem) -> Option<String> {
    dict.get("editor")?
        .get(line_key(reason))?
        .as_str()
        .map(str::to_owned)
}
