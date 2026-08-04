/**
 * StreamVault Edge Worker — SpeedRace + Viduki + Flicky
 * Copyright (c) 2026 Moey.
 *
 * ROUTES:
 *   GET  /viduki/movie/{tmdbId}
 *   GET  /viduki/tv/{tmdbId}/{season}/{episode}
 *   GET  /flicky/movie/{tmdbId}
 *   GET  /flicky/tv/{tmdbId}/{season}/{episode}
 *   GET  /?id=…&type=…&season=…&episode=…   (legacy SpeedRace/TryBox root)
 *
 * All routes return: { sources: [{ url, quality }], subtitles: [] } | { error }.
 *
 * Viduki + Flicky do the full WASM crypto server-side so Android (which has no
 * local Node) can hit the Worker from ExoPlayer's referer-setting HTTP stack
 * and play direct from cdn1.1shows.app — the fat video download bypasses the
 * Worker entirely; only the ~1-second resolve does an edge hop.
 *
 * DEPLOY: `git push` — GitHub Actions calls wrangler-action to publish.
 * wrangler.jsonc has a [[rules]] entry that tells wrangler to precompile any
 * .wasm import into a WebAssembly.Module and bundle it into the deploy.
 * `new WebAssembly.Instance(MAKIMA_WASM, ...)` is allowed at request time
 * because the compile already happened at build time — only runtime compile
 * of raw bytes is blocked ("Wasm code generation disallowed by embedder").
 */
import MAKIMA_WASM from '../makima.wasm';
import FLICKY_WASM from '../flicky.wasm';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json'
};

const SPEEDRACE_HOST = 'https://api.speedracelight.com';
const SPOOF_ORIGIN = 'https://player.videasy.to';

// ─── SpeedRace mvm1 decryption (unchanged, kept for the legacy root route) ───
const MAGIC_HEADER = [109, 118, 109, 49];
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
  const state = (function (seedStr, idNum) {
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
  })(seed, mediaId);
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
  return new TextDecoder('utf-8').decode(decrypted.subarray(MAGIC_HEADER.length));
}

// ─── byte helpers (Buffer-free, work in Workers) ─────────────────────────────
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i << 1, 2), 16);
  return out;
}
function bytesToHex(b) {
  let s = ''; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// ─── Sync SHA-256 (needed for the ALTCHA PoW inner loop) ─────────────────────
// crypto.subtle.digest is async — awaiting each of ~65k iterations would take
// forever. FIPS 180-4 in plain JS runs the same batch in ~200ms which matches
// what we get from Node's crypto.createHash on the same workload.
const SHA256_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
const SHA256_H0 = new Uint32Array([
  0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
  0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
]);
const _rotr = (x, n) => (x >>> n) | (x << (32 - n));
function sha256(msg) {
  const L = msg.length;
  const padLen = ((L + 9 + 63) & ~63);
  const padded = new Uint8Array(padLen);
  padded.set(msg);
  padded[L] = 0x80;
  const bitLen = L * 8;
  padded[padLen - 4] = (bitLen >>> 24) & 0xFF;
  padded[padLen - 3] = (bitLen >>> 16) & 0xFF;
  padded[padLen - 2] = (bitLen >>> 8) & 0xFF;
  padded[padLen - 1] = bitLen & 0xFF;
  const H = new Uint32Array(SHA256_H0);
  const W = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = (padded[block + i * 4] << 24) | (padded[block + i * 4 + 1] << 16)
           | (padded[block + i * 4 + 2] << 8) | padded[block + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = _rotr(W[i - 15], 7) ^ _rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = _rotr(W[i - 2], 17) ^ _rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + W[i]) >>> 0;
      const S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (H[i] >>> 24) & 0xFF;
    out[i * 4 + 1] = (H[i] >>> 16) & 0xFF;
    out[i * 4 + 2] = (H[i] >>> 8) & 0xFF;
    out[i * 4 + 3] = H[i] & 0xFF;
  }
  return out;
}
function sha256Hex(str) {
  return bytesToHex(sha256(new TextEncoder().encode(str)));
}

// ─── WASM modules ────────────────────────────────────────────────────────────
// Imported at top-of-file via `import MAKIMA_WASM from '../makima.wasm'` (see
// header). Wrangler's [[rules]] CompiledWasm rule turns each import into a
// precompiled WebAssembly.Module baked into the deploy, so we can call
// `new WebAssembly.Instance(MODULE, imports)` at request time without ever
// running WebAssembly.instantiate(bytes) — which CF blocks.

// ─── Viduki (1shows) ─────────────────────────────────────────────────────────
// Their frontend WASM (makima.wasm) does all crypto. Exports are hashed but
// we recovered the arg orders from viduki-recon/. Session state is held in
// module-scope so the same Worker isolate can reuse the pepper for ~60s.
const VIDUKI_EXPORT_MAP = {
  alloc: '_gMLw', reset: '_6vB7', writeByte: '_G03w', readByte: '_xHqE',
  decryptPepper: '_aYur', decryptEnvelope: '_hmkb'
};
const VIDUKI_SPOOF = {
  'Origin': 'https://www.viduki.net',
  'Referer': 'https://www.viduki.net/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    + ' (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Encoding': 'identity'
};

let vidukiWasmPromise = null;
let vidukiSession = null;         // { bootNonce, expiresAt }
let vidukiSessionPromise = null;  // in-flight bootstrap

function vidukiEnsureWasm() {
  if (vidukiWasmPromise) return vidukiWasmPromise;
  vidukiWasmPromise = (async () => {
    // Instantiating from a precompiled Module is allowed at request time;
    // WebAssembly.instantiate(bytes) is not (CF blocks runtime compile).
    const instance = new WebAssembly.Instance(MAKIMA_WASM, {
      env: { abort: () => { throw new Error('viduki wasm abort'); } }
    });
    const w = {};
    for (const [k, v] of Object.entries(VIDUKI_EXPORT_MAP)) w[k] = instance.exports[v];
    return w;
  })();
  return vidukiWasmPromise;
}

async function vidukiGet(url, extra = {}) {
  // Origin is a "forbidden" fetch header per spec and CF Workers only forward
  // it when set via `new Headers()`, not via a plain object. Without Origin,
  // api.viduki.net returns a decoy `{stream: {url: hls-cdn77...}}` payload
  // that has nothing to do with the requested route. Using the Headers
  // constructor is the only way through.
  const h = new Headers();
  for (const [k, v] of Object.entries({ ...VIDUKI_SPOOF, ...extra })) h.set(k, v);
  const res = await fetch(url, { headers: h });
  const body = await res.text();
  return { status: res.status, body };
}

function vidukiSolveAltcha(c) {
  const salt = c.salt;
  const target = c.challenge;
  const max = c.maxnumber || 200000;
  for (let n = 0; n <= max; n++) {
    if (sha256Hex(salt + n) === target) return n;
  }
  throw new Error('altcha unsolvable');
}
function vidukiMakeAltcha(c, n) {
  const s = JSON.stringify({
    algorithm: c.algorithm, challenge: c.challenge, number: n,
    salt: c.salt, signature: c.signature, took: 100
  });
  return btoa(s);
}

function vCopyIn(w, data) {
  const ptr = w.alloc(data.length);
  for (let i = 0; i < data.length; i++) w.writeByte(ptr, i, data[i]);
  return ptr;
}
function vCopyOut(w, ptr, len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = w.readByte(ptr, i);
  return out;
}

/**
 * Full bootstrap: ALTCHA #1 → /bootstrap → ALTCHA #2 → /pepper-key → WASM
 * pepper decrypt. Session (bootNonce + WASM internal pepper) is good for ~60s.
 */
async function vidukiFreshSession() {
  const w = await vidukiEnsureWasm();
  const c1 = JSON.parse((await vidukiGet('https://api.viduki.net/altcha-challenge')).body);
  const boot = await vidukiGet('https://api.viduki.net/bootstrap',
    { 'x-altcha': vidukiMakeAltcha(c1, vidukiSolveAltcha(c1)) });
  const bootNonce = JSON.parse(boot.body).n;
  if (!bootNonce) throw new Error('no bootstrap nonce');

  const c2 = JSON.parse((await vidukiGet('https://api.viduki.net/altcha-challenge')).body);
  const pk = JSON.parse((await vidukiGet('https://api.viduki.net/pepper-key',
    { 'x-altcha': vidukiMakeAltcha(c2, vidukiSolveAltcha(c2)), 'x-nonce': bootNonce })).body);
  if (!pk || !pk.iv) throw new Error('bad pepper envelope');

  w.reset();
  const tbBuf = new Uint8Array(8);
  new DataView(tbBuf.buffer).setBigInt64(0, BigInt(pk.bucket), false);
  const nonceBytes = hexToBytes(bootNonce);
  const iv = hexToBytes(pk.iv), ct = hexToBytes(pk.ct), tag = hexToBytes(pk.tag);
  const rc = w.decryptPepper(
    vCopyIn(w, nonceBytes), nonceBytes.length,
    vCopyIn(w, tbBuf), 8,
    vCopyIn(w, iv), iv.length,
    vCopyIn(w, ct), ct.length,
    vCopyIn(w, tag), tag.length
  );
  if (rc <= 0) throw new Error('pepper decrypt failed');
  vidukiSession = { bootNonce, expiresAt: Date.now() + 60000 };
  return vidukiSession;
}

function vidukiGetSession() {
  if (vidukiSession && vidukiSession.expiresAt > Date.now()) return Promise.resolve(vidukiSession);
  if (vidukiSessionPromise) return vidukiSessionPromise;
  vidukiSessionPromise = vidukiFreshSession()
    .finally(() => { vidukiSessionPromise = null; });
  return vidukiSessionPromise;
}

/** Fetch and decrypt any /main/* envelope. Returns the parsed plaintext JSON. */
async function vidukiFetchEnvelope(pathAndQuery) {
  const w = await vidukiEnsureWasm();
  for (let attempt = 0; attempt < 2; attempt++) {
    const sess = await vidukiGetSession();
    const cn = randomBytes(16);
    const rid = randomBytes(16);
    const res = await vidukiGet('https://api.viduki.net' + pathAndQuery, {
      'x-nonce': sess.bootNonce,
      'x-client-nonce': bytesToHex(cn),
      'x-request-id': bytesToHex(rid)
    });
    if (res.status !== 200) {
      vidukiSession = null;
      if (attempt === 1) throw new Error(`viduki HTTP ${res.status}`);
      continue;
    }
    const env = JSON.parse(res.body);
    const tbBuf = new Uint8Array(8);
    new DataView(tbBuf.buffer).setBigInt64(0, BigInt(env.tb), false);
    const sn = hexToBytes(env.sn), iv2 = hexToBytes(env.iv2), wk = hexToBytes(env.wk);
    const tag2 = hexToBytes(env.tag2), iv1 = hexToBytes(env.iv1);
    const ctBytes = hexToBytes(env.ct), tag1 = hexToBytes(env.tag1);
    const outPtr = w.alloc(ctBytes.length);
    const outLen = w.decryptEnvelope(
      vCopyIn(w, cn), cn.length,
      vCopyIn(w, sn), 16,
      vCopyIn(w, tbBuf), 8,
      vCopyIn(w, rid), rid.length,
      vCopyIn(w, iv2), iv2.length,
      vCopyIn(w, wk), wk.length,
      vCopyIn(w, tag2), tag2.length,
      vCopyIn(w, iv1), iv1.length,
      vCopyIn(w, ctBytes), ctBytes.length,
      vCopyIn(w, tag1), tag1.length,
      outPtr
    );
    if (outLen <= 0) {
      vidukiSession = null;
      if (attempt === 1) throw new Error('envelope decrypt failed');
      continue;
    }
    return JSON.parse(new TextDecoder().decode(vCopyOut(w, outPtr, outLen)));
  }
  throw new Error('viduki: exhausted retries');
}

/**
 * Verify a viduki-resolved URL is actually playable. Some server tokens the
 * CDN has already invalidated (405/403/404); we can't tell from the encrypted
 * response alone, so we fetch the master playlist and check the first bytes.
 */
async function vidukiVerifyUrl(url) {
  try {
    const h = new Headers();
    h.set('Origin', 'https://www.viduki.net');
    h.set('Referer', 'https://www.viduki.net/');
    h.set('User-Agent', VIDUKI_SPOOF['User-Agent']);
    h.set('Accept', '*/*');
    const res = await fetch(url, { headers: h });
    if (!res.ok) return false;
    const text = (await res.text()).trimStart();
    return text.startsWith('#EXTM3U');
  } catch (e) { return false; }
}

/**
 * Race a shortlist of server names in parallel through the WASM crypto path
 * and return the first one that also proves playable. Faster than serial
 * because we're bound by network + PoW, and both parallelize well.
 */
async function vidukiRaceServers(pathBase, servers) {
  const attempts = servers.map(async (srv) => {
    const plain = await vidukiFetchEnvelope(`${pathBase}?srv=${srv}`);
    const url = plain && plain.stream && plain.stream.url;
    if (!url) throw new Error(`${srv}: no url`);
    const ok = await vidukiVerifyUrl(url);
    if (!ok) throw new Error(`${srv}: unplayable`);
    return { srv, url };
  });
  return Promise.any(attempts);
}

/**
 * Diagnostic: hit an echo service to see which headers CF Workers actually
 * forward on outgoing fetch — Origin is a "forbidden request header" per the
 * Fetch spec, and Workers may strip it. If yes, viduki's ALTCHA endpoint is
 * unreachable via a plain CF fetch and we need a workaround.
 */
async function handleViduki(url) {
  const suffix = url.pathname.slice('/viduki/'.length);
  const parts = suffix.split('/');
  let base;
  if (parts[0] === 'movie' && parts[1]) base = `/main/movie/${parts[1]}`;
  else if (parts[0] === 'tv' && parts[1] && parts[2] && parts[3]) {
    base = `/main/tv/${parts[1]}/${parts[2]}/${parts[3]}`;
  } else {
    return new Response(JSON.stringify({ error: 'usage: /viduki/movie/{id} or /viduki/tv/{id}/{s}/{e}' }),
      { status: 400, headers: CORS_HEADERS });
  }
  try {
    const servers = ['Ada', 'Claire', 'Ethan', 'Leon', 'Hunk', 'Nemesis'];
    const win = await vidukiRaceServers(base, servers);
    return new Response(JSON.stringify({
      sources: [{ url: win.url, quality: `Viduki HLS (${win.srv})` }],
      subtitles: []
    }), { status: 200, headers: CORS_HEADERS });
  } catch (agg) {
    const errs = agg && agg.errors;
    const msg = errs && errs.length ? errs.map(e => e.message).join(', ') : (agg && agg.message) || 'viduki failed';
    return new Response(JSON.stringify({ error: msg }), { status: 502, headers: CORS_HEADERS });
  }
}

// ─── Flickystream (goated.cx/1shows) ─────────────────────────────────────────
// Same 1shows backend as Viduki but no PoW, no bootstrap. The WASM (flicky.wasm)
// exports deobfuscate(n,d) which takes AssemblyScript strings (UTF-16LE with a
// 4-byte length prefix stored at ptr-4).
const FLICKY_SPOOF = {
  'Origin': 'https://flickystream.dad',
  'Referer': 'https://flickystream.dad/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    + ' (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'Accept': '*/*'
};
let flickyWasmPromise = null;
function flickyEnsureWasm() {
  if (flickyWasmPromise) return flickyWasmPromise;
  flickyWasmPromise = (async () => {
    const instance = new WebAssembly.Instance(FLICKY_WASM, {
      env: { abort: () => { throw new Error('flicky wasm abort'); } }
    });
    return instance;
  })();
  return flickyWasmPromise;
}
function flickyAllocString(inst, s) {
  const bytes = utf16leEncodeStr(s);
  const ptr = inst.exports.__new(bytes.length, 1);
  new Uint8Array(inst.exports.memory.buffer).set(bytes, ptr);
  return ptr;
}
function utf16leEncodeStr(s) {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xFF;
    out[i * 2 + 1] = (c >> 8) & 0xFF;
  }
  return out;
}
function flickyReadString(inst, ptr) {
  const mem = new Uint8Array(inst.exports.memory.buffer);
  const dv = new DataView(mem.buffer);
  const len = dv.getUint32(ptr - 4, true);
  let s = '';
  for (let i = 0; i < len; i += 2) s += String.fromCharCode(mem[ptr + i] | (mem[ptr + i + 1] << 8));
  return s;
}

async function flickyGet(url, extra = {}) {
  // Same Origin-strip issue as viduki — use Headers() constructor so the
  // Origin header actually makes it out of the Worker. (Flicky was working
  // by luck because its API tolerates a missing Origin, but keeping this
  // consistent avoids a future regression.)
  const h = new Headers();
  for (const [k, v] of Object.entries({ ...FLICKY_SPOOF, ...extra })) h.set(k, v);
  const res = await fetch(url, { headers: h });
  const body = await res.text();
  return { status: res.status, body };
}

async function flickyResolveStream(mediaKind, tmdbId, season, episode, server) {
  const inst = await flickyEnsureWasm();
  const suffix = mediaKind === 'tv'
    ? `tv/${tmdbId}/${season || 1}/${episode || 1}`
    : `movie/${tmdbId}`;
  const res = await flickyGet(`https://api.flickystream.dad/api/streams/${suffix}?s=${encodeURIComponent(server)}`);
  if (res.status !== 200) throw new Error(`flicky HTTP ${res.status}`);
  const env = JSON.parse(res.body);
  if (!env || !env.n || !env.d) throw new Error('flicky: bad envelope');
  const nPtr = flickyAllocString(inst, env.n);
  const dPtr = flickyAllocString(inst, env.d);
  const resultPtr = inst.exports.deobfuscate(nPtr, dPtr);
  if (!resultPtr) throw new Error('flicky: deobfuscate returned null');
  return JSON.parse(flickyReadString(inst, resultPtr));
}

async function handleFlicky(url) {
  const suffix = url.pathname.slice('/flicky/'.length);
  const parts = suffix.split('/');
  let mediaKind, tmdbId, season, episode;
  if (parts[0] === 'movie' && parts[1]) {
    mediaKind = 'movie'; tmdbId = parts[1];
  } else if (parts[0] === 'tv' && parts[1] && parts[2] && parts[3]) {
    mediaKind = 'tv'; tmdbId = parts[1]; season = parts[2]; episode = parts[3];
  } else {
    return new Response(JSON.stringify({ error: 'usage: /flicky/movie/{id} or /flicky/tv/{id}/{s}/{e}' }),
      { status: 400, headers: CORS_HEADERS });
  }
  try {
    const trySrvs = ['tik', 'ipcloud', 'v4:English', 'v5:Hindi'];
    const attempts = trySrvs.map(async (srv) => {
      const plain = await flickyResolveStream(mediaKind, tmdbId, season, episode, srv);
      if (!plain || !plain.url) throw new Error(`${srv}: no url`);
      const ok = await vidukiVerifyUrl(plain.url);
      if (!ok) throw new Error(`${srv}: unplayable`);
      return { srv, url: plain.url };
    });
    const win = await Promise.any(attempts);
    return new Response(JSON.stringify({
      sources: [{ url: win.url, quality: `Flickystream HLS (${win.srv})` }],
      subtitles: []
    }), { status: 200, headers: CORS_HEADERS });
  } catch (agg) {
    const errs = agg && agg.errors;
    const msg = errs && errs.length ? errs.map(e => e.message).join(', ') : (agg && agg.message) || 'flicky failed';
    return new Response(JSON.stringify({ error: msg }), { status: 502, headers: CORS_HEADERS });
  }
}

// ─── Legacy TryBox/SpeedRace handler (unchanged behaviour, kept intact) ──────
async function handleTrybox(url) {
  const tmdbId = url.searchParams.get('id') || url.searchParams.get('tmdbId');
  const imdbId = url.searchParams.get('imdbId') || '';
  const title = encodeURIComponent(url.searchParams.get('title') || '');
  const type = url.searchParams.get('type') || url.searchParams.get('mediaType') || 'movie';
  const season = url.searchParams.get('season') || '1';
  const episode = url.searchParams.get('episode') || '1';
  const year = url.searchParams.get('year') || '';

  if (!tmdbId) {
    return new Response(JSON.stringify({ error: 'Missing TMDB ID parameter' }),
      { status: 400, headers: CORS_HEADERS });
  }
  try {
    const seedRes = await fetch(`${SPEEDRACE_HOST}/seed?mediaId=${tmdbId}`, {
      headers: { 'Origin': SPOOF_ORIGIN, 'Referer': SPOOF_ORIGIN + '/' }
    });
    if (!seedRes.ok) throw new Error(`Failed to fetch seed: status ${seedRes.status}`);
    const { seed } = await seedRes.json();
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

// ─── HLS Proxy with R2 caching ────────────────────────────────────────────────
// Routes segment/playlist fetches through the Worker with two upsides:
//   1. CF's IPs are trusted by CDNs (like ironwallnet's TikTok-CDN backing)
//      that 403 residential ISPs during peak hours.
//   2. R2 caching: on hit → serve straight from the CF edge (free egress,
//      15-25 ms typical vs 60-140 ms round-tripping through origin). On miss
//      → stream from origin, tee the body into R2 while it flows to the
//      client so the FIRST viewer already populates the cache with no wait.
//
// R2 cache key strategy — TryBox's ironwallnet + roomsquare URLs are
// content-hashed (empirically verified: same tmdbId + same quality returns
// the exact same base64 blob across hours). So we key by the FULL upstream
// URL. When TryBox eventually re-encodes and hands us a different blob, R2
// simply misses and repopulates — no manual invalidation needed.
//
// Cacheable if:
//   - Method is GET
//   - Not an .m3u8 playlist (tiny, needs rewriting on every serve)
//   - Not a Range request (partial content — defer to future work)
// We DON'T host-allowlist any more: the caller (server.js `/proxy-stream`
// or Android's resolveTryboxCached) only routes to `/hls-proxy` segment URLs
// that came out of a playlist we already trusted. New TryBox edge domains
// (wavechill/roomsquare/etc.) get cached without ever touching this file.

// Rewrites relative URIs in an HLS playlist so segment fetches keep going
// through the Worker with the same referer. Absolute URLs get proxied too so
// nested playlists (master → variant → segments) all stay on our edge.
function rewritePlaylist(text, baseUrl, refererParam, workerBase) {
  const base = new URL(baseUrl);
  const wrapUrl = (raw) => {
    let abs;
    try { abs = new URL(raw, base).toString(); }
    catch (e) { return raw; }
    return `${workerBase}/hls-proxy?url=${encodeURIComponent(abs)}`
      + `&referer=${encodeURIComponent(refererParam)}`;
  };
  return text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) {
      // Rewrite URI= attributes inside #EXT-X-KEY / #EXT-X-MEDIA / #EXT-X-MAP.
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrapUrl(u)}"`);
    }
    return wrapUrl(t);
  }).join('\n');
}

async function handleHlsProxy(request, url, env, ctx) {
  const upstream = url.searchParams.get('url');
  if (!upstream) {
    return new Response(JSON.stringify({ error: 'need ?url=' }), {
      status: 400, headers: CORS_HEADERS
    });
  }

  let upstreamHost;
  try { upstreamHost = new URL(upstream).host; }
  catch (e) {
    return new Response(JSON.stringify({ error: 'bad url' }), {
      status: 400, headers: CORS_HEADERS
    });
  }

  // Resolve the Referer to forward upstream. Callers usually pass one via
  // `?referer=`, but as a safety net we default known hosts to the Referer
  // the origin requires — Mapplee's heistotron.uk edges 403 without a
  // mapplee.com Referer, for example. Falls back to the generic TryBox
  // spoof only if the host is unknown.
  let referer = url.searchParams.get('referer');
  if (!referer) {
    if (/(^|\.)(heistotron\.uk|mapplee\.com)$/i.test(upstreamHost)) {
      referer = 'https://mapplee.com/';
    } else {
      referer = SPOOF_ORIGIN + '/';
    }
  }

  // Playlists detected by URL extension only up front — some providers use
  // opaque URLs (mapplee's source.heistotron.uk/p/{blob} serves both playlist
  // and segment with the same URL shape). We re-check by Content-Type on the
  // upstream response below and jump back into the rewrite path if needed.
  const isPlaylistByUrl = /\.m3u8(\?|$)/i.test(upstream);
  const hasRange = !!request.headers.get('range');
  // Provisional cacheability — refined once we know the content type.
  const cacheable = env.HLS_CACHE
    && !isPlaylistByUrl
    && !hasRange
    && request.method === 'GET';

  // ── 1. R2 hit path ────────────────────────────────────────────────────────
  // Key by full URL so content-hashed TryBox blobs deduplicate across viewers.
  const cacheKey = cacheable ? upstream : null;
  if (cacheKey) {
    const obj = await env.HLS_CACHE.get(cacheKey);
    if (obj) {
      // Rescue path: if we previously (mistakenly) cached a playlist as a
      // "segment" because its URL didn't end in .m3u8 (mapplee's opaque
      // /p/{blob} URLs), re-detect via stored content-type and re-run the
      // playlist rewrite so segment URIs inside still point at the Worker.
      // Delete the bad entry so next fetch stores fresh.
      const cachedCT = (obj.httpMetadata?.contentType || '').toLowerCase();
      if (cachedCT.includes('mpegurl')) {
        const text = await obj.text();
        const workerBase = `${url.protocol}//${url.host}`;
        const rewritten = rewritePlaylist(text, upstream, referer, workerBase);
        // Drop the mis-cached playlist so this doesn't recur.
        ctx.waitUntil(env.HLS_CACHE.delete(cacheKey).catch(() => {}));
        return new Response(rewritten, {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
            'Content-Type': 'application/vnd.apple.mpegurl',
            'X-Cache': 'R2-HIT-PLAYLIST-REWRITE',
          }
        });
      }
      const h = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Cache': 'R2-HIT',
        'Content-Type': obj.httpMetadata?.contentType || 'video/mp2t',
      });
      if (obj.size) h.set('Content-Length', String(obj.size));
      return new Response(obj.body, { status: 200, headers: h });
    }
  }

  // ── 2. Upstream fetch ────────────────────────────────────────────────────
  // Rotate through real browser User-Agents so a CDN using UA+IP fingerprint
  // throttling doesn't accumulate a single-signature history for us. Doesn't
  // help against pure IP-range throttling, but many origins (including some
  // TryBox edges) bucket by combo. Picked randomly per request.
  const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  ];
  const ACCEPT_LANG_POOL = [
    'en-US,en;q=0.9',
    'en-GB,en-US;q=0.9,en;q=0.8',
    'en-US,en;q=0.9,es;q=0.8',
    'en-CA,en-US;q=0.9,en;q=0.8',
  ];
  const pickedUa = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  const pickedLang = ACCEPT_LANG_POOL[Math.floor(Math.random() * ACCEPT_LANG_POOL.length)];

  const upstreamHeaders = {
    'Accept': '*/*',
    'Accept-Language': pickedLang,
    'User-Agent': pickedUa,
    'Referer': referer,
    'Origin': new URL(referer).origin,
  };
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) upstreamHeaders['Range'] = rangeHeader;

  const upstreamRes = await fetch(upstream, {
    method: 'GET',
    headers: upstreamHeaders,
    // cf.cacheEverything lets CF's L1 also cache — belt & braces with R2.
    cf: { cacheEverything: true, cacheTtl: 86400 }
  });

  // Playlist detection — either URL says .m3u8, or the upstream advertised
  // an HLS mime type. Second check catches mapplee's opaque /p/{blob} URLs
  // that serve BOTH playlist and segment with the same URL shape but
  // different content-type.
  const upstreamCT = (upstreamRes.headers.get('content-type') || '').toLowerCase();
  const isPlaylistByType = upstreamCT.includes('mpegurl');
  const isPlaylist = isPlaylistByUrl || isPlaylistByType;

  // Playlist responses: buffer, rewrite segment URIs, serve. Small enough
  // to buffer without memory concern (playlists max out ~200 KB).
  if (isPlaylist && upstreamRes.ok) {
    const text = await upstreamRes.text();
    const workerBase = `${url.protocol}//${url.host}`;
    const rewritten = rewritePlaylist(text, upstream, referer, workerBase);
    return new Response(rewritten, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/vnd.apple.mpegurl',
        'X-Cache': 'MISS-PLAYLIST',
      }
    });
  }

  // ── 3. Segment miss path — stream to client AND tee into R2 ──────────────
  const status = upstreamRes.status;
  const outHeaders = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': status === 200 ? 'public, max-age=31536000, immutable' : 'no-store',
    'X-Cache': cacheKey ? (status === 200 ? 'MISS-STORING' : 'MISS-NOSTORE') : 'BYPASS',
  });
  ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(k => {
    const v = upstreamRes.headers.get(k);
    if (v) outHeaders.set(k, v);
  });

  if (!upstreamRes.body) {
    return new Response(null, { status, headers: outHeaders });
  }

  // Only tee to R2 on cacheable 200 responses. 206/416 stay pass-through.
  if (!cacheKey || status !== 200) {
    return new Response(upstreamRes.body, { status, headers: outHeaders });
  }

  const [toClient, toR2] = upstreamRes.body.tee();
  const contentType = upstreamRes.headers.get('content-type') || 'video/mp2t';
  // ctx.waitUntil keeps the R2 write alive after the client gets EOF, so a
  // fast viewer who closes the tab doesn't kill the cache population.
  // Post-write, we also do an inline byte-cap check — real-time defense in
  // case cron misses runs and the bucket balloons between scheduled sweeps.
  // Runs in waitUntil so it doesn't add response latency.
  ctx.waitUntil(
    env.HLS_CACHE.put(cacheKey, toR2, {
      httpMetadata: { contentType, cacheControl: 'public, max-age=31536000' }
    })
      .then(() => enforceBudget(env))
      .catch(err => console.error('R2 put or budget check failed', cacheKey, err.message))
  );
  return new Response(toClient, { status: 200, headers: outHeaders });
}

// Post-write byte-cap guard — quick list of the bucket, if total > cap,
// delete oldest until under. Runs after every MISS-STORING so a runaway
// prefetch loop can't push us past 10 GB between cron runs. Free tier
// budget: 1M Class A ops/mo. Rough load: ~600 writes/hour of playback +
// 600 lists = ~28k ops/day = 850k/mo. Under limit.
async function enforceBudget(env) {
  const maxBytes = parseInt(env.CACHE_MAX_BYTES, 10) || (8 * 1024 * 1024 * 1024);
  const all = [];
  let cursor;
  do {
    const page = await env.HLS_CACHE.list({ limit: 1000, cursor });
    for (const o of page.objects) all.push(o);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  let total = all.reduce((s, o) => s + (o.size || 0), 0);
  if (total <= maxBytes) return;
  const oldestFirst = all.slice().sort((a, b) => a.uploaded - b.uploaded);
  for (const o of oldestFirst) {
    if (total <= maxBytes) break;
    await env.HLS_CACHE.delete(o.key).catch(err =>
      console.error('inline evict failed', o.key, err.message));
    total -= (o.size || 0);
  }
}

// ─── R2 rolling-window eviction ──────────────────────────────────────────────
// Cron fires every 5 min (see wrangler.toml [triggers]). Lists everything in
// HLS_CACHE and deletes objects whose `uploaded` timestamp is older than
// CACHE_TTL_MIN minutes. Default 15 min — active playback needs ~30s of
// buffer + some rewind room, 15 min covers that plus a healthy safety margin.
// Tune via env var CACHE_TTL_MIN without redeploying: `wrangler secret put`.
//
// R2 list is paginated at 1000/page. A typical rolling window contains a few
// hundred segments per active viewer, so one page is nearly always enough,
// but we loop just in case. Each list is 1 Class A op; deletes are Class B.
// At 5 min cadence = 288 lists/day = free-tier trivial.
//
// Bonus: also enforces a hard SIZE ceiling. If total bytes exceeds
// CACHE_MAX_BYTES (default 8 GB — under 10 GB free tier, room for the
// current in-flight writes), we delete the oldest until under the cap.
async function evictR2(env) {
  const bucket = env.HLS_CACHE;
  if (!bucket) return { skipped: 'no R2 binding' };

  const ttlMin = parseInt(env.CACHE_TTL_MIN, 10) || 15;
  const maxBytes = parseInt(env.CACHE_MAX_BYTES, 10) || (8 * 1024 * 1024 * 1024);
  const cutoff = Date.now() - ttlMin * 60 * 1000;

  const all = [];
  let cursor;
  do {
    const page = await bucket.list({ limit: 1000, cursor });
    for (const o of page.objects) all.push(o);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);

  // 1. Age-based eviction — drop anything past the rolling window.
  const stale = all.filter(o => o.uploaded.getTime() < cutoff);
  await Promise.all(stale.map(o =>
    bucket.delete(o.key).catch(err => console.error('delete failed', o.key, err.message))
  ));

  // 2. Size-based eviction — if we're still over the cap after age eviction,
  //    keep deleting oldest until under. Rare, but a safety net for weird
  //    edge cases (bug, huge segment, cron skipped a run).
  const remaining = all.filter(o => o.uploaded.getTime() >= cutoff);
  let totalBytes = remaining.reduce((s, o) => s + (o.size || 0), 0);
  const oldestFirst = remaining.slice().sort((a, b) => a.uploaded - b.uploaded);
  const overflowDeleted = [];
  for (const o of oldestFirst) {
    if (totalBytes <= maxBytes) break;
    await bucket.delete(o.key).catch(err => console.error('overflow del failed', o.key, err.message));
    totalBytes -= (o.size || 0);
    overflowDeleted.push(o.key);
  }

  return {
    scanned: all.length,
    ageEvicted: stale.length,
    overflowEvicted: overflowDeleted.length,
    remainingBytes: totalBytes,
    remainingObjects: all.length - stale.length - overflowDeleted.length,
    ttlMinutes: ttlMin,
    capBytes: maxBytes
  };
}

// ─── Mapplee proxy ───────────────────────────────────────────────────────────
// Thin CORS-friendly relay for the three mapplee endpoints the client needs.
// The PoW between step 2 and step 4 runs in the CLIENT (SubtleCrypto), not
// here — Worker CPU limits would blow on a 300-800ms mining loop, and the
// browser/WebView native SHA-256 impl is faster than we'd be anyway.
//
// Routes:
//   GET  /mapplee/page?tmdb=X&type=movie|tv[&season=X&episode=Y]
//        → { requestToken, subtitles: [...] }
//   POST /mapplee/handshake
//        body: { mediaId, mediaType, requestToken[, pow] }
//        → verbatim mapplee response (either { pow: {...} } or { token })
//   GET  /mapplee/stream?mediaId=…&mediaType=…&requestToken=…&token=…
//        → { stream_url }
//
// All requests forward Referer: https://mapplee.com/ per mapplee expectation.
async function handleMapplee(request, url) {
  const MAPPLEE = 'https://mapplee.com';
  const REFERER = 'https://mapplee.com/';
  const path = url.pathname.slice('/mapplee'.length);
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json'
  };

  try {
    // GET /mapplee/page — fetch the watch page HTML, extract __REQUEST_TOKEN__.
    if (path === '/page') {
      const tmdb = url.searchParams.get('tmdb');
      const type = url.searchParams.get('type') || 'movie';
      if (!tmdb) {
        return new Response(JSON.stringify({ error: 'need tmdb' }), { status: 400, headers: cors });
      }
      let watchPath;
      if (type === 'tv') {
        const s = url.searchParams.get('season') || '1';
        const e = url.searchParams.get('episode') || '1';
        watchPath = `/watch/tv/${tmdb}/${s}/${e}`;
      } else {
        watchPath = `/watch/movie/${tmdb}`;
      }
      const res = await fetch(MAPPLEE + watchPath, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        }
      });
      if (!res.ok) {
        return new Response(JSON.stringify({ error: `page ${res.status}` }), { status: res.status, headers: cors });
      }
      const html = await res.text();
      const m = html.match(/__REQUEST_TOKEN__[^e]*?(eyJ[A-Za-z0-9_.\-]+)/);
      if (!m) {
        return new Response(JSON.stringify({ error: 'no __REQUEST_TOKEN__ in page' }), { status: 502, headers: cors });
      }
      return new Response(JSON.stringify({ requestToken: m[1] }), { status: 200, headers: cors });
    }

    // POST /mapplee/handshake — pass through to /api/playback-init.
    if (path === '/handshake' && request.method === 'POST') {
      const body = await request.text();
      const res = await fetch(MAPPLEE + '/api/playback-init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': REFERER + 'watch/',
          'Origin': MAPPLEE,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        },
        body
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { ...cors, 'Content-Type': res.headers.get('content-type') || 'application/json' }
      });
    }

    // GET /mapplee/stream — pass through to /api/stream, forward all mapplee
    // query params through. Returns the JSON with stream_url.
    if (path === '/stream') {
      const passed = new URLSearchParams(url.searchParams);
      // Mapplee expects specific query names; ensure required ones are present.
      passed.set('source', 'mapple');
      passed.set('apikey', 'mptv_sk_a8f29c4e7b3d1f');
      const res = await fetch(MAPPLEE + '/api/stream?' + passed.toString(), {
        headers: {
          'Referer': REFERER,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        }
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { ...cors, 'Content-Type': res.headers.get('content-type') || 'application/json' }
      });
    }

    // Fallback: probe endpoint that just returns "reachable from Worker" info.
    if (path === '/probe') {
      const res = await fetch(MAPPLEE + '/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (probe)' }
      });
      return new Response(JSON.stringify({
        status: res.status,
        ok: res.ok,
        server: res.headers.get('server'),
        cfMitigated: res.headers.get('cf-mitigated'),
      }), { status: 200, headers: cors });
    }

    return new Response(JSON.stringify({ error: 'unknown /mapplee route' }), { status: 404, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 500, headers: cors });
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    if (url.pathname === '/hls-proxy') return handleHlsProxy(request, url, env, ctx);
    // Manual trigger for debugging + on-demand purge. Returns the same stats
    // the cron would log so we can verify eviction from curl.
    if (url.pathname === '/r2/evict') {
      const stats = await evictR2(env);
      return new Response(JSON.stringify(stats), {
        status: 200, headers: CORS_HEADERS
      });
    }
    // Quick health check on R2 usage — handy for the eventual "library" UI.
    if (url.pathname === '/r2/stats') {
      const all = [];
      let cursor;
      do {
        const page = await env.HLS_CACHE.list({ limit: 1000, cursor });
        for (const o of page.objects) all.push({ key: o.key, size: o.size, uploaded: o.uploaded });
        cursor = page.truncated ? page.cursor : null;
      } while (cursor);
      const totalBytes = all.reduce((s, o) => s + (o.size || 0), 0);
      return new Response(JSON.stringify({
        objects: all.length,
        totalBytes,
        totalMB: (totalBytes / 1024 / 1024).toFixed(1),
        oldest: all.length ? all.reduce((a, b) => a.uploaded < b.uploaded ? a : b).uploaded : null,
        newest: all.length ? all.reduce((a, b) => a.uploaded > b.uploaded ? a : b).uploaded : null,
      }), { status: 200, headers: CORS_HEADERS });
    }
    if (url.pathname.startsWith('/mapplee/')) return handleMapplee(request, url);
    if (url.pathname.startsWith('/viduki/')) return handleViduki(url);
    if (url.pathname.startsWith('/flicky/')) return handleFlicky(url);
    return handleTrybox(url);
  },

  // Cron entry point — see wrangler.toml [triggers.crons]. Wrapped in
  // waitUntil so a slow evict doesn't kill the invocation limit; result is
  // logged so `wrangler tail` shows stats after each run.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const stats = await evictR2(env);
      console.log('[cron] evict', event.scheduledTime, JSON.stringify(stats));
    })());
  }
};
