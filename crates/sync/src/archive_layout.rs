use std::collections::{HashMap, VecDeque};

const MAX_LINK_HOPS: usize = 40;

#[derive(Default)]
pub(crate) struct ArchiveLayout {
    links: HashMap<Vec<String>, Vec<String>>,
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
            if let Some(target) = self.links.get(&stack) {
                hops += 1;
                if hops > MAX_LINK_HOPS {
                    return None;
                }
                stack.clone_from(target);
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
        let Some(target) = self.resolve(parent.clone(), linkpath) else {
            return false;
        };
        let mut at = parent;
        at.push(name.to_owned());
        self.links.insert(at, target);
        true
    }

    pub(crate) fn hardlink_inside(&self, inside: &str) -> bool {
        self.resolve(Vec::new(), inside).is_some()
    }
}
