use ostia_contract::agent_resume::{AgentResume, parse_stored_resume};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeFailure {
    pub resume: AgentResume,
    pub exit_code: i64,
}

pub fn parse_resume_failure(raw: &Value) -> Option<ResumeFailure> {
    let record = raw.as_object()?;
    let resume = parse_stored_resume(record.get("resume")?)?;
    let exit = record.get("exitCode")?.as_f64()?;
    (exit.fract() == 0.0 && exit > 0.0 && exit < 256.0).then_some(ResumeFailure {
        resume,
        exit_code: exit as i64,
    })
}
