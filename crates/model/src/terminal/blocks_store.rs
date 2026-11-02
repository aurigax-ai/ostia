use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use ostia_base::clock::{Clock, system_clock};
use ostia_base::random::random_bytes;
use ostia_contract::agent_resume::ResumableAgent;

const MAX_BLOCKS_PER_PANE: usize = 200;
const BASE36: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

#[derive(Debug)]
struct AnchorCell {
    line: AtomicI64,
    disposed: AtomicBool,
}

#[derive(Clone, Debug)]
pub struct LineAnchor(Arc<AnchorCell>);

impl LineAnchor {
    pub fn at(line: i64) -> Self {
        Self(Arc::new(AnchorCell {
            line: AtomicI64::new(line),
            disposed: AtomicBool::new(false),
        }))
    }

    pub fn line(&self) -> i64 {
        self.0.line.load(Ordering::SeqCst)
    }

    pub fn set_line(&self, line: i64) {
        self.0.line.store(line, Ordering::SeqCst);
    }

    pub fn is_disposed(&self) -> bool {
        self.0.disposed.load(Ordering::SeqCst)
    }

    pub fn dispose(&self) {
        self.0.disposed.store(true, Ordering::SeqCst);
    }

    pub fn is_same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    fn identity(&self) -> usize {
        Arc::as_ptr(&self.0) as usize
    }
}

impl PartialEq for LineAnchor {
    fn eq(&self, other: &Self) -> bool {
        self.line() == other.line()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommandBlock {
    pub id: String,
    pub pane_id: String,
    pub prompt_line: LineAnchor,
    pub input_line: Option<LineAnchor>,
    pub output_start_line: LineAnchor,
    pub end_line: Option<LineAnchor>,
    pub end_col: i64,
    pub command: String,
    pub typed_command: Option<String>,
    pub exit_code: Option<i64>,
    pub cwd: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub seq: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub prompt_line: LineAnchor,
    pub input_line: Option<LineAnchor>,
    pub cwd: Option<String>,
    pub remote: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentBlock {
    pub block_id: String,
    pub agent: ResumableAgent,
}

pub struct BlocksStore {
    clock: Clock,
    by_pane: HashMap<String, Vec<CommandBlock>>,
    drafts: HashMap<String, Option<Draft>>,
    running: HashMap<String, Option<String>>,
    gen_by_pane: HashMap<String, u64>,
    selected: HashMap<String, Option<String>>,
    agent_blocks: HashMap<String, Option<AgentBlock>>,
}

impl Default for BlocksStore {
    fn default() -> Self {
        Self::with_clock(system_clock())
    }
}

impl BlocksStore {
    pub fn with_clock(clock: Clock) -> Self {
        Self {
            clock,
            by_pane: HashMap::new(),
            drafts: HashMap::new(),
            running: HashMap::new(),
            gen_by_pane: HashMap::new(),
            selected: HashMap::new(),
            agent_blocks: HashMap::new(),
        }
    }

    pub fn blocks_of(&self, pane_id: &str) -> Option<&[CommandBlock]> {
        self.by_pane.get(pane_id).map(Vec::as_slice)
    }

    pub fn draft_of(&self, pane_id: &str) -> Option<&Draft> {
        self.drafts.get(pane_id).and_then(Option::as_ref)
    }

    pub fn running_of(&self, pane_id: &str) -> Option<&str> {
        self.running
            .get(pane_id)
            .and_then(Option::as_deref)
            .filter(|id| !id.is_empty())
    }

    pub fn gen_of(&self, pane_id: &str) -> Option<u64> {
        self.gen_by_pane.get(pane_id).copied()
    }

    pub fn selected_of(&self, pane_id: &str) -> Option<&str> {
        self.selected.get(pane_id).and_then(Option::as_deref)
    }

    pub fn agent_block_of(&self, pane_id: &str) -> Option<&AgentBlock> {
        self.agent_blocks.get(pane_id).and_then(Option::as_ref)
    }

    pub fn mark_agent(&mut self, pane_id: &str, agent: ResumableAgent) -> bool {
        let Some(block_id) = self.running_of(pane_id).map(str::to_owned) else {
            return false;
        };
        if let Some(current) = self.agent_block_of(pane_id)
            && current.block_id == block_id
            && current.agent == agent
        {
            return false;
        }
        self.agent_blocks
            .insert(pane_id.to_owned(), Some(AgentBlock { block_id, agent }));
        true
    }

    pub fn prompt_start(
        &mut self,
        pane_id: &str,
        line: LineAnchor,
        cwd: Option<&str>,
        remote: bool,
    ) {
        let before = self.pane_anchors(pane_id);
        self.drafts.insert(
            pane_id.to_owned(),
            Some(Draft {
                prompt_line: line,
                input_line: None,
                cwd: cwd.map(str::to_owned),
                remote,
            }),
        );
        self.release_dropped(pane_id, before, &[]);
    }

    pub fn prompt_end(&mut self, pane_id: &str, line: LineAnchor) -> bool {
        let before = self.pane_anchors(pane_id);
        let changed = match self.drafts.get_mut(pane_id) {
            Some(Some(draft)) => {
                draft.input_line = Some(line);
                true
            }
            _ => false,
        };
        self.release_dropped(pane_id, before, &[]);
        changed
    }

    pub fn command_start(
        &mut self,
        pane_id: &str,
        line: LineAnchor,
        command: &str,
        typed_command: Option<&str>,
        seq: Option<i64>,
    ) {
        let before = self.pane_anchors(pane_id);
        let now = (self.clock)();
        let draft = self
            .drafts
            .get(pane_id)
            .cloned()
            .flatten()
            .unwrap_or_else(|| Draft {
                prompt_line: line.clone(),
                input_line: Some(line.clone()),
                cwd: None,
                remote: false,
            });
        let mut list = self.by_pane.remove(pane_id).unwrap_or_default();
        if let Some(stale_id) = self.running_of(pane_id).map(str::to_owned) {
            for block in &mut list {
                if block.id == stale_id && block.end_line.is_none() {
                    block.end_line = Some(line.clone());
                    block.ended_at = Some(now);
                }
            }
        }
        let block = CommandBlock {
            id: format!("{pane_id}-{}-{now}-{}", line.line(), random_suffix()),
            pane_id: pane_id.to_owned(),
            prompt_line: draft.prompt_line,
            input_line: draft.input_line,
            output_start_line: line,
            end_line: None,
            end_col: 0,
            command: command.to_owned(),
            typed_command: typed_command.map(str::to_owned),
            exit_code: None,
            cwd: draft.cwd,
            started_at: now,
            ended_at: None,
            seq,
        };
        let block_id = block.id.clone();
        list.push(block);
        if list.len() > MAX_BLOCKS_PER_PANE {
            list.drain(..list.len() - MAX_BLOCKS_PER_PANE);
        }
        let selection_kept = match self.selected_of(pane_id) {
            None | Some("") => true,
            Some(selected_id) => list.iter().any(|b| b.id == selected_id),
        };
        if !selection_kept {
            self.selected.insert(pane_id.to_owned(), None);
        }
        self.by_pane.insert(pane_id.to_owned(), list);
        self.running.insert(pane_id.to_owned(), Some(block_id));
        self.drafts.insert(pane_id.to_owned(), None);
        self.release_dropped(pane_id, before, &[]);
    }

    pub fn command_end(
        &mut self,
        pane_id: &str,
        line: LineAnchor,
        exit_code: i64,
        end_col: Option<i64>,
        whole_command: Option<&str>,
        whole_typed_command: Option<&str>,
    ) -> bool {
        let before = self.pane_anchors(pane_id);
        let now = (self.clock)();
        let ended = self.finish_running(
            pane_id,
            &line,
            exit_code,
            end_col,
            (whole_command, whole_typed_command),
            now,
        );
        if ended {
            self.running.insert(pane_id.to_owned(), None);
        }
        self.release_dropped(pane_id, before, &[line]);
        ended
    }

    pub fn select(&mut self, pane_id: &str, block_id: Option<&str>) -> bool {
        if self.selected_of(pane_id) == block_id {
            return false;
        }
        if let Some(id) = block_id.filter(|id| !id.is_empty())
            && !self
                .blocks_of(pane_id)
                .is_some_and(|list| list.iter().any(|b| b.id == id))
        {
            return false;
        }
        self.selected
            .insert(pane_id.to_owned(), block_id.map(str::to_owned));
        true
    }

    pub fn reset_pane(&mut self, pane_id: &str) {
        let key = pane_id.to_owned();
        self.by_pane.insert(key.clone(), Vec::new());
        self.selected.insert(key.clone(), None);
        self.drafts.insert(key.clone(), None);
        self.running.insert(key.clone(), None);
        *self.gen_by_pane.entry(key.clone()).or_insert(0) += 1;
        self.agent_blocks.insert(key, None);
    }

    pub fn drop_pane(&mut self, pane_id: &str) -> bool {
        let known = self.by_pane.contains_key(pane_id)
            || self.drafts.contains_key(pane_id)
            || self.running.contains_key(pane_id)
            || self.gen_by_pane.contains_key(pane_id)
            || self.selected.contains_key(pane_id)
            || self.agent_blocks.contains_key(pane_id);
        if !known {
            return false;
        }
        self.by_pane.remove(pane_id);
        self.drafts.remove(pane_id);
        self.running.remove(pane_id);
        self.gen_by_pane.remove(pane_id);
        self.selected.remove(pane_id);
        self.agent_blocks.remove(pane_id);
        true
    }

    fn finish_running(
        &mut self,
        pane_id: &str,
        line: &LineAnchor,
        exit_code: i64,
        end_col: Option<i64>,
        (whole_command, whole_typed_command): (Option<&str>, Option<&str>),
        now: i64,
    ) -> bool {
        let Some(running_id) = self.running_of(pane_id).map(str::to_owned) else {
            return false;
        };
        let Some(block) = self
            .by_pane
            .get_mut(pane_id)
            .and_then(|list| list.iter_mut().find(|b| b.id == running_id))
        else {
            return false;
        };
        if let Some(whole) = whole_command
            && whole.starts_with(&format!("{}\n", block.command))
        {
            block.command = whole.to_owned();
        }
        if let (Some(typed), Some(whole_typed)) = (&block.typed_command, whole_typed_command)
            && whole_typed.starts_with(&format!("{typed}\n"))
        {
            block.typed_command = Some(whole_typed.to_owned());
        }
        block.end_line = Some(line.clone());
        block.end_col = end_col.unwrap_or(0);
        block.exit_code = Some(exit_code);
        block.ended_at = Some(now);
        true
    }

    fn pane_anchors(&self, pane_id: &str) -> Vec<LineAnchor> {
        let mut anchors = Vec::new();
        for block in self.by_pane.get(pane_id).into_iter().flatten() {
            anchors.push(block.prompt_line.clone());
            anchors.push(block.output_start_line.clone());
            anchors.extend(block.input_line.clone());
            anchors.extend(block.end_line.clone());
        }
        if let Some(draft) = self.draft_of(pane_id) {
            anchors.push(draft.prompt_line.clone());
            anchors.extend(draft.input_line.clone());
        }
        anchors
    }

    fn release_dropped(&self, pane_id: &str, before: Vec<LineAnchor>, incoming: &[LineAnchor]) {
        let live: HashSet<usize> = self
            .pane_anchors(pane_id)
            .iter()
            .map(LineAnchor::identity)
            .collect();
        for anchor in before.iter().chain(incoming) {
            if !live.contains(&anchor.identity()) {
                anchor.dispose();
            }
        }
    }
}

fn random_suffix() -> String {
    random_bytes::<5>()
        .iter()
        .map(|byte| char::from(BASE36[usize::from(*byte) % BASE36.len()]))
        .collect()
}
