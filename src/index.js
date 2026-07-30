/**
 * StreamVault Multi-Provider Resolver & Edge Stream Proxy Engine
 * Authored & Engineered for StreamVault — 100% Direct Native Stream Player
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json'
};

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

    // ─── 🛡️ EDGE HLS PROXY ENDPOINT (/hls-proxy?url=...&referer=...) ───
    if (url.pathname === '/hls-proxy') {
      const targetUrlStr = url.searchParams.get('url');
      const refererHeader = url.searchParams.get('referer') || 'https://player.videasy.to';

      if (!targetUrlStr) {
        return new Response('Missing target URL parameter', { status: 400 });
      }

      try {
        const targetUrl = new URL(targetUrlStr);
        const reqHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
          'Referer': refererHeader,
          'Origin': new URL(refererHeader).origin,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache'
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

          // Rewrite m3u8 playlist lines so all chunks pass through worker proxy
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
              'Cache-Control': 'no-cache'
            }
          });
        }

        // Pipe binary video chunks (.ts / .mp4 / .m4s) with CORS headers
        const responseHeaders = new Headers(originResponse.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Headers', '*');

        return new Response(originResponse.body, {
          status: originResponse.status,
          headers: responseHeaders
        });

      } catch (err) {
        return new Response(`Worker Stream Proxy Error: ${err.message}`, { status: 502 });
      }
    }

    // ─── 🚀 MULTI-PROVIDER RESOLVER ENDPOINT (/?id=...&imdbId=...) ───
    const tmdbId = url.searchParams.get('id');
    const imdbId = url.searchParams.get('imdbId') || '';
    const type = url.searchParams.get('type') || 'movie';
    const season = url.searchParams.get('season') || '1';
    const episode = url.searchParams.get('episode') || '1';

    if (!tmdbId && !imdbId) {
      return new Response(
        JSON.stringify({ error: 'Missing TMDB ID or IMDb ID parameter' }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const sources = [];

    // Helper: Format URL through Cloudflare Worker's Edge Proxy
    const makeProxyUrl = (targetUrl, referer) => {
      return `${url.origin}/hls-proxy?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(referer)}`;
    };

    // ─── 1. XPass / 1x2 Space (Direct m3u8 Extractor) ───
    const getXPass = async () => {
      const searchId = imdbId || tmdbId;
      if (!searchId) return;
      try {
        const embedUrl = type === 'movie'
          ? `https://play.xpass.top/e/movie/${searchId}`
          : `https://play.xpass.top/e/tv/${searchId}/${season}/${episode}`;

        const pageRes = await fetchWithTimeout(embedUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': 'https://watch-v2.autoembed.app/'
          }
        });

        if (pageRes && pageRes.ok) {
          const html = await pageRes.text();
          const mdataMatch = html.match(/\/mdata\/([a-zA-Z0-9_-]+)\/1\/playlist\.json/);
          
          if (mdataMatch) {
            const mdataId = mdataMatch[1];
            const playlistRes = await fetchWithTimeout(`https://play.xpass.top/mdata/${mdataId}/1/playlist.json`, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': embedUrl
              }
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
                    isEmbed: false // 🎯 100% NATIVE PLAYER!
                  });
                  return;
                }
              }
            }
          }
        }
      } catch (e) {}
    };

    // ─── 2. VixSrc Direct HLS Extractor ───
    const getVixSrc = async () => {
      if (!tmdbId) return;
      try {
        const apiEndpoint = type === 'movie' 
          ? `https://vixsrc.to/api/movie/${tmdbId}`
          : `https://vixsrc.to/api/tv/${tmdbId}/${season}/${episode}`;

        const res = await fetchWithTimeout(apiEndpoint, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': `https://vixsrc.to/${type}/${tmdbId}`
          }
        });

        if (res && res.ok) {
          const data = await res.json();
          if (data && data.src) {
            const embedPage = `https://vixsrc.to${data.src}`;
            const embedRes = await fetchWithTimeout(embedPage, {
              headers: { 'Referer': `https://vixsrc.to/${type}/${tmdbId}` }
            });

            if (embedRes && embedRes.ok) {
              const embedHtml = await embedRes.text();
              const playlistMatch = embedHtml.match(/playlist\/(\d+)\?type=video[^"']*/);
              if (playlistMatch) {
                const playlistUrl = `https://vixsrc.to/${playlistMatch[0]}`;
                sources.push({
                  provider: 'VixSrc Direct HLS',
                  quality: 'VixCloud 1080p (Direct HLS)',
                  url: makeProxyUrl(playlistUrl, 'https://vixsrc.to/'),
                  isEmbed: false // 🎯 100% NATIVE PLAYER!
                });
                return;
              }
            }
          }
        }
      } catch (e) {}
    };

    // ─── 3. VidLink Direct MP4 + Subtitles ───
    const getVidLink = async () => {
      if (!tmdbId) return;
      try {
        const encPath = type === 'movie' ? `movie/${tmdbId}` : `tv/${tmdbId}/${season}/${episode}`;
        const res = await fetchWithTimeout(`https://vidlink.pro/api/b/${encPath}?multiLang=0`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': `https://vidlink.pro/${encPath}`
          }
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
                isEmbed: false, // 🎯 100% NATIVE PLAYER!
                subtitles: (data.stream.captions || []).map(c => ({
                  language: c.language,
                  url: c.url
                }))
              });
              return;
            }
          }
        }
      } catch (e) {}
    };

    // ─── 4. Embed.su Direct HLS Extractor ───
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
              isEmbed: false // 🎯 100% NATIVE PLAYER!
            });
          }
        }
      } catch (e) {}
    };

    // ─── 5. Torrentio Cached Stream ───
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
                  isEmbed: false // 🎯 100% NATIVE PLAYER!
                });
              }
            });
          }
        }
      } catch (e) {}
    };

    // Execute direct stream scrapers in parallel
    await Promise.allSettled([
      getXPass(),
      getVixSrc(),
      getVidLink(),
      getEmbedSu(),
      getTorrentio()
    ]);

    // Ensure all direct stream sources have isEmbed: false
    sources.forEach(src => {
      src.isEmbed = false;
    });

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
