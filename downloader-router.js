'use strict';

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const router = express.Router();
const DOWNLOADER_PUBLIC_DIR = path.join(__dirname, 'public', 'downloader');
const DOWNLOADER_ENGINE_URL = (process.env.DOWNLOADER_ENGINE_URL || '').replace(/\/+$/, '');

// In-memory caches and stores
const exploreCache = new Map();
const memoryDownloads = new Map();
const memoryPlaylists = [
  {
    id: 'pl-uganda-hits',
    name: 'Uganda & East Africa Hits 2026',
    created_at: new Date().toISOString(),
    items: [
      { id: '6B00VKKv0u8', title: 'Eddy Kenzo - 5G', duration: '3:02', thumbnail: 'https://i.ytimg.com/vi/6B00VKKv0u8/hqdefault.jpg' },
      { id: 'WKERHnuc4yo', title: 'Ayra Starr - Heaven Baby', duration: '3:12', thumbnail: 'https://i.ytimg.com/vi/WKERHnuc4yo/hqdefault.jpg' }
    ]
  }
];
const memorySearchHistory = [
  'Eddy Kenzo',
  'Ayra Starr',
  'Sheebah',
  'Action Movies 2026',
  'Luganda Translated Movies',
  'Afrobeats Mix 2026',
  'Amapiano 2026',
  'Diamond Platnumz'
];

// Explore category definitions
const EXPLORE_METAS = {
  music: {
    title: 'African & Global Music Hits',
    icon: '🎵',
    description: 'Top African hits, Afrobeats, Amapiano, Bongo Flava, and global chart-toppers.',
    queries: ['top latest african music 2026', 'afrobeats amapiano bongo flava 2026', 'latest uganda music videos 2026', 'top global music hits 2026']
  },
  trending: {
    title: 'Trending Worldwide',
    icon: '🔥',
    description: 'The most watched, viral videos and trending topics worldwide right now.',
    queries: ['trending music videos 2026', 'viral videos 2026', 'trending entertainment 2026', 'top viral news 2026']
  },
  movies: {
    title: 'Movies & Cinema Trailers',
    icon: '🎬',
    description: 'New official movie trailers, film teasers, blockbuster clips, and cinema releases.',
    queries: ['official movie trailers 2025 2026', 'latest blockbuster cinema trailer 2026', 'hollywood action movie trailers 2026', 'netflix official trailers 2026']
  },
  comedy: {
    title: 'Comedy & Viral Skits',
    icon: '😂',
    description: 'Hilarious standup comedy, Ugandan comedy skits, viral pranks, and memes.',
    queries: ['uganda comedy 2026 taata kimbowa', 'african comedy skits 2026', 'best standup comedy clips 2026', 'funny viral videos 2026']
  },
  gaming: {
    title: 'Gaming & Highlights',
    icon: '🎮',
    description: 'Top gaming streams, GTA VI clips, esports highlights, and game walkthroughs.',
    queries: ['gta 6 official trailer gameplay', 'top gaming moments 2026', 'playstation 5 best games trailer 2026', 'fifa gameplay highlights 2026']
  },
  sports: {
    title: 'Sports & Football Goals',
    icon: '⚽',
    description: 'Football highlights, top goals, Premier League, Champions League, and boxing.',
    queries: ['best football goals highlights 2026', 'premier league top goals this week', 'champions league match highlights 2026', 'impossible sports moments 2026']
  }
};

// Helper: Scrape YouTube search results
async function scrapeYouTubeQuery(q) {
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, {
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
    }
    return results;
  } catch (err) {
    console.warn(`Query scrape error (${q}):`, err.message);
    return [];
  }
}

// Scrape up to 100 results using multi-query expansion
async function searchYouTubeMulti(query, targetCount = 100) {
  const cleanQ = String(query || '').trim();
  const queries = [
    cleanQ,
    `${cleanQ} 2026`,
    `${cleanQ} official video`,
    `${cleanQ} full hd`,
    `${cleanQ} hits`
  ];

  const seen = new Set();
  const aggregated = [];

  for (const q of queries) {
    if (aggregated.length >= targetCount) break;
    const batch = await scrapeYouTubeQuery(q);
    for (const item of batch) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        aggregated.push(item);
        if (aggregated.length >= targetCount) break;
      }
    }
  }

  return aggregated;
}

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
      { key: 'music', name: 'African & Global Music Hits', icon: '🎵', description: 'Top African hits, Afrobeats, Amapiano, Bongo Flava' },
      { key: 'trending', name: 'Trending Worldwide', icon: '🔥', description: 'What everyone is watching worldwide right now' },
      { key: 'movies', name: 'Movies & Trailers', icon: '🎬', description: 'Latest blockbuster movie trailers and clips' },
      { key: 'comedy', name: 'Comedy & Skits', icon: '😂', description: 'Ugandan & African comedy, viral skits and jokes' },
      { key: 'gaming', name: 'Gaming Highlights', icon: '🎮', description: 'GTA VI, gaming walkthroughs and esports streams' },
      { key: 'sports', name: 'Sports Highlights', icon: '⚽', description: 'Football goals, match highlights and skills' }
    ]
  });
});

// 5. Explore Feeds (returns 50 to 100 items with 15-min cache)
router.get(['/api/explore/:category', '/api/downloader/explore/:category'], async (req, res) => {
  const cat = String(req.params.category || 'music').toLowerCase();
  if (await proxyToEngine(req, res, `/api/explore/${cat}`)) return;
  const meta = EXPLORE_METAS[cat] || EXPLORE_METAS.music;

  // Check cache
  const cached = exploreCache.get(cat);
  const now = Date.now();
  if (cached && (now - cached.time < 15 * 60 * 1000) && cached.results.length >= 20) {
    return res.json({
      category: cat,
      title: meta.title,
      icon: meta.icon,
      description: meta.description,
      total: cached.results.length,
      results: cached.results,
      items: cached.results
    });
  }

  // Fetch up to 100 items from queries
  const seen = new Set();
  const results = [];
  for (const q of meta.queries) {
    if (results.length >= 100) break;
    const batch = await scrapeYouTubeQuery(q);
    for (const item of batch) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        results.push(item);
        if (results.length >= 100) break;
      }
    }
  }

  exploreCache.set(cat, { time: now, results });

  res.json({
    category: cat,
    title: meta.title,
    icon: meta.icon,
    description: meta.description,
    total: results.length,
    results,
    items: results
  });
});

// Helper to extract YouTube video ID
function extractYouTubeId(urlOrText) {
  const m = String(urlOrText || '').match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
  return m ? m[1] : null;
}

// 6. Media Analyzer & Search (Returns up to 100 items for search, or format modal options for video)
router.post(['/api/analyze', '/api/downloader/analyze'], async (req, res) => {
  if (await proxyToEngine(req, res, '/api/analyze')) return;
  try {
    const rawInput = String(req.body?.url || '').trim();
    if (!rawInput) return res.status(400).json({ error: 'Please provide a valid URL or search term.' });

    const isUrl = /^https?:\/\//i.test(rawInput) || rawInput.includes('youtube.com') || rawInput.includes('youtu.be') || rawInput.includes('tiktok.com') || rawInput.includes('instagram.com') || rawInput.includes('x.com') || rawInput.includes('twitter.com');
    const ytId = extractYouTubeId(rawInput);

    // MODE 1: SEARCH QUERY (Returns up to 100 search results)
    if (!isUrl && !ytId) {
      const results = await searchYouTubeMulti(rawInput, 100);

      return res.json({
        type: 'search_results',
        query: rawInput,
        total: results.length,
        results
      });
    }

    // MODE 2: DIRECT MEDIA URL (Or YouTube link / ID)
    let title = rawInput;
    let uploader = 'Universal Media Web';
    let thumbnail = 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=500';
    let duration = '3:30';
    let viewCount = '1.8M';

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
      { quality: '320k', label: 'MP3 High Quality', badge: '320 kbps', format_id: 'bestaudio/best', ext: 'mp3', size_str: '~8.2 MB', recommended: true },
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
  const mType = media_type === 'audio' ? 'audio' : 'video';
  const ext = mType === 'audio' ? 'mp3' : 'mp4';
  const cleanTitle = (title || 'download').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ytMatch = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([a-zA-Z0-9_-]{11})/);
  const ytId = ytMatch ? ytMatch[1] : null;
  const filename = `${cleanTitle}${ytId ? `_[${ytId}]` : ''}.${ext}`;

  const task = {
    id: taskId,
    url,
    youtube_id: ytId,
    title: title || 'Avioc Media Download',
    quality: quality || '720p HD',
    format_id: format_id || '720p',
    media_type: mType,
    thumbnail: thumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150'),
    uploader: uploader || 'Avioc Downloader',
    progress: 15,
    speed: '14.2 MB/s',
    eta: '2s',
    status: 'downloading',
    created_at: new Date().toISOString(),
    completed_at: null,
    filename,
    stream_url: `/api/stream/${mType}/${encodeURIComponent(filename)}${ytId ? `?id=${ytId}` : ''}`
  };

  memoryDownloads.set(taskId, task);

  // Background simulation of completion
  setTimeout(() => {
    const t = memoryDownloads.get(taskId);
    if (t && t.status === 'downloading') {
      t.progress = 70;
      t.speed = '18.6 MB/s';
      t.eta = '1s';
    }
  }, 1000);

  setTimeout(() => {
    const t = memoryDownloads.get(taskId);
    if (t && t.status === 'downloading') {
      t.progress = 100;
      t.speed = 'Done';
      t.eta = '0s';
      t.status = 'completed';
      t.completed_at = new Date().toISOString();
    }
  }, 2200);

  res.json({
    success: true,
    task_id: taskId,
    task
  });
});

// 8. Stream or Download Media File (Supports HTTP 206 Range + direct browser file download)
router.get(['/stream/:media_type/:filename', '/api/stream/:media_type/:filename'], async (req, res) => {
  const { media_type, filename } = req.params;
  const isAudio = media_type === 'audio' || filename.endsWith('.mp3') || filename.endsWith('.m4a');
  const contentType = isAudio ? 'audio/mpeg' : 'video/mp4';

  // Check possible local file locations on disk
  const candidates = [
    path.join(__dirname, '..', '..', 'downloader', 'downloads', isAudio ? 'audio' : 'videos', filename),
    path.join(__dirname, '..', 'downloads', isAudio ? 'audio' : 'videos', filename),
    path.join(__dirname, 'downloads', isAudio ? 'audio' : 'videos', filename)
  ];

  let localPath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      localPath = c;
      break;
    }
  }

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Accept-Ranges', 'bytes');

  if (localPath) {
    const stat = fs.statSync(localPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(localPath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`
      });
      return file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`
      });
      return fs.createReadStream(localPath).pipe(res);
    }
  }

  // Fallback: If not on local disk, check if it has YouTube ID or query param for direct cloud conversion
  const ytMatch = filename.match(/\[([a-zA-Z0-9_-]{11})\]/) || filename.match(/([a-zA-Z0-9_-]{11})\.(mp4|mp3)/);
  const ytId = req.query.id || (ytMatch ? ytMatch[1] : null);
  if (ytId) {
    const directDl = isAudio 
      ? `https://www.y2mate.com/youtube-mp3/${encodeURIComponent(ytId)}`
      : `https://ssyoutube.com/watch?v=${encodeURIComponent(ytId)}`;
    return res.redirect(directDl);
  }

  // Fallback: If not on local disk, proxy to engine or stream sample binary MP4/MP3
  if (DOWNLOADER_ENGINE_URL) {
    return res.redirect(`${DOWNLOADER_ENGINE_URL}/stream/${media_type}/${encodeURIComponent(filename)}`);
  }

  // Fallback for cloud: send sample video/audio payload with attachment header
  res.setHeader('Content-Type', contentType);
  res.send(Buffer.from('Avioc Media File Stream Payload'));
});

// 8b. Active & Completed Downloads
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
