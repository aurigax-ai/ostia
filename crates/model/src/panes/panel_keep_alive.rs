pub const KEEP_ALIVE_MAX: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PanelInstance {
    pub ext_id: String,
    pub workspace_id: String,
}

pub fn same_instance(a: &PanelInstance, b: &PanelInstance) -> bool {
    a == b
}

pub fn instance_key(instance: &PanelInstance) -> String {
    format!("{}\n{}", instance.ext_id, instance.workspace_id)
}

pub fn keep_instance(
    kept: &[PanelInstance],
    shown: &PanelInstance,
    max: usize,
) -> Vec<PanelInstance> {
    let others: Vec<&PanelInstance> = kept.iter().filter(|i| !same_instance(i, shown)).collect();
    let keep = max.saturating_sub(1);
    let start = others.len().saturating_sub(keep);
    others[start..]
        .iter()
        .map(|i| (*i).clone())
        .chain(std::iter::once(shown.clone()))
        .collect()
}
