#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_agents::agent_resumes::AgentResumes;
use ostia_base::ExternalId;
use ostia_contract::agent_resume::{AgentResume, ResumableAgent};

fn resume(id: &str) -> AgentResume {
    AgentResume {
        agent: ResumableAgent::Claude,
        id: id.to_owned(),
        cwd: Some("/home/u/api".to_owned()),
        args: Vec::new(),
    }
}

#[test]
fn delivers_an_emit_to_every_subscriber() {
    let resumes = AgentResumes::default();
    let mut first = resumes.subscribe();
    let mut second = resumes.subscribe();
    resumes.emit(ExternalId::new("ext-1"), resume("s1"));
    assert_eq!(
        first.try_recv().unwrap(),
        (ExternalId::new("ext-1"), resume("s1"))
    );
    assert_eq!(
        second.try_recv().unwrap(),
        (ExternalId::new("ext-1"), resume("s1"))
    );
}

#[test]
fn delivers_emits_in_the_order_they_were_made() {
    let resumes = AgentResumes::default();
    let mut seen = resumes.subscribe();
    resumes.emit(ExternalId::new("ext-1"), resume("s1"));
    resumes.emit(ExternalId::new("ext-2"), resume("s2"));
    assert_eq!(seen.try_recv().unwrap().1.id, "s1");
    assert_eq!(seen.try_recv().unwrap().1.id, "s2");
    assert!(seen.try_recv().is_err());
}

#[test]
fn does_nothing_when_nobody_subscribed() {
    let resumes = AgentResumes::default();
    resumes.emit(ExternalId::new("ext-1"), resume("s1"));
    let mut late = resumes.subscribe();
    assert!(late.try_recv().is_err());
}

#[test]
fn keeps_delivering_after_a_subscriber_is_dropped() {
    let resumes = AgentResumes::default();
    let gone = resumes.subscribe();
    let mut kept = resumes.subscribe();
    drop(gone);
    resumes.emit(ExternalId::new("ext-1"), resume("s1"));
    assert_eq!(kept.try_recv().unwrap().1.id, "s1");
}

#[test]
fn a_clone_shares_the_subscribers() {
    let resumes = AgentResumes::default();
    let mut seen = resumes.subscribe();
    resumes.clone().emit(ExternalId::new("ext-1"), resume("s1"));
    assert_eq!(seen.try_recv().unwrap().0, ExternalId::new("ext-1"));
}
