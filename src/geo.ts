/**
 * IP geolocation helper — fire-and-forget, cached in-memory.
 * Uses ipwho.is (free tier, HTTPS, no API key, 10k req/month).
 */

export interface GeoResult {
  city: string;
  region: string;
  country: string;
}

// Bounded LRU-ish cache — evicts oldest insertion when full. For CP Legal's
// expected traffic this cap won't be hit, but it guards against
// pathological fuzzing of the X-Forwarded-For header.
const GEO_CACHE_MAX = 5_000;
const geoCache = new Map<string, GeoResult>();

function cacheSet(key: string, value: GeoResult): void {
  if (geoCache.size >= GEO_CACHE_MAX) {
    const firstKey = geoCache.keys().next().value;
    if (firstKey !== undefined) geoCache.delete(firstKey);
  }
  geoCache.set(key, value);
}

const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|localhost)/;

export async function getGeoForIp(ip: string | undefined): Promise<GeoResult | null> {
  if (!ip) return null;
  // Strip IPv6 prefix
  const cleanIp = ip.replace(/^::ffff:/, '');
  if (PRIVATE_IP_RE.test(cleanIp)) return null;

  const cached = geoCache.get(cleanIp);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `https://ipwho.is/${encodeURIComponent(cleanIp)}?fields=city,region,country,success`,
      { signal: controller.signal },
    ).finally(() => clearTimeout(timeout));
    if (!res.ok) return null;
    const data = await res.json() as { success?: boolean; city?: string; region?: string; country?: string };
    if (data.success === false) return null;
    const result: GeoResult = {
      city: data.city ?? '',
      region: data.region ?? '',
      country: data.country ?? '',
    };
    cacheSet(cleanIp, result);
    return result;
  } catch {
    return null;
  }
}
