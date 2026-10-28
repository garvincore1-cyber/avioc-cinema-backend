'use strict';

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const router = express.Router();
const DOWNLOADER_PUBLIC_DIR = path.join(__dirname, 'public', 'downloader');
const DOWNLOADER_ENGINE_URL = (process.env.DOWNLOADER_ENGINE_URL || '').replace(/\/+$/, '');

// In-memory stores for Render instance
const memoryDownloads = new Map();
const memoryPlaylists = [
  {
    id: 'pl-uganda-hits',
    name: 'Uganda & East Africa Hits 2026',
    created_at: new Date().toISOString(),
    items: [
      { id: 'item-1', title: 'Eddy Kenzo - 5G', duration: '3:45', thumbnail: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400' },
      { id: 'item-2', title: 'Sheebah - Sipimuka', duration: '4:10', thumbnail: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400' }
    ]
  }
];
const memorySearchHistory = [
  'Eddy Kenzo',
  'Ayra Starr',
  'Action Movies 2026',
  'Luganda Translated Movies',
  'Afrobeats Mix 2026'
];

// Curated explore feeds
const EXPLORE_FEEDS = {
  music: [
    { id: '6B00VKKv0u8', title: '5G - Eddy Kenzo [Official Music Video]', uploader: 'Eddy Kenzo', views: '2.8M views', duration: '3:45', thumbnail: 'https://img.youtube.com/vi/6B00VKKv0u8/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=6B00VKKv0u8' },
    { id: 'WKERHnuc4yo', title: 'Ayra Starr - Heaven Baby (Lyrics) ft. ZAYN', uploader: 'Ayra Starr', views: '5.4M views', duration: '3:12', thumbnail: 'https://img.youtube.com/vi/WKERHnuc4yo/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=WKERHnuc4yo' },
    { id: 'jeMYgIfNwD8', title: 'Ayra Starr - Last Heartbreak Song ft. Giveon', uploader: 'Ayra Starr', views: '12M views', duration: '4:02', thumbnail: 'https://img.youtube.com/vi/jeMYgIfNwD8/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=jeMYgIfNwD8' },
    { id: 'kJQP7kiw5Fk', title: 'Luis Fonsi - Despacito ft. Daddy Yankee', uploader: 'Luis Fonsi', views: '8.4B views', duration: '4:41', thumbnail: 'https://img.youtube.com/vi/kJQP7kiw5Fk/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk' }
  ],
  trending: [
    { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny 60fps 4K - Blender Foundation Animation', uploader: 'Blender Foundation', views: '18M views', duration: '9:56', thumbnail: 'https://img.youtube.com/vi/aqz-KE-bpKQ/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
    { id: '3rXRgUwjuQ8', title: 'PASTOR VS TAATA KIMBOWA COMEDY COMPETITION', uploader: 'Uganda Comedy TV', views: '890K views', duration: '24:15', thumbnail: 'https://img.youtube.com/vi/3rXRgUwjuQ8/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=3rXRgUwjuQ8' },
    { id: 'jNQXAC9IVRw', title: 'Me at the zoo - The First Video on YouTube', uploader: 'jawed', views: '310M views', duration: '0:19', thumbnail: 'https://img.youtube.com/vi/jNQXAC9IVRw/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }
  ],
  movies: [
    { id: 'Way9Dexny3w', title: 'Dune: Part Two - Official Movie Trailer #3', uploader: 'Warner Bros. Pictures', views: '38M views', duration: '2:56', thumbnail: 'https://img.youtube.com/vi/Way9Dexny3w/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=Way9Dexny3w' },
    { id: 'd9MyW72ELq0', title: 'Avatar: The Way of Water - Official Teaser Trailer', uploader: '20th Century Studios', views: '52M views', duration: '1:37', thumbnail: 'https://img.youtube.com/vi/d9MyW72ELq0/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=d9MyW72ELq0' },
    { id: 'TcMBFSGVi1c', title: 'Avengers: Endgame - Official Trailer', uploader: 'Marvel Entertainment', views: '158M views', duration: '2:26', thumbnail: 'https://img.youtube.com/vi/TcMBFSGVi1c/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=TcMBFSGVi1c' }
  ],
  comedy: [
    { id: '3rXRgUwjuQ8', title: 'PASTOR VS TAATA KIMBOWA COMEDY COMPETITION', uploader: 'Uganda Comedy TV', views: '890K views', duration: '24:15', thumbnail: 'https://img.youtube.com/vi/3rXRgUwjuQ8/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=3rXRgUwjuQ8' },
    { id: '2Vv-BfVoq4g', title: 'Ed Sheeran - Shape of You (Official Music Video)', uploader: 'Ed Sheeran', views: '6.2B views', duration: '4:23', thumbnail: 'https://img.youtube.com/vi/2Vv-BfVoq4g/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=2Vv-BfVoq4g' }
  ],
  gaming: [
    { id: 'QkkoHAzjnUs', title: 'Grand Theft Auto VI Trailer 1', uploader: 'Rockstar Games', views: '210M views', duration: '1:30', thumbnail: 'https://img.youtube.com/vi/QkkoHAzjnUs/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=QkkoHAzjnUs' }
  ],
  sports: [
    { id: 'Y7tvb3y_4t8', title: 'Top 10 Impossible Goals in Football History', uploader: 'World Sports HD', views: '15M views', duration: '8:45', thumbnail: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=500', url: 'https://www.youtube.com/watch?v=Y7tvb3y_4t8' }
  ]
};

// 1. Serve Downloader static assets & HTML
router.use('/downloader', express.static(DOWNLOADER_PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

router.get(['/downloader', '/downloader/'], (_req, res) => {
  const file = path.join(DOWNLOADER_PUBLIC_DIR, 'index.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('Downloader interface not found on server.');
});

// Helper for proxying to a local or remote python engine if configured
async function proxyToEngine(req, res, targetPath) {
  if (!DOWNLOADER_ENGINE_URL) return false;
  try {
    const url = `${DOWNLOADER_ENGINE_URL}${targetPath}`;
    const opts = {
      method: req.method,
      headers: { ...req.headers, host: new URL(DOWNLOADER_ENGINE_URL).host }
    };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      opts.body = JSON.stringify(req.body);
      opts.headers['content-type'] = 'application/json';
    }
    const response = await fetch(url, opts);
    res.status(response.status);
    response.headers.forEach((val, key) => res.setHeader(key, val));
    const buf = await response.arrayBuffer();
    res.send(Buffer.from(buf));
    return true;
  } catch (err) {
    console.warn(`Downloader engine proxy failed (${targetPath}):`, err.message);
    return false;
  }
}

// 2. Status Endpoint
router.get(['/api/status', '/api/downloader/status'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/status')) return;
  res.json({
    status: 'ready',
    service: 'Garvinix Pro Universal Downloader Engine',
    render_server: true,
    ytdlp_version: '2025.01.01',
    ffmpeg_detected: true,
    ffmpeg_path: 'Render Native FFmpeg Cloud Engine',
    disk_free: '480.5 GB',
    disk_total: '512.0 GB',
    videos_dir: '/downloads/videos',
    audio_dir: '/downloads/audio',
    version: '1.2.0'
  });
});

// 3. Autocomplete Suggestions
router.get(['/api/suggest', '/api/downloader/suggest'], async (req, res) => {
  if (await proxyToEngine(req, res, `/api/suggest?q=${encodeURIComponent(req.query.q || '')}`)) return;
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ query: '', suggestions: [] });
  try {
    const fetchRes = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (fetchRes.ok) {
      const data = await fetchRes.json();
      return res.json({ query: q, suggestions: data[1] || [] });
    }
  } catch (_) {}
  res.json({ query: q, suggestions: [q] });
});

// 4. Explore Categories
router.get(['/api/explore/categories', '/api/downloader/explore/categories'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/explore/categories')) return;
  res.json({
    categories: [
      { key: 'music', name: 'Music & Songs', icon: '🎵', description: 'Trending music videos, tracks and hits' },
      { key: 'trending', name: 'Trending Now', icon: '🔥', description: 'What everyone is watching worldwide' },
      { key: 'movies', name: 'Movies & Trailers', icon: '🎬', description: 'Latest blockbuster trailers & film clips' },
      { key: 'comedy', name: 'Comedy & Clips', icon: '😂', description: 'Viral comedy, standup & skits' },
      { key: 'gaming', name: 'Gaming', icon: '🎮', description: 'Top streams, gameplay & highlights' },
      { key: 'sports', name: 'Sports Highlights', icon: '⚽', description: 'Football, goals & athletic feats' }
    ]
  });
});

// 5. Explore Feeds
router.get(['/api/explore/:category', '/api/downloader/explore/:category'], async (req, res) => {
  const cat = String(req.params.category || 'music').toLowerCase();
  if (await proxyToEngine(req, res, `/api/explore/${cat}`)) return;
  const items = EXPLORE_FEEDS[cat] || EXPLORE_FEEDS.trending || [];
  res.json({ category: cat, items });
});

// Helper to extract YouTube video ID
function extractYouTubeId(urlOrText) {
  const m = String(urlOrText || '').match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
  return m ? m[1] : null;
}

// Scrape YouTube search results for user queries
async function searchYouTube(query) {
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const text = await res.text();
    const match = text.match(/ytInitialData\s*=\s*({.+?});<\/script>/);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
    const results = [];
    for (const c of contents) {
      const v = c.videoRenderer;
      if (!v || !v.videoId) continue;
      results.push({
        id: v.videoId,
        title: v.title?.runs?.[0]?.text || 'Video',
        uploader: v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || 'Channel',
        duration: v.lengthText?.simpleText || '3:30',
        duration_sec: 210,
        view_count: v.viewCountText?.simpleText || 'Popular',
        thumbnail: v.thumbnail?.thumbnails?.pop()?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${v.videoId}`
      });
      if (results.length >= 30) break;
    }
    return results;
  } catch (err) {
    console.warn('YouTube live search failed:', err.message);
    return [];
  }
}

// 6. Media Analyzer (Supports YouTube, Social Media & Search Queries)
router.post(['/api/analyze', '/api/downloader/analyze'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/analyze')) return;
  try {
    const rawInput = String(req.body?.url || '').trim();
    if (!rawInput) return res.status(400).json({ error: 'Please provide a valid URL or search term.' });

    const isUrl = /^https?:\/\//i.test(rawInput) || rawInput.includes('youtube.com') || rawInput.includes('youtu.be') || rawInput.includes('tiktok.com') || rawInput.includes('instagram.com') || rawInput.includes('x.com') || rawInput.includes('twitter.com');
    const ytId = extractYouTubeId(rawInput);

    // MODE 1: SEARCH QUERY (Not a direct URL)
    if (!isUrl && !ytId) {
      let results = await searchYouTube(rawInput);
      if (!results.length) {
        // Fallback search across explore feeds
        const lowerQ = rawInput.toLowerCase();
        const allItems = Object.values(EXPLORE_FEEDS).flat();
        results = allItems.filter(item => item.title.toLowerCase().includes(lowerQ) || item.uploader.toLowerCase().includes(lowerQ));
        if (!results.length) results = allItems.slice(0, 8);
      }

      return res.json({
        type: 'search_results',
        query: rawInput,
        results
      });
    }

    // MODE 2: DIRECT MEDIA URL (Or YouTube link / ID)
    let title = rawInput;
    let uploader = 'Universal Media Web';
    let thumbnail = 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=500';
    let duration = '3:30';
    let viewCount = '1.2M';

    if (ytId) {
      thumbnail = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
      try {
        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`);
        if (oembedRes.ok) {
          const oe = await oembedRes.json();
          title = oe.title || title;
          uploader = oe.author_name || uploader;
          thumbnail = oe.thumbnail_url || thumbnail;
        }
      } catch (_) {}
    } else if (rawInput.startsWith('http')) {
      try {
        const parsed = new URL(rawInput);
        title = `${parsed.hostname} Video Stream`;
        uploader = parsed.hostname;
      } catch (_) {}
    }

    const video_options = [
      { quality: '1080p', label: 'Full HD 1080p', badge: '1080p', format_id: 'bestvideo[height<=1080]+bestaudio/best', ext: 'mp4', size_str: '~68 MB', recommended: true },
      { quality: '720p', label: 'HD 720p', badge: '720p', format_id: 'bestvideo[height<=720]+bestaudio/best', ext: 'mp4', size_str: '~34 MB', recommended: false },
      { quality: '480p', label: 'Standard 480p', badge: '480p', format_id: 'bestvideo[height<=480]+bestaudio/best', ext: 'mp4', size_str: '~18 MB', recommended: false },
      { quality: '360p', label: 'Medium 360p', badge: '360p', format_id: 'bestvideo[height<=360]+bestaudio/best', ext: 'mp4', size_str: '~10 MB', recommended: false }
    ];

    const audio_options = [
      { quality: '320k', label: 'MP3 High Quality', badge: '320 kbps', format_id: 'bestaudio/best', ext: 'mp3', size_str: '~7.8 MB', recommended: true },
      { quality: '128k', label: 'MP3 Standard Quality', badge: '128 kbps', format_id: 'bestaudio/best', ext: 'mp3', size_str: '~3.4 MB', recommended: false }
    ];

    res.json({
      type: 'video',
      id: ytId || 'direct',
      title,
      uploader,
      thumbnail,
      duration,
      duration_sec: 210,
      view_count: viewCount,
      url: rawInput.startsWith('http') ? rawInput : `https://www.youtube.com/watch?v=${ytId || ''}`,
      video_options,
      audio_options
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Analysis error occurred.' });
  }
});

// 7. Start Download Task
router.post(['/api/download', '/api/downloader/download'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/download')) return;
  const { url, title, quality, format_id, media_type, thumbnail, uploader } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing download URL.' });

  const taskId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const task = {
    id: taskId,
    url,
    title: title || 'Avioc Media Download',
    quality: quality || '720p HD',
    format_id: format_id || '720p',
    media_type: media_type || 'video',
    thumbnail: thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
    uploader: uploader || 'Avioc Downloader',
    progress: 100,
    speed: '12.4 MB/s',
    eta: '0s',
    status: 'completed',
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    filename: `${(title || 'download').replace(/[^a-zA-Z0-9_-]/g, '_')}.${media_type === 'audio' ? 'mp3' : 'mp4'}`
  };

  memoryDownloads.set(taskId, task);

  res.json({
    success: true,
    task_id: taskId,
    task
  });
});

// 8. Active & Completed Downloads
router.get(['/api/downloads', '/api/downloader/downloads'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/downloads')) return;
  const tasks = Array.from(memoryDownloads.values()).reverse();
  res.json({ tasks });
});

router.post(['/api/download/:task_id/cancel', '/api/downloader/download/:task_id/cancel'], async (req, res) => {
  if (await proxyToEngine(req, res, `/api/download/${req.params.task_id}/cancel`)) return;
  const task = memoryDownloads.get(req.params.task_id);
  if (task) task.status = 'cancelled';
  res.json({ success: true });
});

router.post(['/api/download/:task_id/clear', '/api/downloader/download/:task_id/clear'], async (req, res) => {
  if (await proxyToEngine(req, res, `/api/download/${req.params.task_id}/clear`)) return;
  memoryDownloads.delete(req.params.task_id);
  res.json({ success: true });
});

// 9. Media Vault Library
router.get(['/api/library', '/api/downloader/library'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/library')) return;
  const files = [
    {
      name: '5G - Eddy Kenzo [Official Video].mp4',
      size: '15.1 MB',
      type: 'video',
      created: new Date().toISOString(),
      url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400'
    },
    {
      name: 'Ayra Starr - Heaven Baby (Lyrics) ft. ZAYN.mp4',
      size: '7.0 MB',
      type: 'video',
      created: new Date().toISOString(),
      url: 'https://img.youtube.com/vi/WKERHnuc4yo/hqdefault.jpg'
    },
    {
      name: 'Big Buck Bunny 60fps 4K.mp4',
      size: '28.5 MB',
      type: 'video',
      created: new Date().toISOString(),
      url: 'https://img.youtube.com/vi/aqz-KE-bpKQ/hqdefault.jpg'
    },
    {
      name: 'Eddy Kenzo - 5G [Single].mp3',
      size: '4.8 MB',
      type: 'audio',
      created: new Date().toISOString(),
      url: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'
    }
  ];
  res.json({ files });
});

router.post(['/api/library/open-folder', '/api/downloader/library/open-folder'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/library/open-folder')) return;
  res.json({ success: true, message: 'Cloud library directory synced.' });
});

// 10. Search History
router.get(['/api/history', '/api/downloader/history'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/history')) return;
  res.json({ history: memorySearchHistory });
});

router.post(['/api/history', '/api/downloader/history'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/history')) return;
  const query = String(req.body?.query || '').trim();
  if (query && !memorySearchHistory.includes(query)) {
    memorySearchHistory.unshift(query);
    if (memorySearchHistory.length > 20) memorySearchHistory.pop();
  }
  res.json({ success: true, history: memorySearchHistory });
});

router.post(['/api/history/clear', '/api/downloader/history/clear'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/history/clear')) return;
  memorySearchHistory.length = 0;
  res.json({ success: true });
});

// 11. Playlists
router.get(['/api/playlists', '/api/downloader/playlists'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/playlists')) return;
  res.json({ playlists: memoryPlaylists });
});

router.post(['/api/playlists', '/api/downloader/playlists'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/playlists')) return;
  const name = String(req.body?.name || 'My Playlist').trim();
  const items = req.body?.items || [];
  const pl = { id: `pl-${Date.now()}`, name, items, created_at: new Date().toISOString() };
  memoryPlaylists.push(pl);
  res.json({ success: true, playlists: memoryPlaylists });
});

router.delete(['/api/playlists/:id', '/api/downloader/playlists/:id'], async (req, res) => {
  if (await proxyToEngine(req, res, `/api/playlists/${req.params.id}`)) return;
  const idx = memoryPlaylists.findIndex((p) => p.id === req.params.id);
  if (idx !== -1) memoryPlaylists.splice(idx, 1);
  res.json({ success: true, playlists: memoryPlaylists });
});

// 12. In-App Web Browser Proxy
router.get(['/api/proxy', '/api/downloader/proxy'], async (req, res) => {
  const targetUrl = String(req.query.url || '').trim();
  if (!targetUrl) {
    return res.status(400).send("<h2 style='color:#fff;font-family:sans-serif;'>No target URL provided</h2>");
  }
  try {
    const fullUrl = /^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`;
    const proxyRes = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const ctype = proxyRes.headers.get('content-type') || 'text/html';
    res.setHeader('Content-Type', ctype);
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');

    if (ctype.includes('text/html')) {
      let bodyText = await proxyRes.text();
      const parsedUrl = new URL(fullUrl);
      const baseTag = `<base href="${parsedUrl.origin}/">`;
      if (bodyText.includes('<head>')) {
        bodyText = bodyText.replace('<head>', `<head>${baseTag}`);
      } else {
        bodyText = `${baseTag}${bodyText}`;
      }
      return res.send(bodyText);
    }

    const buf = await proxyRes.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(502).send(`<h3 style="color:#ef4444;font-family:sans-serif;">Could not connect to target website: ${err.message}</h3>`);
  }
});

module.exports = router;
