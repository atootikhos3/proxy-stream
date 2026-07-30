/**
 * StreamVault Multi-Provider Resolver Engine
 * Universal CORS Proxy-Wrapped Stream Aggregator
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

    // ─── 1. XPass / 1x2 Space ───
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
                    url: hlsSource.file,
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
        provider: 'XPass Embed',
        quality: 'XPass Player',
        url: type === 'movie' ? `https://play.xpass.top/e/movie/${searchId}` : `https://play.xpass.top/e/tv/${searchId}/${season}/${episode}`,
        isEmbed: true
      });
    };

    // ─── 2. VixSrc Direct HLS ───
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
                  url: playlistUrl,
                  isEmbed: false
                });
                return;
              }
            }

            sources.push({ provider: 'VixSrc', quality: 'VixCloud Player', url: embedPage, isEmbed: true });
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
                url: directUrl,
                isEmbed: false,
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

      sources.push({
        provider: 'VidLink',
        quality: 'VidLink Player HD',
        url: type === 'movie' ? `https://vidlink.pro/movie/${tmdbId}` : `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}`,
        isEmbed: true
      });
    };

    // ─── 4. Embed.su Direct HLS ───
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
              provider: 'Embed.su',
              quality: 'Direct HLS (1080p)',
              url: data.source,
              isEmbed: false
            });
          }
        }
      } catch (e) {}
    };

    // ─── 5. Torrentio (Stremio) ───
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

    // ─── Fallback Embed Scrapers ───
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

    const getSmashyStream = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'SmashyStream', quality: 'Smashy Multi-Server', url: `https://embed.smashystream.com/playere.php?tmdb=${tmdbId}`, isEmbed: true });
    };

    const get2Embed = async () => {
      if (!tmdbId) return;
      sources.push({ provider: '2Embed', quality: '2Embed Server', url: `https://www.2embed.cc/embed/${tmdbId}`, isEmbed: true });
    };

    const getMultiEmbed = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'MultiEmbed', quality: 'MultiEmbed Auto', url: `https://multiembed.mov/directstream.php?video_id=${tmdbId}&tmdb=1`, isEmbed: true });
    };

    // Execute all scrapers concurrently
    await Promise.allSettled([
      getXPass(),
      getVixSrc(),
      getVidLink(),
      getEmbedSu(),
      getTorrentio(),
      getVidSrcCc(),
      getVidSrcMe(),
      getVidSrcTo(),
      getSmashyStream(),
      get2Embed(),
      getMultiEmbed()
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

      if (!isEmbed) score += 100; // Direct streams beat embeds!
      return score;
    }

    sources.sort((a, b) => getQualityScore(b.quality, b.isEmbed) - getQualityScore(a.quality, a.isEmbed));

// ─── Universal Stream Proxy: /proxy-stream?url=... ───
    if (req.url.startsWith('/proxy-stream')) {
        const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
        const targetUrlStr = reqUrl.searchParams.get('url');

        if (!targetUrlStr) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing url parameter');
            return;
        }

        let targetUrl;
        try {
            targetUrl = new URL(targetUrlStr);
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid target URL');
            return;
        }

        // Determine spoofed referer/origin based on domain
        let activeOrigin = 'https://player.videasy.to';
        if (targetUrl.hostname.includes('1x2.space') || targetUrl.hostname.includes('xpass')) {
            activeOrigin = 'https://play.xpass.top';
        } else if (targetUrl.hostname.includes('vix') || targetUrl.hostname.includes('vixcloud')) {
            activeOrigin = 'https://vixsrc.to';
        } else if (targetUrl.hostname.includes('vidlink') || targetUrl.hostname.includes('suubmon') || targetUrl.hostname.includes('hakunaymatata')) {
            activeOrigin = 'https://vidlink.pro';
        }

        const client = targetUrl.protocol === 'https:' ? https : http;
        const reqHeaders = {
            'Host': targetUrl.hostname,
            'Origin': activeOrigin,
            'Referer': activeOrigin + '/',
            'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'identity'
        };

        if (req.headers['range']) {
            reqHeaders['Range'] = req.headers['range'];
        }

        const options = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname + targetUrl.search,
            method: req.method,
            headers: reqHeaders,
        };

        const proxy = client.request(options, (streamRes) => {
            const contentType = streamRes.headers['content-type'] || '';
            const isM3u8 = targetUrl.pathname.endsWith('.m3u8') || contentType.includes('mpegurl') || contentType.includes('m3u8');

            if (isM3u8 && streamRes.statusCode === 200) {
                // Buffer m3u8 playlist and rewrite chunk URLs through /proxy-stream
                let body = '';
                streamRes.setEncoding('utf8');
                streamRes.on('data', chunk => body += chunk);
                streamRes.on('end', () => {
                    const baseUrl = targetUrl.origin + targetUrl.pathname.substring(0, targetUrl.pathname.lastIndexOf('/') + 1);

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

                        return `/proxy-stream?url=${encodeURIComponent(resolvedUrl)}`;
                    }).join('\n');

                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-cache',
                    });
                    res.end(rewritten);
                });
            } else {
                // Pipe binary video chunks (.ts / .mp4 / .m4s) directly to player
                const outHeaders = {
                    'Content-Type': contentType || 'video/MP2T',
                    'Access-Control-Allow-Origin': '*',
                    'Accept-Ranges': streamRes.headers['accept-ranges'] || 'bytes',
                };
                if (streamRes.headers['content-length']) outHeaders['Content-Length'] = streamRes.headers['content-length'];
                if (streamRes.headers['content-range']) outHeaders['Content-Range'] = streamRes.headers['content-range'];

                res.writeHead(streamRes.statusCode, outHeaders);
                streamRes.pipe(res);
            }
        });

        proxy.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Proxy error: ' + err.message);
        });

        req.pipe(proxy);
        return;
    }
