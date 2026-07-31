/**
 * StreamVault Primary API Worker — SpeedRace & TryBox Core Engine
 * Authored & Engineered for StreamVault
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json'
};

const SPEEDRACE_HOST = 'https://api.speedracelight.com';
const SPOOF_ORIGIN = 'https://player.videasy.to';

// SpeedRace mvm1 Decryption Table & Magic Header
const MAGIC_HEADER = [109, 118, 109, 49]; // "mvm1"
const TABLE_F = [
  1116352408, 1899447441, 3049323471, 3921009573,
  961987163, 1508970993, 2453635748, 2870763221,
  3624381080, 310598401, 607225278, 1426881987,
  1925078388, 2162078206, 2614888103, 3248222580
];

const isEven = (e) => ((e * (e + 1)) & 1) === 0;
const isOdd = (e) => ((e * (e + 1)) & 1) === 1;

function _v(e) {
  e >>>= 0;
  e ^= e >>> 16;
  e = Math.imul(e, 2246822507) >>> 0;
  e ^= e >>> 13;
  e = Math.imul(e, 3266489909) >>> 0;
  return (e ^= e >>> 16) >>> 0;
}

function _w(e, t) {
  e >>>= 0;
  return (0 === (t &= 31)) ? e >>> 0 : ((e << t) | (e >>> (32 - t))) >>> 0;
}

function decodeBase64Url(str) {
  let t = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(4 * Math.ceil(str.length / 4), '=');
  let decoded = atob(t);
  let bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

function decryptPayload(payload, seed, mediaId) {
  const bytes = decodeBase64Url(payload);
  const len = bytes.length;

  const state = (function (seedStr, idNum, totalLen) {
    if (isOdd(seedStr.length)) {
      const S = (function (s) {
        let arr = new Array(256);
        for (let i = 0; i < 256; i++) arr[i] = i;
        let j = 0;
        for (let i = 0; i < 256; i++) {
          j = (j + arr[i] + s.charCodeAt(i % s.length)) & 255;
          let tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
        return arr;
      })(seedStr);

      const acc = (function (s) {
        let accVal = 1732584193;
        for (let i = 0; i < s.length; i++) {
          accVal = _w((accVal ^ Math.imul(s.charCodeAt(i), TABLE_F[15 & i])) >>> 0, 5);
        }
        return _v(accVal);
      })(seedStr);

      return { S, acc };
    }

    let S = new Array(61);
    let hashSeed = (function (s) {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
      return _v(h);
    })(seedStr);

    let a = _v(hashSeed ^ _v((idNum >>> 0) ^ 2654435769)) >>> 0;
    for (let i = 0; i < 8; i++) {
      if (isEven(i)) {
        let mod61 = a % 61;
        a = _w((a + 2654435769) >>> 0, 7 + (7 & i));
        S[mod61] = (a ^ _v(a)) >>> 0;
        a = _v((a + mod61) >>> 0);
      } else {
        S[i] = TABLE_F[15 & i];
      }
    }
    return { S, acc: _v((2779096485 ^ a) >>> 0) };
  })(seed, mediaId, len);

  const genKey = new Uint8Array(len);
  let genIdx = 0;

  for (let i = 0; i < len;) {
    let nextWord = (function (st, idx) {
      let S = st.S;
      let acc = st.acc;
      let modVal = acc % 61;
      let hasKey = 0 - Number(modVal in S);
      let currentWord = S[modVal] >>> 0;
      let calc = (((acc ^ (currentWord ^ Math.imul(2654435769, idx + 1) >>> 0) >>> 0) >>> 0 |
        (acc & (currentWord ^ Math.imul(2654435769, idx + 1) >>> 0) & hasKey) >>> 0)) >>> 0;

      acc = _v((calc = (_w((calc + acc) >>> 0, 31 & modVal) ^ _w(acc, 31 & Math.imul(modVal, 7))) >>> 0) + 2654435769 >>> 0);
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

  for (let i = 0; i < MAGIC_HEADER.length; i++) {
    if (decrypted[i] !== MAGIC_HEADER[i]) throw new Error("Bad seed or magic header");
  }

  const payloadData = decrypted.subarray(MAGIC_HEADER.length);
  return new TextDecoder('utf-8').decode(payloadData);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const tmdbId = url.searchParams.get('id');
    const imdbId = url.searchParams.get('imdbId') || '';
    const title = encodeURIComponent(url.searchParams.get('title') || '');
    const type = url.searchParams.get('type') || 'movie';
    const season = url.searchParams.get('season') || '1';
    const episode = url.searchParams.get('episode') || '1';
    const year = url.searchParams.get('year') || '';

    if (!tmdbId) {
      return new Response(JSON.stringify({ error: 'Missing TMDB ID parameter' }), { status: 400, headers: CORS_HEADERS });
    }

    try {
      // 1. Fetch seed from SpeedRace
      const seedRes = await fetch(`${SPEEDRACE_HOST}/seed?mediaId=${tmdbId}`, {
        headers: { 'Origin': SPOOF_ORIGIN, 'Referer': SPOOF_ORIGIN + '/' }
      });
      if (!seedRes.ok) throw new Error(`Failed to fetch seed: status ${seedRes.status}`);
      const { seed } = await seedRes.json();

      // 2. Query SpeedRace endpoints in parallel
      const q = `title=${title}&mediaType=${type}&year=${year}&episodeId=${episode}&seasonId=${season}&tmdbId=${tmdbId}&imdbId=${imdbId}&enc=2&seed=${seed}`;
      const endpoints = [
        `${SPEEDRACE_HOST}/vsrc/sources-with-title?${q}`,
        `${SPEEDRACE_HOST}/cdn/sources-with-title?${q}`,
        `${SPEEDRACE_HOST}/hdmovie/sources-with-title?${q}`
      ];

      for (const ep of endpoints) {
        try {
          const res = await fetch(ep, {
            headers: { 'Origin': SPOOF_ORIGIN, 'Referer': SPOOF_ORIGIN + '/' }
          });
          if (!res.ok) continue;

          const encryptedText = await res.text();
          const jsonText = decryptPayload(encryptedText, seed, tmdbId);
          const parsed = JSON.parse(jsonText);

          if (parsed && parsed.sources && parsed.sources.length > 0) {
            return new Response(JSON.stringify({
              tmdbId,
              seed,
              sources: parsed.sources.map(src => ({
                provider: 'SpeedRace Direct',
                quality: src.quality || '1080p HD',
                url: src.url,
                isEmbed: false
              })),
              subtitles: parsed.subtitles || []
            }), { status: 200, headers: CORS_HEADERS });
          }
        } catch (e) {}
      }

      throw new Error('SpeedRace returned empty sources');

    } catch (err) {
      // Fallback to Videasy embed if direct SpeedRace stream fails
      const fallbackUrl = type === 'movie' 
        ? `https://player.videasy.to/movie/${tmdbId}`
        : `https://player.videasy.to/tv/${tmdbId}/${season}/${episode}`;

      return new Response(JSON.stringify({
        tmdbId,
        sources: [{ provider: 'Videasy Fallback', quality: '1080p Embed', url: fallbackUrl, isEmbed: true }],
        subtitles: []
      }), { status: 200, headers: CORS_HEADERS });
    }
  }
};
