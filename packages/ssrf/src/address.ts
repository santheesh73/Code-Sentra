import ipaddr from "ipaddr.js";

/**
 * Only globally routable unicast addresses are allowed. Everything else is refused:
 * loopback, private (RFC 1918), link-local (incl. 169.254.169.254 metadata), CGNAT
 * (incl. 100.100.100.200 metadata), unique-local IPv6 (incl. fd00:ec2::254 metadata),
 * multicast, broadcast, reserved, unspecified, and IPv6 forms that embed IPv4
 * (6to4, Teredo, NAT64), which could smuggle a private IPv4.
 */
export type AddressVerdict = { allowed: true } | { allowed: false; reason: string };

export function checkAddress(ip: string): AddressVerdict {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(ip.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  } catch {
    return { allowed: false, reason: `not an IP address: ${ip}` };
  }
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  const range = parsed.range();
  if (range === "unicast") return { allowed: true };
  return { allowed: false, reason: `${parsed.toString()} is a ${range} address` };
}

export function isIpLiteral(host: string): boolean {
  return ipaddr.isValid(host.replace(/^\[|\]$/g, ""));
}
