/**
 * StreamVault Multi-Provider Resolver Engine
 * Cloudflare Worker Service
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json'
};

// Helper: Fetch with a strict timeout so slow providers don't block response
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

    // ─── Provider 1: Torrentio (Direct Stream / Magnets) ───
    const getTorrentio = async () => {
      if (!imdbId) return;
      const path = type === 'movie' ? `movie/${imdbId}.json` : `tv/${imdbId}:${season}:${episode}.json`;
      const res = await fetchWithTimeout(`https://torrentio.strem.fun/stream/${path}`);
      if (res && res.ok) {
        const data = await res.json();
        if (data.streams) {
          data.streams.slice(0, 4).forEach((s, idx) => {
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
    };

    // ─── Provider 2: Embed.su (Direct HLS Extraction) ───
    const getEmbedSu = async () => {
      if (!tmdbId) return;
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
    };

    // ─── Provider 3: VidLink Pro ───
    const getVidLink = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://vidlink.pro/movie/${tmdbId}`
        : `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}`;
      sources.push({
        provider: 'VidLink',
        quality: 'VidLink Player HD',
        url: embedUrl,
        isEmbed: true
      });
    };

    // ─── Provider 4: VidSrc.me ───
    const getVidSrcMe = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`
        : `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`;
      sources.push({
        provider: 'VidSrc.me',
        quality: 'VidSrc Multi-Host',
        url: embedUrl,
        isEmbed: true
      });
    };

    // ─── Provider 5: VidSrc.to ───
    const getVidSrcTo = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://vidsrc.to/embed/movie/${tmdbId}`
        : `https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}`;
      sources.push({
        provider: 'VidSrc.to',
        quality: 'VidSrc Pro HD',
        url: embedUrl,
        isEmbed: true
      });
    };

    // ─── Provider 6: 2Embed ───
    const get2Embed = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://www.2embed.cc/embed/${tmdbId}`
        : `https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}`;
      sources.push({
        provider: '2Embed',
        quality: '2Embed Server',
        url: embedUrl,
        isEmbed: true
      });
    };

    // ─── Provider 7: MultiEmbed ───
    const getMultiEmbed = async () => {
      if (!tmdbId) return;
      const embedUrl = type === 'movie'
        ? `https://multiembed.mov/directstream.php?video_id=${tmdbId}&tmdb=1`
        : `https://multiembed.mov/directstream.php?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}`;
      sources.push({
        provider: 'MultiEmbed',
        quality: 'MultiEmbed Auto',
        url: embedUrl,
        isEmbed: true
      });
    };

    // Execute all providers in parallel
    await Promise.allSettled([
      getTorrentio(),
      getEmbedSu(),
      getVidLink(),
      getVidSrcMe(),
      getVidSrcTo(),
      get2Embed(),
      getMultiEmbed()
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
