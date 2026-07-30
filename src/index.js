/**
 * StreamVault Multi-Provider Resolver Engine
 * Cloudflare Worker Service — Featuring VixSrc & XPass/1x2.Space Direct HLS
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

    // ─── 1. NEW: VixSrc API (Ultra-Fast Direct HLS) ───
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
            const embedUrl = `https://vixsrc.to${data.src}`;
            sources.push({
              provider: 'VixSrc Direct HLS',
              quality: 'VixCloud 1080p (Fastest)',
              url: embedUrl,
              isEmbed: true
            });
          }
        }
      } catch (e) {}
    };

    // ─── 2. NEW: XPass / 1x2.Space API (Direct master.m3u8) ───
    const getXPass = async () => {
      const searchId = imdbId || tmdbId;
      if (!searchId) return;
      try {
        const embedPageUrl = type === 'movie'
          ? `https://play.xpass.top/e/movie/${searchId}`
          : `https://play.xpass.top/e/tv/${searchId}/${season}/${episode}`;

        sources.push({
          provider: 'XPass / 1x2 Space',
          quality: 'TIK Master HLS (1080p)',
          url: embedPageUrl,
          isEmbed: true
        });
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
              isEmbed: false
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

    // ─── 6. VidSrc.me ───
    const getVidSrcMe = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`
        : `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`;
      sources.push({ provider: 'VidSrc.me', quality: 'VidSrc Multi-Host', url: embedUrl, isEmbed: true });
    };

    // ─── 7. VidSrc.to ───
    const getVidSrcTo = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://vidsrc.to/embed/movie/${tmdbId}`
        : `https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}`;
      sources.push({ provider: 'VidSrc.to', quality: 'VidSrc Pro HD', url: embedUrl, isEmbed: true });
    };

    // Execute all scrapers concurrently
    await Promise.allSettled([
      getVixSrc(),
      getXPass(),
      getVidLink(),
      getEmbedSu(),
      getTorrentio(),
      getVidSrcMe(),
      getVidSrcTo()
    ]);

    return new Response(
      JSON.stringify({
        tmdbId,
        imdbId,
        type,
        sourcesCount: sources.length,
        sources
      }),
      { status: 200, headers: CORS_HEADERS }
    );
  }
};
