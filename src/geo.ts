/**
 * IP geolocation helper — fire-and-forget, cached in-memory.
 * Uses ip-api.com free tier (no API key required, rate limited to ~45 req/min).
 */

export interface GeoResult {
  city: string;
  region: string;
  country: string;
}

const geoCache = new Map<string, GeoResult>();

const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|localhost)/;

export async function getGeoForIp(ip: string | undefined): Promise<GeoResult | null> {
  if (!ip) return null;
  // Strip IPv6 prefix
  const cleanIp = ip.replace(/^::ffff:/, '');
  if (PRIVATE_IP_RE.test(cleanIp)) return null;

  if (geoCache.has(cleanIp)) return geoCache.get(cleanIp)!;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(cleanIp)}?fields=city,regionName,country`,
      { signal: controller.signal },
    ).finally(() => clearTimeout(timeout));
    if (!res.ok) return null;
    const data = await res.json() as { city?: string; regionName?: string; country?: string };
    const result: GeoResult = {
      city: data.city ?? '',
      region: data.regionName ?? '',
      country: data.country ?? '',
    };
    geoCache.set(cleanIp, result);
    return result;
  } catch {
    return null;
  }
}
