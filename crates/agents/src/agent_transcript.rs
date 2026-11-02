use std::path::Path;

use ostia_contract::agent_resume::{AgentResume, ResumableAgent};
use ostia_contract::agent_session_info::{
    AgentSessionInfo, claude_session_info, codex_session_info,
};

use crate::transcript_files::{read_range, transcript_path};

pub const TRANSCRIPT_TAIL_BYTES: u64 = 512 * 1024;
const HEAD_BYTES: u64 = 64 * 1024;

fn session_lines(resume: &AgentResume, path: &Path) -> ostia_base::Result<AgentSessionInfo> {
    if resume.agent == ResumableAgent::Claude {
        return Ok(claude_session_info(&read_range(
            path,
            true,
            TRANSCRIPT_TAIL_BYTES,
        )?));
    }
    let mut lines: Vec<String> = read_range(path, false, HEAD_BYTES)?
        .into_iter()
        .take(1)
        .collect();
    lines.extend(read_range(path, true, TRANSCRIPT_TAIL_BYTES)?);
    Ok(codex_session_info(&lines))
}

pub fn read_session_info(resume: &AgentResume, home: &Path) -> Option<AgentSessionInfo> {
    let path = transcript_path(resume, home)?;
    session_lines(resume, &path).ok()
}

pub fn codex_session_folder(resume: &AgentResume, home: &Path) -> Option<String> {
    if resume.agent != ResumableAgent::Codex {
        return None;
    }
    read_session_info(resume, home)?.cwd
}
