/**
 * StreamVault Edge Proxy — Cloudflare Worker
 *
 * TWO ENDPOINTS:
 *
 *   1. /hls-proxy?url=<targetUrl>&referer=<origin>
 *      Proxies any URL — HLS master.m3u8, DASH manifests, video segments,
 *      even JSON API calls. Sets Origin+Referer from the `referer` query so
 *      the origin CDN sees a legitimate browser request. If the response is
 *      an m3u8, child URLs are rewritten to route through this proxy too so
 *      the entire playback session stays behind Cloudflare's trusted IPs.
 *
 *      Used by AtootiStream for:
 *        • XPass segments (tik.1x2.space / p16-sg.tiktokcdn.com) — RESIDENTIAL
 *          IPs get 403 from TikTok's edge; CF worker's IPs are trusted.
 *        • TryBox segments during peak hours — CF's peering to origin CDNs
 *          is faster than most residential ISPs, so buffering is reduced.
 *
 *   2. /  (root)
 *      Legacy multi-provider resolver kept for the old StreamVault app —
 *      untouched. AtootiStream doesn't call this.
 *
 * DEPLOY: `wrangler deploy` (or paste into the Cloudflare dashboard). Every
 * new deploy is atomic so playback in progress isn't disrupted.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json'
};

// Timeout guard so a wedged origin doesn't burn our request quota. Segments
// under 6s are the norm; anything slower probably won't play back anyway.
async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (e) {
    clearTimeout(id);
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ─── EDGE HLS/CDN PROXY ─────────────────────────────────────────────
    // /hls-proxy?url=…&referer=… — supports TryBox, XPass, and any other
    // provider that needs a specific Origin+Referer on segment fetches.
    if (url.pathname === '/hls-proxy') {
      const targetUrlStr = url.searchParams.get('url');
      const refererHeader = url.searchParams.get('referer') || 'https://player.videasy.to';

      if (!targetUrlStr) {
        return new Response('Missing target URL parameter', { status: 400 });
      }

      try {
        const targetUrl = new URL(targetUrlStr);
        // Full desktop-Chrome fingerprint. Some edges (notably tiktokcdn.com
        // behind XPass) 403 requests missing the Sec-Ch-Ua / Sec-Fetch trio
        // even when Referer and User-Agent look right.
        const reqHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            + ' (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
          'Referer': refererHeader,
          'Origin': new URL(refererHeader).origin,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Sec-Ch-Ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site'
        };

        if (request.headers.get('range')) {
          reqHeaders['Range'] = request.headers.get('range');
        }

        const originResponse = await fetchWithTimeout(targetUrlStr, {
          method: request.method,
          headers: reqHeaders
        }, 8000);

        if (!originResponse) {
          return new Response('Upstream timeout', {
            status: 504,
            headers: { 'Access-Control-Allow-Origin': '*' }
          });
        }

        const contentType = originResponse.headers.get('content-type') || '';
        const isM3u8 = targetUrl.pathname.endsWith('.m3u8')
          || contentType.includes('mpegurl')
          || contentType.includes('m3u8');

        if (isM3u8 && originResponse.ok) {
          // Rewrite child URLs so every segment fetch also comes through this
          // worker. Otherwise the first segment leaves CF and the CDN sees
          // the user's residential IP again — and 403s.
          let body = await originResponse.text();
          const baseUrl = targetUrl.origin
            + targetUrl.pathname.substring(0, targetUrl.pathname.lastIndexOf('/') + 1);

          const rewritten = body.split('\n').map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;

            let resolvedUrl;
            if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
              resolvedUrl = trimmed;
            } else if (trimmed.startsWith('/')) {
              resolvedUrl = targetUrl.origin + trimmed;
            } else {
              resolvedUrl = baseUrl + trimmed;
            }

            return `${url.origin}/hls-proxy?url=${encodeURIComponent(resolvedUrl)}`
              + `&referer=${encodeURIComponent(refererHeader)}`;
          }).join('\n');

          return new Response(rewritten, {
            status: 200,
            headers: {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache'
            }
          });
        }

        // Non-m3u8: pass through with CORS opened. Handles video segments,
        // JSON API responses, thumbnails — anything.
        const responseHeaders = new Headers(originResponse.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Headers', '*');

        return new Response(originResponse.body, {
          status: originResponse.status,
          headers: responseHeaders
        });

      } catch (err) {
        return new Response(`Worker Stream Proxy Error: ${err.message}`, {
          status: 502,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ─── LEGACY MULTI-PROVIDER RESOLVER (root) ──────────────────────────
    // Kept untouched for the old StreamVault app. AtootiStream doesn't hit
    // this — it uses its own resolver on the client and only calls
    // /hls-proxy to pipe segments through CF.
    const tmdbId = url.searchParams.get('id');
    let imdbId = url.searchParams.get('imdbId') || '';
    const type = url.searchParams.get('type') || 'movie';
    const season = url.searchParams.get('season') || '1';
    const episode = url.searchParams.get('episode') || '1';

    if (!tmdbId && !imdbId) {
      return new Response(
        JSON.stringify({ error: 'Missing TMDB ID or IMDb ID parameter' }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (!imdbId && tmdbId) {
      try {
        const extRes = await fetchWithTimeout(
          `https://db.speedracelight.com/3/${type}/${tmdbId}/external_ids?language=en-US`,
          {}, 2000
        );
        if (extRes && extRes.ok) {
          const extData = await extRes.json();
          if (extData && extData.imdb_id) imdbId = extData.imdb_id;
        }
      } catch (e) { /* imdb lookup best-effort */ }
    }

    const sources = [];
    const makeProxyUrl = (targetUrl, referer) =>
      `${url.origin}/hls-proxy?url=${encodeURIComponent(targetUrl)}`
      + `&referer=${encodeURIComponent(referer)}`;

    const getXPass = async () => {
      const searchId = imdbId || tmdbId;
      if (!searchId) return;
      try {
        const embedUrl = type === 'movie'
          ? `https://play.xpass.top/e/movie/${searchId}`
          : `https://play.xpass.top/e/tv/${searchId}/${season}/${episode}`;
        const pageRes = await fetchWithTimeout(embedUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://watch-v2.autoembed.app/' }
        });
        if (pageRes && pageRes.ok) {
          const html = await pageRes.text();
          const mdataMatch = html.match(/\/mdata\/([a-zA-Z0-9_-]+)\/1\/playlist\.json/);
          if (mdataMatch) {
            const mdataId = mdataMatch[1];
            const playlistRes = await fetchWithTimeout(
              `https://play.xpass.top/mdata/${mdataId}/1/playlist.json`,
              { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': embedUrl } }
            );
            if (playlistRes && playlistRes.ok) {
              const data = await playlistRes.json();
              const source = data && data.playlist && data.playlist[0]
                && data.playlist[0].sources
                && data.playlist[0].sources.find(s => s.file && s.file.includes('.m3u8'));
              if (source) {
                sources.push({
                  provider: 'XPass Direct HLS',
                  quality: '1080p HD (Direct HLS)',
                  url: makeProxyUrl(source.file, 'https://play.xpass.top/'),
                  isEmbed: false
                });
                return;
              }
            }
          }
        }
      } catch (e) { /* fall through to embed */ }

      sources.push({
        provider: 'XPass',
        quality: 'XPass Player',
        url: type === 'movie'
          ? `https://play.xpass.top/e/movie/${searchId}`
          : `https://play.xpass.top/e/tv/${searchId}/${season}/${episode}`,
        isEmbed: true
      });
    };

    await Promise.allSettled([getXPass()]);

    function score(qualityStr, isEmbed) {
      let s = 0;
      const q = (qualityStr || '').toLowerCase();
      if (q.includes('4k') || q.includes('2160') || q.includes('uhd')) s += 400;
      else if (q.includes('1080') || q.includes('fhd')) s += 200;
      else if (q.includes('720') || q.includes('hd')) s += 100;
      else s += 50;
      if (!isEmbed) s += 500;
      return s;
    }
    sources.sort((a, b) => score(b.quality, b.isEmbed) - score(a.quality, a.isEmbed));

    return new Response(
      JSON.stringify({
        tmdbId,
        imdbId,
        type,
        sourcesCount: sources.length,
        primarySource: sources[0] ? `${sources[0].provider} (${sources[0].quality})` : 'None',
        sources
      }),
      { status: 200, headers: CORS_HEADERS }
    );
  }
};
