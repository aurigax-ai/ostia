use std::collections::{BTreeMap, HashMap};

use ostia_base::js::{is_js_space, js_trim};

use crate::ListeningPort;

const TCP_LISTEN: &str = "0A";
const DELETED_SUFFIX: &str = " (deleted)";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListeningSocket {
    pub port: u16,
    pub inode: String,
    pub uid: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SocketHolder {
    pub name: Option<String>,
    pub inodes: Vec<String>,
}

pub type Owners = BTreeMap<u16, Option<String>>;

fn split_fields(line: &str) -> Vec<&str> {
    js_trim(line)
        .split(is_js_space)
        .filter(|field| !field.is_empty())
        .collect()
}

fn parse_listen_port(local: &str) -> Option<u16> {
    let text = local.rsplit(':').next()?;
    let end = text
        .find(|ch: char| !ch.is_ascii_hexdigit())
        .unwrap_or(text.len());
    if end == 0 {
        return None;
    }
    let value = u32::from_str_radix(&text[..end], 16).ok()?;
    u16::try_from(value).ok().filter(|port| *port > 0)
}

fn parse_socket_line(line: &str) -> Option<ListeningSocket> {
    let fields = split_fields(line);
    if fields.len() < 10 || fields[3] != TCP_LISTEN {
        return None;
    }
    let port = parse_listen_port(fields[1])?;
    let inode = fields[9];
    if inode.is_empty() || !inode.bytes().all(|byte| byte.is_ascii_digit()) || inode == "0" {
        return None;
    }
    let uid = fields[7].parse::<u32>().ok()?;
    Some(ListeningSocket {
        port,
        inode: inode.to_owned(),
        uid,
    })
}

pub fn parse_net_tcp(text: &str) -> Vec<ListeningSocket> {
    text.split('\n')
        .skip(1)
        .filter_map(parse_socket_line)
        .collect()
}

pub fn socket_inode(link: &str) -> Option<String> {
    let inode = link.strip_prefix("socket:[")?.strip_suffix(']')?;
    (!inode.is_empty() && inode.bytes().all(|byte| byte.is_ascii_digit())).then(|| inode.to_owned())
}

pub fn process_name(exe_link: &str, comm: Option<&str>) -> Option<String> {
    let path = exe_link.strip_suffix(DELETED_SUFFIX).unwrap_or(exe_link);
    let base = &path[path.rfind('/').map_or(0, |index| index + 1)..];
    if base.is_empty() {
        comm.map(str::to_owned)
    } else {
        Some(base.to_owned())
    }
}

pub fn add_owner(owners: &mut Owners, port: u16, name: Option<&str>) {
    let slot = owners.entry(port).or_default();
    if slot.is_none() {
        *slot = name.filter(|text| !text.is_empty()).map(str::to_owned);
    }
}

pub fn sorted_ports(owners: &Owners) -> Vec<ListeningPort> {
    owners
        .iter()
        .map(|(&port, name)| ListeningPort {
            port,
            name: name.clone(),
        })
        .collect()
}

pub fn ports_for_holders(
    sockets: &[ListeningSocket],
    holders: &[SocketHolder],
) -> Vec<ListeningPort> {
    let mut holder_of: HashMap<&str, Option<&str>> = HashMap::new();
    for holder in holders {
        for inode in &holder.inodes {
            holder_of
                .entry(inode.as_str())
                .or_insert(holder.name.as_deref());
        }
    }
    let mut owners = Owners::new();
    for socket in sockets {
        if let Some(name) = holder_of.get(socket.inode.as_str()) {
            add_owner(&mut owners, socket.port, *name);
        }
    }
    sorted_ports(&owners)
}
