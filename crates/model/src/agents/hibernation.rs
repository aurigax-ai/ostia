#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HibernationPolicy {
    pub idle_seconds: u64,
    pub max_live_terminals: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HibernationCandidate {
    pub pane_id: String,
    pub workspace_id: String,
    pub agent_running: bool,
    pub visible: bool,
    pub idle_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HibernationPlan {
    pub excess: usize,
    pub longest_idle_first: Vec<HibernationCandidate>,
}

pub fn plan_hibernation(
    candidates: &[HibernationCandidate],
    policy: &HibernationPolicy,
) -> HibernationPlan {
    let live: Vec<&HibernationCandidate> = candidates.iter().filter(|c| c.agent_running).collect();
    let excess = live.len().saturating_sub(policy.max_live_terminals);
    if excess == 0 {
        return HibernationPlan {
            excess,
            longest_idle_first: Vec::new(),
        };
    }
    let idle_ms = policy.idle_seconds.saturating_mul(1000);
    let mut longest_idle_first: Vec<HibernationCandidate> = live
        .into_iter()
        .filter(|c| !c.visible && c.idle_ms >= idle_ms)
        .cloned()
        .collect();
    longest_idle_first.sort_by_key(|c| std::cmp::Reverse(c.idle_ms));
    HibernationPlan {
        excess,
        longest_idle_first,
    }
}
