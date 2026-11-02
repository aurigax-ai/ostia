use std::collections::{BTreeMap, HashMap};

use crate::ListeningPort;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ListeningSocket {
    pub port: u16,
    pub inode: String,
    pub uid: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SocketHolder {
    pub name: Option<String>,
    pub inodes: Vec<String>,
}

const TCP_LISTEN: &str = "0A";
const DELETED_SUFFIX: &str = " (deleted)";

pub fn parse_net_tcp(text: &str) -> Vec<ListeningSocket> {
    let mut out = Vec::new();
    let mut lines = text.lines();
    lines.next();
    for line in lines {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 || fields[3] != TCP_LISTEN {
            continue;
        }
        let local = fields[1];
        let colon = match local.rfind(':') {
            Some(idx) => idx,
            None => continue,
        };
        let port_hex = &local[colon + 1..];
        let port = match u32::from_str_radix(port_hex, 16) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if port == 0 || port > 65535 {
            continue;
        }
        let inode = fields[9];
        if inode.is_empty() || !inode.chars().all(|c| c.is_ascii_digit()) || inode == "0" {
            continue;
        }
        let uid = match fields[7].parse::<u32>() {
            Ok(u) => u,
            Err(_) => continue,
        };
        out.push(ListeningSocket {
            port: port as u16,
            inode: inode.to_owned(),
            uid,
        });
    }
    out
}

pub fn socket_inode(link: &str) -> Option<String> {
    let inner = link.strip_prefix("socket:[")?.strip_suffix(']')?;
    if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
        Some(inner.to_owned())
    } else {
        None
    }
}

pub fn process_name(exe_link: &str, comm: Option<&str>) -> Option<String> {
    let path = match exe_link.strip_suffix(DELETED_SUFFIX) {
        Some(stripped) => stripped,
        None => exe_link,
    };
    let basename = match path.rfind('/') {
        Some(idx) => &path[idx + 1..],
        None => path,
    };
    if !basename.is_empty() {
        Some(basename.to_owned())
    } else {
        comm.map(str::to_owned)
    }
}

pub fn sorted_ports(owners: &BTreeMap<u16, Option<String>>) -> Vec<ListeningPort> {
    owners
        .iter()
        .map(|(&port, name)| ListeningPort {
            port,
            name: name.clone(),
        })
        .collect()
}

pub fn add_owner(owners: &mut BTreeMap<u16, Option<String>>, port: u16, name: Option<&str>) {
    match owners.get_mut(&port) {
        None => {
            owners.insert(port, name.map(str::to_owned));
        }
        Some(existing) => {
            if existing.is_none() && name.is_some() {
                *existing = name.map(str::to_owned);
            }
        }
    }
}

pub fn ports_for_holders(
    sockets: &[ListeningSocket],
    holders: &[SocketHolder],
) -> Vec<ListeningPort> {
    let mut holder_of: HashMap<&str, Option<&str>> = HashMap::new();
    for holder in holders {
        for inode in &holder.inodes {
            if !holder_of.contains_key(inode.as_str()) {
                holder_of.insert(inode.as_str(), holder.name.as_deref());
            }
        }
    }
    let mut owners: BTreeMap<u16, Option<String>> = BTreeMap::new();
    for s in sockets {
        if let Some(&name) = holder_of.get(s.inode.as_str()) {
            add_owner(&mut owners, s.port, name);
        }
    }
    sorted_ports(&owners)
}
