/**
 * StreamVault Edge Proxy — Cloudflare Worker
 *
 * ENDPOINTS:
 *
 *   1. /hls-proxy?url=<targetUrl>&referer=<origin>
 *      Generic HLS/segment proxy. Fetches with the supplied Referer,
 *      rewrites child URLs in .m3u8 playlists to loop back through here.
 *
 *   2. /xpass?type=movie|tv&imdbId=…&tmdbId=…&season=…&episode=…
 *      Full XPass resolver. Fetches the embed page + playlist.json from the
 *      worker's IP, then wraps the HLS URL through /hls-proxy on this worker.
 *      Client just plays the returned URL — every segment fetch stays on
 *      Cloudflare's network with a consistent egress IP.
 *      Response: { url, quality }
 *
 *   3. /trybox?title=…&mediaType=movie|tv&year=…&tmdbId=…&imdbId=…&season=…&episode=…
 *      Full TryBox resolver. Fetches seed from api.speedracelight.com,
 *      races the three backends (cdn/vsrc/hdmovie) for sources-with-title,
 *      decrypts the payload with TryBox's custom stream cipher (ported
 *      verbatim from client resolver), and wraps each returned HLS URL
 *      through /hls-proxy on this worker with `Referer: player.videasy.to`.
 *      moon.ironwallnet.net's OpenResty edge checks Referer, which a browser
 *      can't spoof — the worker can. Response: { sources: [...], subtitles }
 *
 *   4. /  (root) — endpoint discovery + legacy fallback.
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

/**
 * TryBox stream cipher — ported verbatim from client resolver (resolver.js).
 * The API returns a base64url-encoded payload whose bytes are XORed against a
 * PRNG seeded from `seed` + `mediaId`. First 4 bytes of the decrypted output
 * are the magic header "mvm1" (109,118,109,49) — a wrong seed produces
 * garbage that fails this check.
 */
const TRYBOX_MAGIC = [109, 118, 109, 49];
const TRYBOX_TABLE_F = [
  1116352408, 1899447441, 3049323471, 3921009573,
  961987163, 1508970993, 2453635748, 2870763221,
  3624381080, 310598401, 607225278, 1426881987,
  1925078388, 2162078206, 2614888103, 3248222580
];
const tbEven = (e) => ((e * (e + 1)) & 1) === 0;
const tbOdd = (e) => ((e * (e + 1)) & 1) === 1;
function tbV(e) {
  e >>>= 0;
  e ^= e >>> 16;
  e = Math.imul(e, 2246822507) >>> 0;
  e ^= e >>> 13;
  e = Math.imul(e, 3266489909) >>> 0;
  return (e ^= e >>> 16) >>> 0;
}
function tbW(e, t) {
  e >>>= 0;
  return (0 === (t &= 31)) ? e >>> 0 : ((e << t) | (e >>> (32 - t))) >>> 0;
}
function tbDecodeB64Url(str) {
  const t = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(4 * Math.ceil(str.length / 4), '=');
  const decoded = atob(t);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}
function tryboxDecrypt(payload, seed, mediaId) {
  const bytes = tbDecodeB64Url(payload);
  const len = bytes.length;

  const state = (function (seedStr, idNum) {
    if (tbOdd(seedStr.length)) {
      const S = (function (s) {
        const arr = new Array(256);
        for (let i = 0; i < 256; i++) arr[i] = i;
        let j = 0;
        for (let i = 0; i < 256; i++) {
          j = (j + arr[i] + s.charCodeAt(i % s.length)) & 255;
          const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
        return arr;
      })(seedStr);
      const acc = (function (s) {
        let accVal = 1732584193;
        for (let i = 0; i < s.length; i++) {
          accVal = tbW((accVal ^ Math.imul(s.charCodeAt(i), TRYBOX_TABLE_F[15 & i])) >>> 0, 5);
        }
        return tbV(accVal);
      })(seedStr);
      return { S, acc };
    }
    const S = new Array(61);
    const hashSeed = (function (s) {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
      return tbV(h);
    })(seedStr);
    let a = tbV(hashSeed ^ tbV((idNum >>> 0) ^ 2654435769)) >>> 0;
    for (let i = 0; i < 8; i++) {
      if (tbEven(i)) {
        const mod61 = a % 61;
        a = tbW((a + 2654435769) >>> 0, 7 + (7 & i));
        S[mod61] = (a ^ tbV(a)) >>> 0;
        a = tbV((a + mod61) >>> 0);
      } else {
        S[i] = TRYBOX_TABLE_F[15 & i];
      }
    }
    return { S, acc: tbV((2779096485 ^ a) >>> 0) };
  })(seed, mediaId);

  const genKey = new Uint8Array(len);
  let genIdx = 0;
  for (let i = 0; i < len;) {
    const nextWord = (function (st, idx) {
      const S = st.S;
      let acc = st.acc;
      const modVal = acc % 61;
      const hasKey = 0 - Number(modVal in S);
      const currentWord = S[modVal] >>> 0;
      let calc = (((acc ^ (currentWord ^ Math.imul(2654435769, idx + 1) >>> 0) >>> 0) >>> 0 |
        (acc & (currentWord ^ Math.imul(2654435769, idx + 1) >>> 0) & hasKey) >>> 0)) >>> 0;
      acc = tbV((calc = (tbW((calc + acc) >>> 0, 31 & modVal) ^ tbW(acc, 31 & Math.imul(modVal, 7))) >>> 0) + 2654435769 >>> 0);
      S[modVal] = acc >>> 0;
      st.acc = acc;
      return acc >>> 0;
    })(state, genIdx++);
    genKey[i++] = 255 & nextWord;
    if (i < len) genKey[i++] = (nextWord >>> 8) & 255;
    if (i < len) genKey[i++] = (nextWord >>> 16) & 255;
    if (i < len) genKey[i++] = (nextWord >>> 24) & 255;
  }
  const decrypted = new Uint8Array(len);
  for (let i = 0; i < len; i++) decrypted[i] = bytes[i] ^ genKey[i];
  for (let i = 0; i < TRYBOX_MAGIC.length; i++) {
    if (decrypted[i] !== TRYBOX_MAGIC[i]) throw new Error('bad magic header or seed mismatch');
  }
  return new TextDecoder('utf-8').decode(decrypted.subarray(TRYBOX_MAGIC.length));
}

async function handleTrybox(request, url) {
  const title = url.searchParams.get('title') || '';
  const mediaType = url.searchParams.get('mediaType') === 'tv' ? 'tv' : 'movie';
  const year = url.searchParams.get('year') || '';
  const tmdbId = url.searchParams.get('tmdbId') || '';
  const imdbId = url.searchParams.get('imdbId') || '';
  const season = url.searchParams.get('season') || '1';
  const episode = url.searchParams.get('episode') || '1';

  if (!tmdbId) {
    return new Response(
      JSON.stringify({ error: 'Missing tmdbId' }),
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const referer = 'https://player.videasy.to/';
  const apiHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      + ' (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    'Referer': referer,
    'Origin': 'https://player.videasy.to',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  try {
    const seedRes = await fetchWithTimeout(
      `https://api.speedracelight.com/seed?mediaId=${encodeURIComponent(tmdbId)}`,
      { headers: apiHeaders },
      8000
    );
    if (!seedRes || !seedRes.ok) {
      return new Response(
        JSON.stringify({ error: `Seed ${seedRes ? seedRes.status : 'unreachable'}` }),
        { status: 502, headers: CORS_HEADERS }
      );
    }
    const seedJson = await seedRes.json();
    const seed = seedJson && seedJson.seed;
    if (!seed) {
      return new Response(
        JSON.stringify({ error: 'No seed returned' }),
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const q = `title=${encodeURIComponent(title)}&mediaType=${mediaType}&year=${encodeURIComponent(year)}`
      + `&episodeId=${encodeURIComponent(episode)}&seasonId=${encodeURIComponent(season)}`
      + `&tmdbId=${encodeURIComponent(tmdbId)}&imdbId=${encodeURIComponent(imdbId)}`
      + `&enc=2&seed=${encodeURIComponent(seed)}`;

    // Race the three backends — first to decrypt into a usable source wins.
    const backends = ['cdn', 'vsrc', 'hdmovie'];
    const attempts = backends.map(async (backend) => {
      const res = await fetchWithTimeout(
        `https://api.speedracelight.com/${backend}/sources-with-title?${q}`,
        { headers: apiHeaders },
        8000
      );
      if (!res || !res.ok) throw new Error(`${backend}: HTTP ${res ? res.status : 'timeout'}`);
      const payload = await res.text();
      const parsed = JSON.parse(tryboxDecrypt(payload, seed, Number(tmdbId)));
      if (!parsed || !parsed.sources || !parsed.sources.length) {
        throw new Error(`${backend}: no sources`);
      }
      return parsed;
    });

    let parsed;
    try {
      parsed = await Promise.any(attempts);
    } catch (aggregateErr) {
      const errors = aggregateErr && aggregateErr.errors;
      const message = errors && errors.length
        ? errors.map(e => e.message).join('; ')
        : 'No video sources available';
      return new Response(
        JSON.stringify({ error: message }),
        { status: 502, headers: CORS_HEADERS }
      );
    }

    // Wrap each HLS URL through /hls-proxy on this worker so segment fetches
    // stay on Cloudflare's IPs and carry the Referer OpenResty demands.
    const refererQ = encodeURIComponent(referer);
    const sources = parsed.sources.map((s, i) => ({
      url: `${url.origin}/hls-proxy?url=${encodeURIComponent(s.url)}&referer=${refererQ}`,
      quality: s.quality || s.label || `Source ${i + 1}`,
      label: s.label
    }));

    return new Response(
      JSON.stringify({
        sources,
        subtitles: Array.isArray(parsed.subtitles) ? parsed.subtitles : []
      }),
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
    if (url.pathname === '/trybox') return handleTrybox(request, url);

    return new Response(
      JSON.stringify({
        endpoints: [
          '/hls-proxy?url=…&referer=…',
          '/xpass?type=…&imdbId=…',
          '/trybox?title=…&mediaType=…&tmdbId=…'
        ]
      }),
      { status: 200, headers: CORS_HEADERS }
    );
  }
};
