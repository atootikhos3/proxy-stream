/**
 * StreamVault Multi-Provider Resolver Engine
 * Cloudflare Worker Service — Direct HLS/MP4 Extractor & Aggregator
 * Authored & Engineered for StreamVault
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json'
};

// Helper: Fetch with strict timeout so slow scrapers don't delay overall response
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
    const type = url.searchParams.get('type') || 'movie'; // 'movie' or 'tv'
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
                  // Route through StreamVault's CORS proxy to bypass 404/CORS restrictions
                  const proxiedUrl = `/proxy-stream?url=${encodeURIComponent(hlsSource.file)}`;
                  sources.push({
                    provider: 'XPass Direct HLS',
                    quality: '1080p HD (Direct HLS)',
                    url: proxiedUrl,
                    isEmbed: false // 🎯 PLAYS IN OUR CUSTOM PLAYER VIA PROXY!
                  });
                  return;
                }
              }
            }
          }
        }
      } catch (e) {}

      // Fallback to embed
      sources.push({
        provider: 'XPass Embed',
        quality: 'XPass Player',
        url: type === 'movie' ? `https://play.xpass.top/e/movie/${searchId}` : `https://play.xpass.top/e/tv/${searchId}/${season}/${episode}`,
        isEmbed: true
      });
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
                  url: playlistUrl,
                  isEmbed: false // 🎯 PLAYS DIRECTLY IN OUR CUSTOM PLAYER!
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
                isEmbed: false, // 🎯 PLAYS DIRECTLY IN OUR CUSTOM PLAYER!
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
              provider: 'Embed.su',
              quality: 'Direct HLS (1080p)',
              url: data.source,
              isEmbed: false // 🎯 PLAYS DIRECTLY IN OUR CUSTOM PLAYER!
            });
          }
        }
      } catch (e) {}
    };

    // ─── 5. Torrentio (Stremio Cached Torrents) ───
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

    // ─── 6. Stremify Direct Scraper ───
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

    // ─── 7. Nuvio Streams Scraper ───
    const getNuvio = async () => {
      if (!imdbId) return;
      try {
        const path = type === 'movie' ? `movie/${imdbId}.json` : `tv/${imdbId}:${season}:${episode}.json`;
        const res = await fetchWithTimeout(`https://nuviostreams.hayd.uk/stream/${path}`);
        if (res && res.ok) {
          const data = await res.json();
          if (data && data.streams) {
            data.streams.slice(0, 2).forEach((s, idx) => {
              if (s.url) {
                sources.push({
                  provider: 'Nuvio Streams',
                  quality: s.title || `Nuvio Stream ${idx + 1}`,
                  url: s.url,
                  isEmbed: false
                });
              }
            });
          }
        }
      } catch (e) {}
    };

    // ─── 8. VidSrc.cc (v2) ───
    const getVidSrcCc = async () => {
      if (!tmdbId && !imdbId) return;
      const id = tmdbId || imdbId;
      const embedUrl = type === 'movie'
        ? `https://vidsrc.cc/v2/embed/movie/${id}`
        : `https://vidsrc.cc/v2/embed/tv/${id}/${season}/${episode}`;
      sources.push({ provider: 'VidSrc.cc', quality: 'VidSrc v2 Pro HD', url: embedUrl, isEmbed: true });
    };

    // ─── 9. VidSrc.me ───
    const getVidSrcMe = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`
        : `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`;
      sources.push({ provider: 'VidSrc.me', quality: 'VidSrc Multi-Host', url: embedUrl, isEmbed: true });
    };

    // ─── 10. VidSrc.to ───
    const getVidSrcTo = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://vidsrc.to/embed/movie/${tmdbId}`
        : `https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}`;
      sources.push({ provider: 'VidSrc.to', quality: 'VidSrc Fast HD', url: embedUrl, isEmbed: true });
    };

    // ─── 11. SmashyStream ───
    const getSmashyStream = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://embed.smashystream.com/playere.php?tmdb=${tmdbId}`
        : `https://embed.smashystream.com/playere.php?tmdb=${tmdbId}&season=${season}&episode=${episode}`;
      sources.push({ provider: 'SmashyStream', quality: 'Smashy Multi-Server', url: embedUrl, isEmbed: true });
    };

    // ─── 12. 2Embed ───
    const get2Embed = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://www.2embed.cc/embed/${tmdbId}`
        : `https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}`;
      sources.push({ provider: '2Embed', quality: '2Embed Server', url: embedUrl, isEmbed: true });
    };

    // ─── 13. MultiEmbed ───
    const getMultiEmbed = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://multiembed.mov/directstream.php?video_id=${tmdbId}&tmdb=1`
        : `https://multiembed.mov/directstream.php?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}`;
      sources.push({ provider: 'MultiEmbed', quality: 'MultiEmbed Auto', url: embedUrl, isEmbed: true });
    };

    // ─── 14. RiveStream ───
    const getRiveStream = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://rive.stream/embed?type=movie&id=${tmdbId}`
        : `https://rive.stream/embed?type=tv&id=${tmdbId}&s=${season}&e=${episode}`;
      sources.push({ provider: 'RiveStream', quality: 'Rive HD', url: embedUrl, isEmbed: true });
    };

    // ─── 15. AutoEmbed ───
    const getAutoEmbed = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://autoembed.co/movie/tmdb/${tmdbId}`
        : `https://autoembed.co/tv/tmdb/${tmdbId}-${season}-${episode}`;
      sources.push({ provider: 'AutoEmbed', quality: 'AutoEmbed Mirror', url: embedUrl, isEmbed: true });
    };

    // ─── 16. NontonGo ───
    const getNontonGo = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://www.nontongo.win/embed/movie/${tmdbId}`
        : `https://www.nontongo.win/embed/tv/${tmdbId}/${season}/${episode}`;
      sources.push({ provider: 'NontonGo', quality: 'NontonGo Mirror', url: embedUrl, isEmbed: true });
    };

    // Execute all 16 scrapers simultaneously in parallel
    await Promise.allSettled([
      getXPass(),
      getVixSrc(),
      getVidLink(),
      getEmbedSu(),
      getTorrentio(),
      getStremify(),
      getNuvio(),
      getVidSrcCc(),
      getVidSrcMe(),
      getVidSrcTo(),
      getSmashyStream(),
      get2Embed(),
      getMultiEmbed(),
      getRiveStream(),
      getAutoEmbed(),
      getNontonGo()
    ]);

    // 🏆 HIGHEST QUALITY & DIRECT STREAM FIRST SORTING ALGORITHM
    function getQualityScore(qualityStr, isEmbed) {
      let score = 0;
      const q = (qualityStr || '').toLowerCase();
      
      if (q.includes('4k') || q.includes('2160') || q.includes('uhd')) score += 400;
      else if (q.includes('2k') || q.includes('1440')) score += 300;
      else if (q.includes('1080') || q.includes('fhd')) score += 200;
      else if (q.includes('720') || q.includes('hd')) score += 100;
      else score += 50;

      // 🎯 Direct streams (isEmbed: false) get +100 bonus points so they always beat external embed players!
      if (!isEmbed) score += 100;

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
