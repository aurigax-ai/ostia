use std::fs;
use std::path::Path;

use ostia_base::Result;
use ostia_base::atomic_write::{AtomicWriteOptions, write_file_atomic};
use ostia_base::error::io_error;
use ostia_base::js::is_js_space;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BundledSkillFile {
    pub path: &'static str,
    pub text: &'static str,
}

pub const CORE_SKILL_FILES: &[BundledSkillFile] = &[
    BundledSkillFile {
        path: "SKILL.md",
        text: include_str!("../../../src/main/agents/skills/ostia/SKILL.md"),
    },
    BundledSkillFile {
        path: "reference/browser.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/browser.md"),
    },
    BundledSkillFile {
        path: "reference/bus.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/bus.md"),
    },
    BundledSkillFile {
        path: "reference/capabilities.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/capabilities.md"),
    },
    BundledSkillFile {
        path: "reference/git.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/git.md"),
    },
    BundledSkillFile {
        path: "reference/graphs.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/graphs.md"),
    },
    BundledSkillFile {
        path: "reference/panes.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/panes.md"),
    },
    BundledSkillFile {
        path: "reference/previews.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/previews.md"),
    },
    BundledSkillFile {
        path: "reference/reports.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/reports.md"),
    },
    BundledSkillFile {
        path: "reference/sandbox.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/sandbox.md"),
    },
    BundledSkillFile {
        path: "reference/serial.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/serial.md"),
    },
    BundledSkillFile {
        path: "reference/settings.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/settings.md"),
    },
    BundledSkillFile {
        path: "reference/system.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/system.md"),
    },
    BundledSkillFile {
        path: "reference/views.md",
        text: include_str!("../../../src/main/agents/skills/ostia/reference/views.md"),
    },
];

pub const MANAGER_SKILL_FILES: &[BundledSkillFile] = &[BundledSkillFile {
    path: "SKILL.md",
    text: include_str!("../../../src/main/agents/skills/ostia-manager/SKILL.md"),
}];

pub fn write_bundled_skill(dir: &Path, files: &[BundledSkillFile]) -> Result<()> {
    for file in files {
        let target = dir.join(file.path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io_error(parent))?;
        }
        write_file_atomic(&target, file.text.as_bytes(), AtomicWriteOptions::default())?;
    }
    Ok(())
}

pub fn bundled_skill_text(files: &[BundledSkillFile]) -> String {
    files
        .iter()
        .map(|file| {
            format!(
                "==> {} <==\n\n{}",
                file.path,
                file.text.trim_end_matches(is_js_space)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
