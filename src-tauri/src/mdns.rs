use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::collections::HashMap;
use log::{error, info};

const SERVICE_TYPE: &str = "_venobridge._tcp.local.";
const HOSTNAME:     &str = "venobridge.local.";
const PORT:         u16  = 3355;

pub struct MdnsHandle {
    daemon: ServiceDaemon,
    fullname: String,
}

impl MdnsHandle {
    pub fn stop(self) {
        if let Err(e) = self.daemon.unregister(&self.fullname) {
            error!("[mDNS] unregister error: {}", e);
        }
        self.daemon.shutdown().ok();
    }
}

/// Broadcast the bridge as `_venobridge._tcp.local.` on port 3355.
pub fn start_mdns(instance_name: &str) -> Option<MdnsHandle> {
    let daemon = match ServiceDaemon::new() {
        Ok(d)  => d,
        Err(e) => {
            error!("[mDNS] failed to create daemon: {}", e);
            return None;
        }
    };

    // Collect host IP addresses (try all interfaces)
    let my_addrs: Vec<std::net::Ipv4Addr> = get_local_ipv4_addrs();
    if my_addrs.is_empty() {
        error!("[mDNS] no local IPv4 addresses found, skipping mDNS");
        return None;
    }

    let props: HashMap<String, String> = [("version", "1.0.0"), ("app", "venoapp-bridge")]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

    let service = match ServiceInfo::new(
        SERVICE_TYPE,
        instance_name,
        HOSTNAME,
        std::net::IpAddr::V4(my_addrs[0]),
        PORT,
        props,
    ) {
        Ok(s)  => s,
        Err(e) => {
            error!("[mDNS] ServiceInfo error: {}", e);
            return None;
        }
    };

    let fullname = service.get_fullname().to_string();

    if let Err(e) = daemon.register(service) {
        error!("[mDNS] register error: {}", e);
        return None;
    }

    info!("[mDNS] Registered {} on port {}", fullname, PORT);

    Some(MdnsHandle { daemon, fullname })
}

/// Returns all non-loopback IPv4 addresses on the machine.
fn get_local_ipv4_addrs() -> Vec<std::net::Ipv4Addr> {
    let mut addrs = Vec::new();

    // Parse /proc/net/if_inet6 is Linux-only; use a portable approach via
    // connecting a UDP socket — this forces the OS to pick an interface.
    use std::net::UdpSocket;
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        sock.connect("8.8.8.8:80").ok();
        if let Ok(local) = sock.local_addr() {
            if let std::net::IpAddr::V4(v4) = local.ip() {
                if !v4.is_loopback() {
                    addrs.push(v4);
                }
            }
        }
    }

    // Fallback: 127.0.0.1 (at least the daemon won't crash)
    if addrs.is_empty() {
        addrs.push(std::net::Ipv4Addr::LOCALHOST);
    }

    addrs
}
