/**
 * StreamVault Multi-Provider Resolver Engine
 * Cloudflare Worker Service — Direct Stream & Embed Aggregator
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

    // ─── 1. VidLink Direct MP4 + Subtitles (Native Player - 0 Ads) ───
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

    // ─── 2. Embed.su Direct HLS (Native Player - 0 Ads) ───
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

    // ─── 3. Torrentio Cached Stream (Native Player) ───
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

    // ─── 4. XPass Embed ───
    const getXPass = async () => {
      const searchId = imdbId || tmdbId;
      if (!searchId) return;
      const embedUrl = type === 'movie'
        ? `https://play.xpass.top/e/movie/${searchId}`
        : `https://play.xpass.top/e/tv/${searchId}/${season}/${episode}`;
      sources.push({ provider: 'XPass', quality: 'TIK Player HD', url: embedUrl, isEmbed: true });
    };

    // ─── 5. VixSrc Embed ───
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
            sources.push({
              provider: 'VixSrc',
              quality: 'VixCloud Player',
              url: `https://vixsrc.to${data.src}`,
              isEmbed: true
            });
          }
        }
      } catch (e) {}
    };

    // ─── 6. VidSrc.cc (v2) ───
    const getVidSrcCc = async () => {
      const id = tmdbId || imdbId;
      if (!id) return;
      sources.push({ provider: 'VidSrc.cc', quality: 'VidSrc v2 Pro HD', url: `https://vidsrc.cc/v2/embed/${type}/${id}`, isEmbed: true });
    };

    // ─── 7. VidSrc.to ───
    const getVidSrcTo = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'VidSrc.to', quality: 'VidSrc Fast HD', url: `https://vidsrc.to/embed/${type}/${tmdbId}`, isEmbed: true });
    };

    // ─── 8. VidSrc.me ───
    const getVidSrcMe = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'VidSrc.me', quality: 'VidSrc Multi-Host', url: `https://vidsrc.me/embed/${type}?tmdb=${tmdbId}`, isEmbed: true });
    };

    // ─── 9. SmashyStream ───
    const getSmashyStream = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'SmashyStream', quality: 'Smashy Multi-Server', url: `https://embed.smashystream.com/playere.php?tmdb=${tmdbId}`, isEmbed: true });
    };

    // ─── 10. 2Embed ───
    const get2Embed = async () => {
      if (!tmdbId) return;
      sources.push({ provider: '2Embed', quality: '2Embed Server', url: `https://www.2embed.cc/embed/${tmdbId}`, isEmbed: true });
    };

    // ─── 11. MultiEmbed ───
    const getMultiEmbed = async () => {
      if (!tmdbId) return;
      sources.push({ provider: 'MultiEmbed', quality: 'MultiEmbed Auto', url: `https://multiembed.mov/directstream.php?video_id=${tmdbId}&tmdb=1`, isEmbed: true });
    };

    // Execute all scrapers in parallel
    await Promise.allSettled([
      getVidLink(),
      getEmbedSu(),
      getTorrentio(),
      getXPass(),
      getVixSrc(),
      getVidSrcCc(),
      getVidSrcTo(),
      getVidSrcMe(),
      getSmashyStream(),
      get2Embed(),
      getMultiEmbed()
    ]);

    // 🏆 SORTING: Direct Streams First, then High Quality
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
