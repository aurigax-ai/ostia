use ostia_contract::agent_launch::TypedLaunch;
use ostia_contract::agent_resume::{AgentResume, parse_agent_resume};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StoredResume {
    #[serde(flatten)]
    pub resume: AgentResume,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub typed: Option<TypedLaunch>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeFailure {
    pub resume: StoredResume,
    pub exit_code: i64,
}

pub fn parse_stored_resume(raw: &Value) -> Option<StoredResume> {
    let mut resume = parse_agent_resume(raw)?;
    let typed = resume.typed.take();
    Some(StoredResume { resume, typed })
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
