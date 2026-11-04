use std::collections::{HashMap, VecDeque};

const MAX_LINK_HOPS: usize = 40;

#[derive(Default)]
pub(crate) struct ArchiveLayout {
    links: HashMap<Vec<String>, ArchiveLink>,
}

struct ArchiveLink {
    parent: Vec<String>,
    raw: String,
}

fn components(path: &str) -> impl Iterator<Item = &str> {
    path.split('/')
        .filter(|part| !part.is_empty() && *part != ".")
}

impl ArchiveLayout {
    fn resolve(&self, start: Vec<String>, rest: &str) -> Option<Vec<String>> {
        let mut stack = start;
        let mut pending: VecDeque<String> = components(rest).map(str::to_owned).collect();
        let mut hops = 0;
        while let Some(part) = pending.pop_front() {
            if part == ".." {
                stack.pop()?;
                continue;
            }
            stack.push(part);
            if let Some(link) = self.links.get(&stack) {
                hops += 1;
                if hops > MAX_LINK_HOPS {
                    return None;
                }
                stack.clone_from(&link.parent);
                let target_parts: Vec<&str> = components(&link.raw).collect();
                for target_part in target_parts.into_iter().rev() {
                    pending.push_front(target_part.to_owned());
                }
            }
        }
        Some(stack)
    }

    pub(crate) fn parent_inside(&self, inside: &str) -> Option<Vec<String>> {
        let mut parts: Vec<&str> = components(inside).collect();
        parts.pop();
        self.resolve(Vec::new(), &parts.join("/"))
    }

    pub(crate) fn add_symlink(&mut self, inside: &str, linkpath: &str) -> bool {
        let Some(parent) = self.parent_inside(inside) else {
            return false;
        };
        let Some(name) = components(inside).last() else {
            return false;
        };
        if self.resolve(parent.clone(), linkpath).is_none() {
            return false;
        }
        let mut at = parent.clone();
        at.push(name.to_owned());
        self.links.insert(
            at,
            ArchiveLink {
                parent,
                raw: linkpath.to_owned(),
            },
        );
        true
    }

    pub(crate) fn hardlink_inside(&self, inside: &str) -> bool {
        self.resolve(Vec::new(), inside).is_some()
    }
}
