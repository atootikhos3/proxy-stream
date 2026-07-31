/**
 * StreamVault Multi-Provider Resolver & Edge Anti-Throttling Stream Proxy Engine
 * Cloudflare Worker Service — Full 16-Scraper Suite + Per-Chunk Identity Spoofing
 * Authored & Engineered for StreamVault
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json'
};

// Modern User-Agent Pool for rotating client fingerprints per chunk request
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
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

    // ─── 🛡️ ANTI-THROTTLING EDGE HLS PROXY (/hls-proxy?url=...&referer=...) ───
    if (url.pathname === '/hls-proxy') {
      const targetUrlStr = url.searchParams.get('url');
      const refererHeader = url.searchParams.get('referer') || 'https://player.videasy.to';

      if (!targetUrlStr) {
        return new Response('Missing target URL parameter', { status: 400 });
      }

      try {
        const targetUrl = new URL(targetUrlStr);

        // 🎯 PER-CHUNK FRESH IDENTITY SPOOFING:
        // Randomize User-Agent & strip tracking headers so CDN treats every chunk as a new burst connection!
        const reqHeaders = {
          'User-Agent': getRandomUserAgent(),
          'Referer': refererHeader,
          'Origin': new URL(refererHeader).origin,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site'
        };

        if (request.headers.get('range')) {
          reqHeaders['Range'] = request.headers.get('range');
        }

        const originResponse = await fetch(targetUrlStr, {
          method: request.method,
          headers: reqHeaders
        });

        const contentType = originResponse.headers.get('content-type') || '';
        const isM3u8 = targetUrl.pathname.endsWith('.m3u8') || contentType.includes('mpegurl') || contentType.includes('m3u8');

        if (isM3u8 && originResponse.ok) {
          let body = await originResponse.text();
          const baseUrl = targetUrl.origin + targetUrl.pathname.substring(0, targetUrl.pathname.lastIndexOf('/') + 1);

          // Rewrite m3u8 playlist lines so all chunks pass through proxy with fresh identities
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

            return `${url.origin}/hls-proxy?url=${encodeURIComponent(resolvedUrl)}&referer=${encodeURIComponent(refererHeader)}`;
          }).join('\n');

          return new Response(rewritten, {
            status: 200,
            headers: {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            }
          });
        }

        // Pipe binary video chunks (.ts / .mp4 / .m4s) with CORS & Anti-Cache Headers
        const responseHeaders = new Headers(originResponse.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Headers', '*');
        responseHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');

        return new Response(originResponse.body, {
          status: originResponse.status,
          headers: responseHeaders
        });

      } catch (err) {
        return new Response(`Worker Stream Proxy Error: ${err.message}`, { status: 502 });
      }
    }

    // ─── 🚀 MULTI-PROVIDER RESOLVER ENDPOINT ───
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

    // Auto-resolve IMDb ID if missing
    if (!imdbId && tmdbId) {
      try {
        const extRes = await fetchWithTimeout(`https://db.speedracelight.com/3/${type}/${tmdbId}/external_ids?language=en-US`, {}, 2000);
        if (extRes && extRes.ok) {
          const extData = await extRes.json();
          if (extData && extData.imdb_id) imdbId = extData.imdb_id;
        }
      } catch (e) {}
    }

    const sources = [];

    const makeProxyUrl = (targetUrl, referer) => {
      return `${url.origin}/hls-proxy?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(referer)}`;
    };

    // ─── 1. DIRECT: XPass / 1x2 Space ───
    const getXPass = async () => {
      const searchId = imdbId || tmdbId;
      if (!searchId) return;
      try {
        const embedUrl = type === 'movie'
          ? `https://play.xpass.top/e/movie/${searchId}`
          : `https://play.xpass.top/e/tv/${searchId}/${season}/${episode}`;

        const pageRes = await fetchWithTimeout(embedUrl, {
          headers: { 'User-Agent': getRandomUserAgent(), 'Referer': 'https://watch-v2.autoembed.app/' }
        });

        if (pageRes && pageRes.ok) {
          const html = await pageRes.text();
          const mdataMatch = html.match(/\/mdata\/([a-zA-Z0-9_-]+)\/1\/playlist\.json/);
          
          if (mdataMatch) {
            const mdataId = mdataMatch[1];
            const playlistRes = await fetchWithTimeout(`https://play.xpass.top/mdata/${mdataId}/1/playlist.json`, {
              headers: { 'User-Agent': getRandomUserAgent(), 'Referer': embedUrl }
            });

            if (playlistRes && playlistRes.ok) {
              const data = await playlistRes.json();
              if (data && data.playlist && data.playlist[0] && data.playlist[0].sources) {
                const hlsSource = data.playlist[0].sources.find(s => s.file && s.file.includes('.m3u8'));
                if (hlsSource) {
                  sources.push({
                    provider: 'XPass Direct HLS',
                    quality: '1080p HD (Direct HLS)',
                    url: makeProxyUrl(hlsSource.file, 'https://play.xpass.top/'),
                    isEmbed: false
                  });
                  return;
                }
              }
            }
          }
        }
      } catch (e) {}

      sources.push({
        provider: 'XPass',
        quality: 'XPass Player',
        url: type === 'movie' ? `https://play.xpass.top/e/movie/${searchId}` : `https://play.xpass.top/e/tv/${searchId}/${season}/${episode}`,
        isEmbed: true
      });
    };

    // ─── 2. DIRECT: VixSrc Direct HLS ───
    const getVixSrc = async () => {
      if (!tmdbId) return;
      try {
        const apiEndpoint = type === 'movie' 
          ? `https://vixsrc.to/api/movie/${tmdbId}`
          : `https://vixsrc.to/api/tv/${tmdbId}/${season}/${episode}`;

        const res = await fetchWithTimeout(apiEndpoint, {
          headers: { 'User-Agent': getRandomUserAgent(), 'Referer': `https://vixsrc.to/${type}/${tmdbId}` }
        });

        if (res && res.ok) {
          const data = await res.json();
          if (data && data.src) {
            const srcPath = data.src;
            const embedIdMatch = srcPath.match(/\/embed\/(\d+)/);
            if (embedIdMatch) {
              const embedId = embedIdMatch[1];
              const queryString = srcPath.includes('?') ? srcPath.split('?')[1] : '';
              const directHlsUrl = `https://vixsrc.to/playlist/${embedId}?type=video&rendition=1080p&${queryString}`;

              sources.push({
                provider: 'VixSrc Direct HLS',
                quality: 'VixCloud 1080p (Direct HLS)',
                url: makeProxyUrl(directHlsUrl, 'https://vixsrc.to/'),
                isEmbed: false
              });
              return;
            }

            sources.push({ provider: 'VixSrc', quality: 'VixCloud Player', url: `https://vixsrc.to${data.src}`, isEmbed: true });
          }
        }
      } catch (e) {}
    };

    // ─── 3. DIRECT: VidLink Direct MP4 + Subtitles ───
    const getVidLink = async () => {
      if (!tmdbId) return;
      try {
        const encPath = type === 'movie' ? `movie/${tmdbId}` : `tv/${tmdbId}/${season}/${episode}`;
        const res = await fetchWithTimeout(`https://vidlink.pro/api/b/${encPath}?multiLang=0`, {
          headers: { 'User-Agent': getRandomUserAgent(), 'Referer': `https://vidlink.pro/${encPath}` }
        });

        if (res && res.ok) {
          const data = await res.json();
          if (data && data.stream && data.stream.qualities) {
            const qualities = data.stream.qualities;
            const bestQuality = qualities['1080'] || qualities['720'] || qualities['480'] || qualities['360'];
            
            if (bestQuality && bestQuality.url) {
              const directUrl = `https://noir.suubmon.store/mp${new URL(bestQuality.url).pathname}${new URL(bestQuality.url).search}&headers=%7B%7D&host=https%3A%2F%2Fbcdn.hakunaymatata.com`;
              
              sources.push({
                provider: 'VidLink Direct MP4',
                quality: '1080p HD (Direct MP4)',
                url: makeProxyUrl(directUrl, 'https://vidlink.pro/'),
                isEmbed: false,
                subtitles: (data.stream.captions || []).map(c => ({ language: c.language, url: c.url }))
              });
              return;
            }
          }
        }
      } catch (e) {}

      sources.push({
        provider: 'VidLink',
        quality: 'VidLink Player HD',
        url: type === 'movie' ? `https://vidlink.pro/movie/${tmdbId}` : `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}`,
        isEmbed: true
      });
    };

    // ─── 4. DIRECT: Embed.su Direct HLS ───
    const getEmbedSu = async () => {
      if (!tmdbId) return;
      try {
        const path = type === 'movie' ? `movie/${tmdbId}` : `tv/${tmdbId}/${season}/${episode}`;
        const res = await fetchWithTimeout(`https://embed.su/api/e/${path}`, {
          headers: { 'Referer': 'https://embed.su' }
        });
        if (res && res.ok) {
          const data = await res.json();
          if (data && data.source) {
            sources.push({
              provider: 'Embed.su Direct HLS',
              quality: 'Direct HLS (1080p)',
              url: makeProxyUrl(data.source, 'https://embed.su/'),
              isEmbed: false
            });
          }
        }
      } catch (e) {}
    };

    // ─── 5. DIRECT: Torrentio (Stremio) ───
    const getTorrentio = async () => {
      if (!imdbId) return;
      try {
        const path = type === 'movie' ? `movie/${imdbId}.json` : `tv/${imdbId}:${season}:${episode}.json`;
        const res = await fetchWithTimeout(`https://torrentio.strem.fun/stream/${path}`);
        if (res && res.ok) {
          const data = await res.json();
          if (data && data.streams) {
            data.streams.slice(0, 3).forEach((s, idx) => {
              if (s.url) {
                sources.push({
                  provider: 'Torrentio',
                  quality: s.title ? s.title.split('\n')[0] : `Torrent Stream ${idx + 1}`,
                  url: s.url,
                  isEmbed: false
                });
              }
            });
          }
        }
      } catch (e) {}
    };

    // ─── 6. DIRECT: Stremify Scraper ───
    const getStremify = async () => {
      if (!imdbId) return;
      try {
        const path = type === 'movie' ? `movie/${imdbId}.json` : `tv/${imdbId}:${season}:${episode}.json`;
        const res = await fetchWithTimeout(`https://stremify.hayd.uk/stream/${path}`);
        if (res && res.ok) {
          const data = await res.json();
          if (data && data.streams) {
            data.streams.slice(0, 2).forEach((s, idx) => {
              if (s.url) {
                sources.push({
                  provider: 'Stremify Direct',
                  quality: s.title || `Stremify Stream ${idx + 1}`,
                  url: s.url,
                  isEmbed: false
                });
              }
            });
          }
        }
      } catch (e) {}
    };

    // ─── 7. DIRECT: 2Embed Direct Extractor ───
    const get2Embed = async () => {
      if (!tmdbId) return;
      try {
        const embedUrl = type === 'movie'
          ? `https://www.2embed.cc/embed/${tmdbId}`
          : `https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}`;

        const res = await fetchWithTimeout(embedUrl, {
          headers: { 'User-Agent': getRandomUserAgent(), 'Referer': 'https://www.2embed.cc/' }
        });

        if (res && res.ok) {
          const html = await res.text();
          const streamMatch = html.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/);
          if (streamMatch) {
            sources.push({
              provider: '2Embed Direct HLS',
              quality: '2Embed 1080p (Direct)',
              url: makeProxyUrl(streamMatch[1], 'https://www.2embed.cc/'),
              isEmbed: false
            });
            return;
          }
        }
      } catch (e) {}

      sources.push({ provider: '2Embed', quality: '2Embed Server', url: `https://www.2embed.cc/embed/${tmdbId}`, isEmbed: true });
    };

    // ─── 8. DIRECT: SmashyStream Direct Extractor ───
    const getSmashyStream = async () => {
      if (!tmdbId) return;
      try {
        const embedUrl = type === 'movie'
          ? `https://embed.smashystream.com/playere.php?tmdb=${tmdbId}`
          : `https://embed.smashystream.com/playere.php?tmdb=${tmdbId}&season=${season}&episode=${episode}`;

        const res = await fetchWithTimeout(embedUrl, {
          headers: { 'User-Agent': getRandomUserAgent(), 'Referer': 'https://smashystream.com/' }
        });

        if (res && res.ok) {
          const html = await res.text();
          const streamMatch = html.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/);
          if (streamMatch) {
            sources.push({
              provider: 'SmashyStream Direct HLS',
              quality: 'Smashy 1080p (Direct)',
              url: makeProxyUrl(streamMatch[1], 'https://embed.smashystream.com/'),
              isEmbed: false
            });
            return;
          }
        }
      } catch (e) {}

      sources.push({ provider: 'SmashyStream', quality: 'Smashy Multi-Server', url: `https://embed.smashystream.com/playere.php?tmdb=${tmdbId}`, isEmbed: true });
    };

    // ─── FALLBACK EMBED SCRAPERS ───
    const getVidSrcCc = async () => {
      const id = tmdbId || imdbId;
      if (!id) return;
      sources.push({ provider: 'VidSrc.cc', quality: 'VidSrc v2 Pro HD', url: `https://vidsrc.cc/v2/embed/${type}/${id}`, isEmbed: true });
    };

    const getVidSrcMe = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'VidSrc.me', quality: 'VidSrc Multi-Host', url: `https://vidsrc.me/embed/${type}?tmdb=${tmdbId}`, isEmbed: true });
    };

    const getVidSrcTo = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'VidSrc.to', quality: 'VidSrc Fast HD', url: `https://vidsrc.to/embed/${type}/${tmdbId}`, isEmbed: true });
    };

    const getMultiEmbed = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'MultiEmbed', quality: 'MultiEmbed Auto', url: `https://multiembed.mov/directstream.php?video_id=${tmdbId}&tmdb=1`, isEmbed: true });
    };

    const getRiveStream = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'RiveStream', quality: 'Rive HD', url: `https://rive.stream/embed?type=${type}&id=${tmdbId}`, isEmbed: true });
    };

    const getAutoEmbed = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'AutoEmbed', quality: 'AutoEmbed Mirror', url: `https://autoembed.co/${type}/tmdb/${tmdbId}`, isEmbed: true });
    };

    const getNontonGo = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'NontonGo', quality: 'NontonGo Mirror', url: `https://www.nontongo.win/embed/${type}/${tmdbId}`, isEmbed: true });
    };

    // 🎯 EXECUTE ALL SCRAPERS IN PARALLEL!
    await Promise.allSettled([
      getXPass(),
      getVixSrc(),
      getVidLink(),
      getEmbedSu(),
      getTorrentio(),
      getStremify(),
      get2Embed(),
      getSmashyStream(),
      getVidSrcCc(),
      getVidSrcMe(),
      getVidSrcTo(),
      getMultiEmbed(),
      getRiveStream(),
      getAutoEmbed(),
      getNontonGo()
    ]);

    // 🏆 HIGHEST QUALITY SORTING
    function getQualityScore(qualityStr, isEmbed) {
      let score = 0;
      const q = (qualityStr || '').toLowerCase();
      if (q.includes('4k') || q.includes('2160') || q.includes('uhd')) score += 400;
      else if (q.includes('2k') || q.includes('1440')) score += 300;
      else if (q.includes('1080') || q.includes('fhd')) score += 200;
      else if (q.includes('720') || q.includes('hd')) score += 100;
      else score += 50;

      if (!isEmbed) score += 500; // Direct streams beat embeds every time!
      return score;
    }

    sources.sort((a, b) => getQualityScore(b.quality, b.isEmbed) - getQualityScore(a.quality, a.isEmbed));

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
