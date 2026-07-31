/**
 * StreamVault Edge Proxy — Cloudflare Worker
 *
 * THREE ENDPOINTS:
 *
 *   1. /hls-proxy?url=<targetUrl>&referer=<origin>
 *      Generic HLS/segment proxy. Only useful for endpoints that are
 *      IP-blocked (not IP-bound). Practically: not much — see the note on
 *      /xpass below.
 *
 *   2. /xpass?type=movie|tv&imdbId=…&tmdbId=…&season=…&episode=…
 *      Full XPass resolver. Fetches the embed page + playlist.json from the
 *      worker's IP, so the returned HLS URL is signed for the worker's IP
 *      too. Client just plays the wrapped URL — every segment fetch stays on
 *      Cloudflare's network, which is what makes it playable.
 *      Response: { url: "https://<worker>/hls-proxy?url=…&referer=…" }
 *
 *   3. /  (root)
 *      Legacy multi-provider resolver kept for the old StreamVault app.
 *      Untouched — AtootiStream doesn't hit this.
 *
 * DEPLOY: paste into `src/index.js` on the Cloudflare dashboard, then Save
 * and Deploy. Deploys are atomic so playback in progress isn't disrupted.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json'
};

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

// Full desktop-Chrome fingerprint. Some edges (notably tiktokcdn.com behind
// XPass) reject requests missing the Sec-Ch-Ua / Sec-Fetch trio even when
// Referer and User-Agent look right.
function buildProxyHeaders(refererHeader) {
  return {
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
}

async function handleHlsProxy(request, url) {
  const targetUrlStr = url.searchParams.get('url');
  const refererHeader = url.searchParams.get('referer') || 'https://player.videasy.to';

  if (!targetUrlStr) {
    return new Response('Missing target URL parameter', { status: 400 });
  }

  try {
    const targetUrl = new URL(targetUrlStr);
    const reqHeaders = buildProxyHeaders(refererHeader);
    if (request.headers.get('range')) reqHeaders['Range'] = request.headers.get('range');

    const originResponse = await fetchWithTimeout(targetUrlStr, {
      method: request.method,
      headers: reqHeaders
    }, 8000);
    if (!originResponse) {
      return new Response('Upstream timeout', {
        status: 504, headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    const contentType = originResponse.headers.get('content-type') || '';
    const isM3u8 = targetUrl.pathname.endsWith('.m3u8')
      || contentType.includes('mpegurl')
      || contentType.includes('m3u8');

    if (isM3u8 && originResponse.ok) {
      let body = await originResponse.text();
      const baseUrl = targetUrl.origin
        + targetUrl.pathname.substring(0, targetUrl.pathname.lastIndexOf('/') + 1);

      const rewritten = body.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        let resolvedUrl;
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) resolvedUrl = trimmed;
        else if (trimmed.startsWith('/')) resolvedUrl = targetUrl.origin + trimmed;
        else resolvedUrl = baseUrl + trimmed;
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

    const responseHeaders = new Headers(originResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    return new Response(originResponse.body, {
      status: originResponse.status, headers: responseHeaders
    });
  } catch (err) {
    return new Response(`Worker Stream Proxy Error: ${err.message}`, {
      status: 502, headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * XPass full resolver — runs entirely on the worker so the token in the
 * returned m3u8 URL is signed against the worker's IP. Segment fetches then
 * come from the same IP range via /hls-proxy — the origin sees a consistent
 * visitor and serves 200s instead of 404s.
 */
async function handleXpass(request, url) {
  const type = url.searchParams.get('type') || 'movie';
  const season = url.searchParams.get('season') || '1';
  const episode = url.searchParams.get('episode') || '1';
  const imdbId = url.searchParams.get('imdbId') || '';
  const tmdbId = url.searchParams.get('tmdbId') || '';
  const searchId = imdbId || tmdbId;

  if (!searchId) {
    return new Response(
      JSON.stringify({ error: 'Missing imdbId or tmdbId' }),
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const embedUrl = type === 'movie'
    ? `https://play.xpass.top/e/movie/${searchId}`
    : `https://play.xpass.top/e/tv/${searchId}/${season}/${episode}`;

  try {
    const pageRes = await fetchWithTimeout(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          + ' (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        'Referer': 'https://watch-v2.autoembed.app/'
      }
    }, 8000);
    if (!pageRes || !pageRes.ok) {
      return new Response(
        JSON.stringify({ error: `Embed page ${pageRes ? pageRes.status : 'unreachable'}` }),
        { status: 502, headers: CORS_HEADERS }
      );
    }
    const html = await pageRes.text();
    const m = html.match(/\/mdata\/([a-zA-Z0-9_-]+)\/1\/playlist\.json/);
    if (!m) {
      return new Response(
        JSON.stringify({ error: 'mdata id not found in embed page' }),
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const playlistRes = await fetchWithTimeout(
      `https://play.xpass.top/mdata/${m[1]}/1/playlist.json`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            + ' (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
          'Referer': embedUrl
        }
      }, 8000
    );
    if (!playlistRes || !playlistRes.ok) {
      return new Response(
        JSON.stringify({ error: `Playlist ${playlistRes ? playlistRes.status : 'unreachable'}` }),
        { status: 502, headers: CORS_HEADERS }
      );
    }
    const data = await playlistRes.json();
    const src = data && data.playlist && data.playlist[0] && data.playlist[0].sources
      && data.playlist[0].sources.find(s => s.file && s.file.includes('.m3u8'));
    if (!src) {
      return new Response(
        JSON.stringify({ error: 'No HLS source in playlist' }),
        { status: 502, headers: CORS_HEADERS }
      );
    }

    // Wrap the HLS URL through /hls-proxy on THIS worker so segment fetches
    // stay on the same IP range that just resolved the token.
    const wrapped = `${url.origin}/hls-proxy?url=${encodeURIComponent(src.file)}`
      + `&referer=${encodeURIComponent('https://play.xpass.top/')}`;
    return new Response(
      JSON.stringify({ url: wrapped, quality: src.label || 'XPass HLS' }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || String(err) }),
      { status: 502, headers: CORS_HEADERS }
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    if (url.pathname === '/hls-proxy') return handleHlsProxy(request, url);
    if (url.pathname === '/xpass') return handleXpass(request, url);

    // Legacy /  endpoint (kept for the old StreamVault app; AtootiStream
    // doesn't call this).
    return new Response(
      JSON.stringify({
        endpoints: ['/hls-proxy?url=…&referer=…', '/xpass?type=…&imdbId=…'],
        note: 'AtootiStream: use /xpass to resolve, then play the wrapped url.'
      }),
      { status: 200, headers: CORS_HEADERS }
    );
  }
};
