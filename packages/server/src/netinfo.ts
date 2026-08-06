/**
 * Host connectivity banner (brief §2.1).
 *
 * "Players can't port-forward" is called out in §6 as the single most likely
 * reason a group fails to play, so this prints all three paths — LAN, public
 * IP, and a ready-to-paste tunnel command — rather than making the host go
 * looking for their own address.
 */

import { networkInterfaces } from 'node:os';

export interface HostAddresses {
  lan: string[];
  public: string | null;
}

/**
 * Non-internal IPv4 addresses.
 * Virtual adapters (WSL, Docker, Hyper-V, VPNs) are filtered out — they are
 * never the address a friend on the couch should type, and listing six
 * candidates makes the useful one harder to find.
 */
export function lanAddresses(): string[] {
  const skip = /^(vEthernet|Loopback|Docker|br-|veth|WSL|Hyper-V|VirtualBox|VMware|Tailscale|ZeroTier|utun|tun)/i;
  const out: string[] = [];

  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (!addrs || skip.test(name)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // 169.254.x.x is a link-local self-assignment: the machine failed to get
      // a DHCP lease, so it is never reachable from another device.
      if (addr.address.startsWith('169.254.')) continue;
      out.push(addr.address);
    }
  }
  // Private ranges first — that's the address that actually works on a LAN.
  return out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

function isPrivate(ip: string): boolean {
  return (
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

/** Best-effort public IP lookup. Never throws and never blocks startup long. */
export async function publicAddress(timeoutMs = 2500): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ip?: string };
    return typeof body.ip === 'string' ? body.ip : null;
  } catch {
    // Offline, DNS blocked, or the service is down — the LAN path still works,
    // so this is informational only and must not be fatal.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

export function printBanner(port: number, addrs: HostAddresses): void {
  const line = '─'.repeat(64);
  const log = console.log;

  log('');
  log(`${BOLD}  Squad Arena${RESET} ${DIM}— host running${RESET}`);
  log(`  ${line}`);
  log('');
  log(`  ${BOLD}On this machine${RESET}`);
  log(`    ${CYAN}http://localhost:${port}${RESET}`);
  log('');

  if (addrs.lan.length > 0) {
    log(`  ${BOLD}Same Wi-Fi / LAN${RESET} ${DIM}— share this with friends in the room${RESET}`);
    for (const ip of addrs.lan) log(`    ${CYAN}http://${ip}:${port}${RESET}`);
    log('');
  } else {
    log(`  ${YELLOW}No LAN address found${RESET} ${DIM}— are you connected to a network?${RESET}`);
    log('');
  }

  if (addrs.public) {
    log(`  ${BOLD}Over the internet${RESET}`);
    log(`    ${CYAN}http://${addrs.public}:${port}${RESET}`);
    log(
      `    ${DIM}This only works if you forward TCP port ${port} to this machine${RESET}`,
    );
    log(`    ${DIM}in your router settings. Most people should use the tunnel below.${RESET}`);
    log('');
  }

  log(`  ${BOLD}Can't port-forward?${RESET} ${DIM}Run this in another terminal:${RESET}`);
  log(`    ${YELLOW}cloudflared tunnel --url http://localhost:${port}${RESET}`);
  log(`    ${DIM}It prints a public https:// URL. Share that. No router setup.${RESET}`);
  log('');
  log(`  ${line}`);
  log(`  ${DIM}Ctrl+C to stop the host. Closing this window ends the match.${RESET}`);
  log('');
}
