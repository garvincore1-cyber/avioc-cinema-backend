/**
 * GARVINIX PRO - Universal Video & Audio Downloader & In-App Browser Controller
 * Handles Search, Autocomplete, Explore Feeds, In-App Web Browser Sniffer, & Quality Selector
 */

class GarvinixApp {
  constructor() {
    this.currentMediaInfo = null;
    this.pollInterval = null;
    this.activeDownloadsCount = 0;
    this.currentCategory = 'music';
    this.suggestDebounceTimer = null;
    this.browserHistory = ['https://m.youtube.com'];
    this.browserHistoryIdx = 0;
    this.searchHistory = [];
    this.savedPlaylists = [];
    this.navigateBrowser = null;
    this.init();
  }

  init() {
    this.bindEvents();
    this.bindBrowserEvents();
    this.checkStatus();
    this.loadSearchHistory();
    this.loadSavedPlaylists();
    this.loadExploreFeed('music');
    this.startDownloadsPoller();
    if (window.garvinixPlayer) {
      window.garvinixPlayer.loadLibrary();
    }
  }

  bindEvents() {
    // Navigation Tabs (Desktop & Mobile)
    document.querySelectorAll('.nav-tab-btn, .mobile-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        this.switchTab(tab);
      });
    });

    // Main Input Bar & Clear / Paste / Submit
    const mainInput = document.getElementById('main-url-input');
    const btnSubmit = document.getElementById('btn-submit-search');
    const btnClear = document.getElementById('btn-clear-input');
    const btnPaste = document.getElementById('btn-paste-clipboard');
    const autoBox = document.getElementById('search-autocomplete-box');

    if (mainInput) {
      mainInput.addEventListener('input', () => {
        const val = mainInput.value.trim();
        if (btnClear) btnClear.style.display = val ? 'block' : 'none';
        
        // Autocomplete suggestions (only if not an http link)
        clearTimeout(this.suggestDebounceTimer);
        if (val.length >= 2 && !val.startsWith('http://') && !val.startsWith('https://')) {
          this.suggestDebounceTimer = setTimeout(() => {
            this.fetchSearchSuggestions(val);
          }, 180);
        } else {
          this.hideSuggestions();
        }
      });

      mainInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.hideSuggestions();
          this.handleSearchOrAnalyze();
        } else if (e.key === 'Escape') {
          this.hideSuggestions();
        }
      });
    }

    // Hide autocomplete on click outside
    document.addEventListener('click', (e) => {
      if (autoBox && !autoBox.contains(e.target) && e.target !== mainInput) {
        this.hideSuggestions();
      }
    });

    if (btnClear && mainInput) {
      btnClear.addEventListener('click', () => {
        mainInput.value = '';
        btnClear.style.display = 'none';
        this.hideSuggestions();
        mainInput.focus();
      });
    }

    if (btnPaste && mainInput) {
      btnPaste.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            mainInput.value = text.trim();
            if (btnClear) btnClear.style.display = 'block';
            this.showToast('📋 Link pasted from clipboard!');
            this.handleSearchOrAnalyze();
          }
        } catch (err) {
          mainInput.focus();
          this.showToast('ℹ️ Please press Ctrl+V to paste your link.');
        }
      });
    }

    if (btnSubmit) {
      btnSubmit.addEventListener('click', () => {
        this.hideSuggestions();
        this.handleSearchOrAnalyze();
      });
    }

    // Explore Category Chips
    document.querySelectorAll('.explore-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.explore-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const cat = chip.getAttribute('data-category') || 'music';
        this.loadExploreFeed(cat);
      });
    });

    // Clear Search History Button
    const btnClearHistory = document.getElementById('btn-clear-history');
    if (btnClearHistory) {
      btnClearHistory.addEventListener('click', () => this.clearSearchHistory());
    }

    // Refresh Explore Feed
    const btnRefreshExplore = document.getElementById('btn-refresh-explore');
    if (btnRefreshExplore) {
      btnRefreshExplore.addEventListener('click', () => {
        this.loadExploreFeed(this.currentCategory);
        this.showToast(`🔄 Refreshed ${this.currentCategory} feed`);
      });
    }

    // Back to Explore Feed from Search Results
    const btnBackExplore = document.getElementById('btn-back-to-explore');
    if (btnBackExplore) {
      btnBackExplore.addEventListener('click', () => {
        const searchSection = document.getElementById('search-results-section');
        const exploreSection = document.getElementById('explore-feed-section');
        if (searchSection) searchSection.style.display = 'none';
        if (exploreSection) {
          exploreSection.style.display = 'block';
          exploreSection.scrollIntoView({ behavior: 'smooth' });
        }
      });
    }

    // Supported Platform Pills -> Opens directly in our In-App Web Browser!
    document.querySelectorAll('.platform-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const url = pill.getAttribute('data-url');
        const hint = pill.getAttribute('data-hint') || '';
        
        // Switch to the in-app web browser tab!
        this.switchTab('tab-browser');
        
        if (url && typeof this.navigateBrowser === 'function') {
          this.navigateBrowser(url);
          this.showToast(`🌐 Opening ${hint.toUpperCase() || 'site'} in Garvinix In-App Browser...`);
        }
      });
    });

    // Quality Picker Modal Controls
    const btnCloseQuality = document.getElementById('btn-close-quality-modal');
    if (btnCloseQuality) {
      btnCloseQuality.addEventListener('click', () => this.closeQualityModal());
    }

    const modalOverlay = document.getElementById('modal-quality-picker');
    if (modalOverlay) {
      modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) this.closeQualityModal();
      });
    }

    // Format Tabs in Modal (Video vs Audio)
    const tabBtnVideo = document.getElementById('tab-btn-video-formats');
    const tabBtnAudio = document.getElementById('tab-btn-audio-formats');
    const panelVideo = document.getElementById('fmt-panel-video');
    const panelAudio = document.getElementById('fmt-panel-audio');

    if (tabBtnVideo && tabBtnAudio) {
      tabBtnVideo.addEventListener('click', () => {
        tabBtnVideo.classList.add('active');
        tabBtnAudio.classList.remove('active');
        if (panelVideo) panelVideo.classList.add('active');
        if (panelAudio) panelAudio.classList.remove('active');
      });

      tabBtnAudio.addEventListener('click', () => {
        tabBtnAudio.classList.add('active');
        tabBtnVideo.classList.remove('active');
        if (panelAudio) panelAudio.classList.add('active');
        if (panelVideo) panelVideo.classList.remove('active');
      });
    }

    // Open Downloads Folder in Explorer
    const btnOpenFolder = document.getElementById('btn-open-downloads-folder');
    const btnOpenFolderQueue = document.getElementById('btn-open-folder-queue');
    const btnOpenFolderVault = document.getElementById('btn-open-folder-vault');

    [btnOpenFolder, btnOpenFolderQueue, btnOpenFolderVault].forEach(b => {
      if (b) {
        b.addEventListener('click', () => this.openFolder());
      }
    });

    // Clear Finished Downloads Button
    const btnClearFinished = document.getElementById('btn-clear-completed');
    if (btnClearFinished) {
      btnClearFinished.addEventListener('click', async () => {
        await this.clearCompletedTasks();
      });
    }
  }

  bindBrowserEvents() {
    const browserInput = document.getElementById('browser-url-input');
    const btnBrowserGo = document.getElementById('btn-browser-go');
    const btnBrowserRefresh = document.getElementById('btn-browser-refresh');
    const btnBrowserBack = document.getElementById('btn-browser-back');
    const btnBrowserForward = document.getElementById('btn-browser-forward');
    const btnBrowserPopout = document.getElementById('btn-browser-popout');
    const browserIframe = document.getElementById('browser-iframe');
    const btnFloatingSniffer = document.getElementById('btn-floating-sniffer');
    const btnTopSniffer = document.getElementById('btn-browser-sniff');

    const navigateBrowser = (url) => {
      if (!url) return;
      let targetUrl = url.trim();
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        if (targetUrl.includes('.') && !targetUrl.includes(' ')) {
          targetUrl = 'https://' + targetUrl;
        } else {
          targetUrl = `https://m.youtube.com/results?search_query=${encodeURIComponent(targetUrl)}`;
        }
      }

      if (browserInput) browserInput.value = targetUrl;
      
      // Load through smart proxy to eliminate X-Frame-Options & CSP blocking
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
      if (browserIframe) browserIframe.src = proxyUrl;

      // Track history
      if (this.browserHistory[this.browserHistoryIdx] !== targetUrl) {
        this.browserHistory = this.browserHistory.slice(0, this.browserHistoryIdx + 1);
        this.browserHistory.push(targetUrl);
        this.browserHistoryIdx = this.browserHistory.length - 1;
      }
    };

    this.navigateBrowser = navigateBrowser;

    if (btnBrowserGo && browserInput) {
      btnBrowserGo.addEventListener('click', () => navigateBrowser(browserInput.value));
      browserInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') navigateBrowser(browserInput.value);
      });
    }

    if (btnBrowserPopout && browserInput) {
      btnBrowserPopout.addEventListener('click', () => {
        const url = browserInput.value.trim() || 'https://m.youtube.com';
        window.open(url, '_blank');
        this.showToast('🚀 Opened in dedicated window');
      });
    }

    if (btnBrowserRefresh && browserIframe) {
      btnBrowserRefresh.addEventListener('click', () => {
        browserIframe.src = browserIframe.src;
      });
    }

    if (btnBrowserBack) {
      btnBrowserBack.addEventListener('click', () => {
        if (this.browserHistoryIdx > 0) {
          this.browserHistoryIdx--;
          const prev = this.browserHistory[this.browserHistoryIdx];
          if (browserInput) browserInput.value = prev;
          if (browserIframe) browserIframe.src = `/api/proxy?url=${encodeURIComponent(prev)}`;
        }
      });
    }

    if (btnBrowserForward) {
      btnBrowserForward.addEventListener('click', () => {
        if (this.browserHistoryIdx < this.browserHistory.length - 1) {
          this.browserHistoryIdx++;
          const next = this.browserHistory[this.browserHistoryIdx];
          if (browserInput) browserInput.value = next;
          if (browserIframe) browserIframe.src = `/api/proxy?url=${encodeURIComponent(next)}`;
        }
      });
    }

    // Secondary postMessage navigation bridge from proxied pages
    window.addEventListener('message', (event) => {
      try {
        const data = event.data;
        if (data && data.type === 'garvinix_browser_navigate' && data.url) {
          navigateBrowser(data.url);
        } else if (data && data.type === 'garvinix_browser_url_changed' && data.url) {
          if (browserInput) browserInput.value = data.url;
        }
      } catch (e) {}
    });

    // Bookmark quick portal buttons
    document.querySelectorAll('.btn-bookmark').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-url');
        if (url) navigateBrowser(url);
      });
    });

    // Sniffer download handlers
    const handleSniff = () => {
      const url = browserInput ? browserInput.value.trim() : '';
      if (!url) {
        this.showToast('⚠️ No webpage loaded to download.');
        return;
      }
      this.showToast('⚡ Sniffing page for media streams...');
      this.analyzeAndOpenQuality(url);
    };

    if (btnFloatingSniffer) btnFloatingSniffer.addEventListener('click', handleSniff);
    if (btnTopSniffer) btnTopSniffer.addEventListener('click', handleSniff);
  }

  async fetchSearchSuggestions(query) {
    const autoBox = document.getElementById('search-autocomplete-box');
    if (!autoBox) return;

    try {
      const res = await fetch(`/api/suggest?q=${encodeURIComponent(query)}`);
      if (!res.ok) return;
      const data = await res.json();
      const suggestions = data.suggestions || [];

      if (suggestions.length === 0) {
        this.hideSuggestions();
        return;
      }

      autoBox.innerHTML = suggestions.map(item => `
        <div class="suggestion-item" data-query="${this.escapeHtml(item)}">
          <div class="suggestion-left">
            <span class="suggestion-icon">🔍</span>
            <span class="suggestion-query-text">${this.escapeHtml(item)}</span>
          </div>
          <span style="font-size: 11px; color: var(--garvinix-red); font-weight: 700;">Search ⚡</span>
        </div>
      `).join('');

      autoBox.querySelectorAll('.suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
          const q = item.getAttribute('data-query');
          const mainInput = document.getElementById('main-url-input');
          if (mainInput && q) {
            mainInput.value = q;
            this.hideSuggestions();
            this.handleSearchOrAnalyze();
          }
        });
      });

      autoBox.style.display = 'block';
    } catch (err) {
      console.warn('Autocomplete fetch error', err);
    }
  }

  hideSuggestions() {
    const autoBox = document.getElementById('search-autocomplete-box');
    if (autoBox) autoBox.style.display = 'none';
  }

  async loadExploreFeed(category = 'music') {
    this.currentCategory = category;
    const grid = document.getElementById('explore-cards-grid');
    const titleText = document.getElementById('explore-title-text');
    const titleIcon = document.getElementById('explore-title-icon');
    const titleDesc = document.getElementById('explore-title-desc');

    if (!grid) return;

    grid.innerHTML = `
      <div class="feed-loading-placeholder">
        <div class="loading-spinner"></div>
        <div>Loading fresh ${this.escapeHtml(category)} feed...</div>
      </div>
    `;

    try {
      const res = await fetch(`/api/explore/${category}`);
      if (!res.ok) throw new Error('Failed to load explore feed');
      const data = await res.json();

      if (titleText) titleText.innerText = data.title || 'African & Global Music Hits';
      if (titleIcon) titleIcon.innerText = data.icon || '🎵';
      if (titleDesc) titleDesc.innerText = data.description || '';

      const items = data.results || [];
      if (items.length === 0) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
            No feed items found. Try refreshing!
          </div>
        `;
        return;
      }

      this.renderVideoCards(grid, items);
    } catch (err) {
      console.error(err);
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #ff3366;">
          Could not load ${this.escapeHtml(category)} feed. Click "Refresh Feed" to retry.
        </div>
      `;
    }
  }

  renderVideoCards(containerEl, items) {
    containerEl.innerHTML = items.map((item, idx) => `
      <div class="video-card" data-idx="${idx}" data-url="${this.escapeHtml(item.url)}" data-id="${this.escapeHtml(item.id)}" data-title="${this.escapeHtml(item.title)}">
        <div class="card-thumb-wrapper">
          <img class="card-thumb-img" src="${this.escapeHtml(item.thumbnail)}" alt="Thumbnail" loading="lazy" />
          <span class="card-duration-badge">${item.duration}</span>
        </div>
        <div class="card-body">
          <div class="card-title" title="${this.escapeHtml(item.title)}">${this.escapeHtml(item.title)}</div>
          <div class="card-uploader">👤 ${this.escapeHtml(item.uploader)}</div>
          <div class="card-footer">
            <span style="font-size: 11px; color: var(--text-dim);">Garvinix Feed</span>
            <div class="card-actions-row">
              <button class="btn-card-watch" data-idx="${idx}" data-url="${this.escapeHtml(item.url)}" data-id="${this.escapeHtml(item.id)}" data-title="${this.escapeHtml(item.title)}" title="Watch in App">
                <span>▶</span> Watch
              </button>
              <button class="btn-card-download" data-url="${this.escapeHtml(item.url)}" title="Download 4K / MP3">
                <span>⚡</span> Download
              </button>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    // Attach Watch clicks
    containerEl.querySelectorAll('.btn-card-watch').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vidId = btn.getAttribute('data-id');
        const title = btn.getAttribute('data-title');
        const url = btn.getAttribute('data-url');
        const idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
        if (window.garvinixPlayer) {
          window.garvinixPlayer.playOnlineVideo(vidId, title, url, items, idx);
        }
      });
    });

    // Attach Download clicks
    containerEl.querySelectorAll('.btn-card-download').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = btn.getAttribute('data-url');
        if (url) {
          this.analyzeAndOpenQuality(url);
        }
      });
    });

    // Clicking the card itself triggers Watch by default with full playlist queue
    containerEl.querySelectorAll('.video-card').forEach(card => {
      card.addEventListener('click', () => {
        const vidId = card.getAttribute('data-id');
        const title = card.getAttribute('data-title');
        const url = card.getAttribute('data-url');
        const idx = parseInt(card.getAttribute('data-idx') || '0', 10);
        if (window.garvinixPlayer) {
          window.garvinixPlayer.playOnlineVideo(vidId, title, url, items, idx);
        }
      });
    });
  }

  switchTab(tabId) {
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.mobile-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === tabId);
    });

    if (tabId === 'tab-vault' && window.garvinixPlayer) {
      window.garvinixPlayer.loadLibrary();
    }
    if (tabId === 'tab-search') {
      this.loadSavedPlaylists();
    }
  }

  // =========================================================================
  // PERSISTED SEARCH HISTORY & SAVED PLAYLISTS
  // =========================================================================

  async loadSearchHistory() {
    try {
      let history = [];
      try {
        const res = await fetch('/api/history');
        if (res.ok) {
          const data = await res.json();
          history = data.history || [];
        }
      } catch (_) {}

      if (!history.length) {
        history = JSON.parse(localStorage.getItem('garvinix_search_history') || '[]');
      }
      this.searchHistory = history;
      this.renderSearchHistory();
    } catch (e) {
      console.warn('Load history note:', e);
    }
  }

  renderSearchHistory() {
    const box = document.getElementById('recent-searches-box');
    const container = document.getElementById('recent-chips-container');
    if (!box || !container) return;

    if (!this.searchHistory || this.searchHistory.length === 0) {
      box.style.display = 'none';
      return;
    }

    box.style.display = 'flex';
    container.innerHTML = this.searchHistory.slice(0, 10).map(query => `
      <div class="recent-chip" data-query="${this.escapeHtml(query)}">${this.escapeHtml(query)}</div>
    `).join('');

    container.querySelectorAll('.recent-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const q = chip.getAttribute('data-query');
        const mainInput = document.getElementById('main-url-input');
        if (mainInput && q) {
          mainInput.value = q;
          this.handleSearchOrAnalyze();
        }
      });
    });
  }

  async recordSearch(query) {
    if (!query || !query.trim()) return;
    const clean = query.trim();
    if (!this.searchHistory.includes(clean)) {
      this.searchHistory.unshift(clean);
      this.searchHistory = this.searchHistory.slice(0, 30);
    }
    try {
      localStorage.setItem('garvinix_search_history', JSON.stringify(this.searchHistory));
      fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: clean })
      }).catch(() => {});
    } catch (_) {}
    this.renderSearchHistory();
  }

  async clearSearchHistory() {
    this.searchHistory = [];
    try {
      localStorage.removeItem('garvinix_search_history');
      await fetch('/api/history/clear', { method: 'POST' });
    } catch (_) {}
    this.renderSearchHistory();
    this.showToast('🗑️ Search history cleared.');
  }

  async loadSavedPlaylists() {
    try {
      let playlists = [];
      try {
        const res = await fetch('/api/playlists');
        if (res.ok) {
          const data = await res.json();
          playlists = data.playlists || [];
        }
      } catch (_) {}

      if (!playlists.length) {
        playlists = JSON.parse(localStorage.getItem('garvinix_saved_playlists') || '[]');
      }
      this.savedPlaylists = playlists;
      this.renderSavedPlaylists();
    } catch (e) {
      console.warn('Load playlists note:', e);
    }
  }

  renderSavedPlaylists() {
    const section = document.getElementById('saved-playlists-section');
    const grid = document.getElementById('saved-playlists-grid');
    if (!section || !grid) return;

    if (!this.savedPlaylists || this.savedPlaylists.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    grid.innerHTML = this.savedPlaylists.map(pl => `
      <div class="playlist-card" data-id="${this.escapeHtml(pl.id || pl.name)}">
        <div class="playlist-thumb-box">
          <img class="playlist-thumb-img" src="${this.escapeHtml(pl.thumbnail || '/static/img/logo.svg')}" alt="Playlist thumb" onerror="this.src='/static/img/logo.svg';" />
          <div class="playlist-count-overlay">
            <span>📑</span> ${pl.count || pl.items?.length || 0} tracks
          </div>
        </div>
        <div class="playlist-card-body">
          <div class="playlist-card-title">${this.escapeHtml(pl.name)}</div>
          <div class="playlist-card-sub">
            <span>Saved Queue • ${pl.count || pl.items?.length || 0} items</span>
            <button class="btn-delete-playlist" data-id="${this.escapeHtml(pl.id || pl.name)}" title="Delete Playlist">&times;</button>
          </div>
        </div>
      </div>
    `).join('');

    // Attach click to play playlist
    grid.querySelectorAll('.playlist-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-playlist')) return;
        const plId = card.getAttribute('data-id');
        const playlist = this.savedPlaylists.find(p => (p.id === plId || p.name === plId));
        if (playlist && playlist.items && playlist.items.length > 0) {
          if (window.garvinixPlayer) {
            window.garvinixPlayer.playPlaylist(playlist.items, 0);
            this.showToast(`▶ Loaded and playing playlist: "${playlist.name}"`);
          }
        }
      });
    });

    // Attach delete
    grid.querySelectorAll('.btn-delete-playlist').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (confirm('Delete this saved playlist?')) {
          await this.deletePlaylist(id);
        }
      });
    });
  }

  async deletePlaylist(id) {
    try {
      this.savedPlaylists = this.savedPlaylists.filter(p => p.id !== id && p.name !== id);
      localStorage.setItem('garvinix_saved_playlists', JSON.stringify(this.savedPlaylists));
      await fetch(`/api/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
      this.renderSavedPlaylists();
      this.showToast('🗑️ Playlist deleted.');
    } catch (e) {
      console.error('Delete playlist err:', e);
    }
  }

  async checkStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data = await res.json();
      const statusText = document.getElementById('status-chip-text');
      if (statusText) {
        statusText.innerText = data.ffmpeg_detected ? `Garvinix Ready (4K/MP3)` : `Ready (Standard)`;
      }
    } catch (e) {
      console.warn("Status check failed", e);
    }
  }

  async handleSearchOrAnalyze() {
    const mainInput = document.getElementById('main-url-input');
    if (!mainInput) return;
    const query = mainInput.value.trim();
    if (!query) {
      this.showToast('⚠️ Please enter a link or search term.');
      mainInput.focus();
      return;
    }

    await this.analyzeAndOpenQuality(query);
  }

  async analyzeAndOpenQuality(queryOrUrl, options = {}) {
    if (!queryOrUrl || typeof queryOrUrl !== 'string' || !queryOrUrl.trim()) {
      this.showToast('⚠️ Please provide a video link or search term.');
      return;
    }
    const cleanUrl = queryOrUrl.trim();
    const fromPlayer = !!(options && options.fromPlayer);
    this.downloadFromPlayer = fromPlayer;

    // Automatically record to persistent search history
    this.recordSearch(cleanUrl);

    const btnSubmit = document.getElementById('btn-submit-search');
    const submitLabel = document.getElementById('btn-submit-label');
    const submitIcon = document.getElementById('btn-submit-icon');

    if (btnSubmit) btnSubmit.disabled = true;
    if (submitLabel) submitLabel.innerText = 'Analyzing...';
    if (submitIcon) submitIcon.innerText = '⏳';

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl })
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (jsonErr) {
        throw new Error('Server returned invalid response. Please try again.');
      }

      if (!res.ok) {
        throw new Error(data.error || 'Failed to analyze link');
      }

      if (data.type === 'search_results') {
        this.renderSearchResults(data.query, data.results);
      } else if (data.type === 'video') {
        this.openQualityModal(data);
      } else if (data.type === 'playlist') {
        this.renderPlaylistResults(data);
      }
    } catch (err) {
      console.error(err);
      this.showToast(`❌ Error: ${err.message}`);
    } finally {
      if (btnSubmit) btnSubmit.disabled = false;
      if (submitLabel) submitLabel.innerText = 'Search / Download';
      if (submitIcon) submitIcon.innerText = '⚡';
      if (fromPlayer && window.garvinixPlayer) {
        window.garvinixPlayer.resetDownloadButtonState();
      }
    }
  }

  renderSearchResults(query, results) {
    const searchSection = document.getElementById('search-results-section');
    const exploreSection = document.getElementById('explore-feed-section');
    const queryDisplay = document.getElementById('search-query-display');
    const countBadge = document.getElementById('search-results-count');
    const grid = document.getElementById('search-cards-grid');

    if (!searchSection || !grid) return;

    if (queryDisplay) queryDisplay.innerText = query;
    if (countBadge) countBadge.innerText = `${results.length} found`;

    if (!results || results.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
          No video results found for "${this.escapeHtml(query)}". Try another query!
        </div>
      `;
    } else {
      this.renderVideoCards(grid, results);
    }

    if (exploreSection) exploreSection.style.display = 'none';
    searchSection.style.display = 'block';
    searchSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  renderPlaylistResults(playlist) {
    const searchSection = document.getElementById('search-results-section');
    const exploreSection = document.getElementById('explore-feed-section');
    const queryDisplay = document.getElementById('search-query-display');
    const countBadge = document.getElementById('search-results-count');
    const grid = document.getElementById('search-cards-grid');

    if (!searchSection || !grid) return;
    if (queryDisplay) queryDisplay.innerText = `Playlist: ${playlist.title}`;
    if (countBadge) countBadge.innerText = `${playlist.count} videos`;

    grid.innerHTML = (playlist.entries || []).map(item => `
      <div class="video-card" data-url="${this.escapeHtml(item.url)}">
        <div class="card-thumb-wrapper">
          <img class="card-thumb-img" src="${this.escapeHtml(item.thumbnail)}" alt="Thumbnail" loading="lazy" />
          <span class="card-duration-badge">${item.duration}</span>
        </div>
        <div class="card-body">
          <div class="card-title">${this.escapeHtml(item.title)}</div>
          <div class="card-footer" style="margin-top: 10px;">
            <button class="btn-card-download" data-url="${this.escapeHtml(item.url)}">
              <span>⚡</span> Download This Video
            </button>
          </div>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.btn-card-download').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = btn.getAttribute('data-url');
        if (url) {
          this.analyzeAndOpenQuality(url);
        }
      });
    });

    if (exploreSection) exploreSection.style.display = 'none';
    searchSection.style.display = 'block';
    searchSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  openQualityModal(mediaInfo) {
    this.currentMediaInfo = mediaInfo;
    const modal = document.getElementById('modal-quality-picker');
    const thumb = document.getElementById('modal-video-thumb');
    const title = document.getElementById('modal-video-title');
    const channel = document.getElementById('modal-video-channel');
    const duration = document.getElementById('modal-video-duration');
    const views = document.getElementById('modal-video-views');

    if (thumb) thumb.src = mediaInfo.thumbnail;
    if (title) title.innerText = mediaInfo.title;
    if (channel) channel.innerText = mediaInfo.uploader;
    if (duration) duration.innerText = mediaInfo.duration;
    if (views) views.innerText = `${mediaInfo.view_count} views`;

    // Render Video Options
    const videoList = document.getElementById('video-options-list');
    if (videoList) {
      videoList.innerHTML = (mediaInfo.video_options || []).map(opt => `
        <div class="format-row-item ${opt.recommended ? 'recommended' : ''}" 
             data-type="video" 
             data-format="${this.escapeHtml(opt.format_id)}" 
             data-quality="${this.escapeHtml(opt.quality)}">
          <div class="format-row-left">
            <span class="format-res-badge">${opt.badge}</span>
            <div>
              <div class="format-label-title">
                ${this.escapeHtml(opt.label)} (MP4)
                ${opt.recommended ? '<span class="format-recommended-pill">Recommended</span>' : ''}
              </div>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="format-size-label">${opt.size_str}</span>
            <button class="btn-format-dl">Download</button>
          </div>
        </div>
      `).join('');
    }

    // Render Audio Options
    const audioList = document.getElementById('audio-options-list');
    if (audioList) {
      audioList.innerHTML = (mediaInfo.audio_options || []).map(opt => `
        <div class="format-row-item ${opt.recommended ? 'recommended' : ''}" 
             data-type="audio" 
             data-format="${this.escapeHtml(opt.format_id)}" 
             data-quality="${this.escapeHtml(opt.quality)}">
          <div class="format-row-left">
            <span class="format-res-badge" style="background: linear-gradient(135deg, #00f0ff, #0072ff);">${opt.badge}</span>
            <div>
              <div class="format-label-title">
                ${this.escapeHtml(opt.label)}
                ${opt.recommended ? '<span class="format-recommended-pill">High Quality</span>' : ''}
              </div>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="format-size-label">${opt.size_str}</span>
            <button class="btn-format-dl">Download</button>
          </div>
        </div>
      `).join('');
    }

    // Bind click events on format rows
    const attachFormatClick = (container) => {
      container.querySelectorAll('.format-row-item').forEach(row => {
        row.addEventListener('click', () => {
          const mediaType = row.getAttribute('data-type');
          const formatId = row.getAttribute('data-format');
          const quality = row.getAttribute('data-quality');
          this.triggerDownload(mediaType, formatId, quality);
        });
      });
    };

    if (videoList) attachFormatClick(videoList);
    if (audioList) attachFormatClick(audioList);

    if (modal) modal.classList.add('active');

    if (this.downloadFromPlayer && window.garvinixPlayer) {
      window.garvinixPlayer.resetDownloadButtonState();
    }
  }

  closeQualityModal() {
    const modal = document.getElementById('modal-quality-picker');
    if (modal) modal.classList.remove('active');
    if (this.downloadFromPlayer && window.garvinixPlayer) {
      window.garvinixPlayer.resetDownloadButtonState();
      window.garvinixPlayer.resumePlayback();
    }
    this.downloadFromPlayer = false;
    this.currentMediaInfo = null;
  }

  async triggerDownload(mediaType, formatId, quality) {
    if (!this.currentMediaInfo) return;

    const payload = {
      url: this.currentMediaInfo.webpage_url,
      format_id: formatId,
      quality: quality,
      media_type: mediaType,
      title: this.currentMediaInfo.title,
      uploader: this.currentMediaInfo.uploader,
      thumbnail: this.currentMediaInfo.thumbnail
    };

    const isFromPlayer = this.downloadFromPlayer || (window.garvinixPlayer && window.garvinixPlayer.isOpen());

    this.closeQualityModal();

    if (isFromPlayer && window.garvinixPlayer) {
      window.garvinixPlayer.resumePlayback();
      this.showToast(`⚡ Garvinix downloading in background: ${quality} (${mediaType.toUpperCase()})`);
    } else {
      this.showToast(`🚀 Garvinix starting download: ${quality} (${mediaType.toUpperCase()})...`);
    }

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (jsonErr) {
        throw new Error('Server returned unexpected response.');
      }
      if (data.success) {
        if (isFromPlayer && window.garvinixPlayer) {
          window.garvinixPlayer.trackDownloadProgress(data.task_id, payload.title, quality);
          this.fetchActiveDownloads();
        } else {
          this.switchTab('tab-downloads');
          this.fetchActiveDownloads();
        }
      } else {
        this.showToast(`❌ Error: ${data.error || 'Failed to start download'}`);
      }
    } catch (err) {
      console.error(err);
      this.showToast(`❌ ${err.message || 'Could not connect to Garvinix download service.'}`);
    }
  }

  startDownloadsPoller() {
    this.fetchActiveDownloads();
    this.pollInterval = setInterval(() => {
      this.fetchActiveDownloads();
    }, 1000);
  }

  async fetchActiveDownloads() {
    try {
      const res = await fetch('/api/downloads');
      if (!res.ok) return;
      const data = await res.json();
      const tasks = data.tasks || [];

      // Update counters
      const activeTasks = tasks.filter(t => ['queued', 'downloading', 'processing'].includes(t.status));
      this.activeDownloadsCount = activeTasks.length;

      const badgeDesktop = document.getElementById('header-active-count');
      const badgeMobile = document.getElementById('mobile-active-count');

      if (badgeDesktop) {
        badgeDesktop.style.display = this.activeDownloadsCount > 0 ? 'inline-block' : 'none';
        badgeDesktop.innerText = this.activeDownloadsCount;
      }
      if (badgeMobile) {
        badgeMobile.style.display = this.activeDownloadsCount > 0 ? 'inline-block' : 'none';
        badgeMobile.innerText = this.activeDownloadsCount;
      }

      // Relay progress to player floating card if player is tracking a download
      if (window.garvinixPlayer && window.garvinixPlayer.currentDownloadTaskId) {
        const tracked = tasks.find(t => t.id === window.garvinixPlayer.currentDownloadTaskId);
        if (tracked) {
          window.garvinixPlayer.updateDownloadProgress(tracked);
        }
      }

      this.renderDownloadsList(tasks);
    } catch (e) {
      // Ignore background network hiccups
    }
  }

  renderDownloadsList(tasks) {
    const container = document.getElementById('downloads-list-container');
    if (!container) return;

    if (!tasks || tasks.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📥</div>
          <h3>No Active Downloads</h3>
          <p>Paste a video link or search for music on the home tab to start downloading with Garvinix!</p>
          <button class="btn-accent-pill" onclick="window.garvinixApp.switchTab('tab-search')">
            + Start a Download
          </button>
        </div>
      `;
      return;
    }

    container.innerHTML = tasks.map(task => {
      const isFinished = task.status === 'completed';
      const isError = task.status === 'error';
      const isCancelled = task.status === 'cancelled';
      const isActive = ['queued', 'downloading', 'processing'].includes(task.status);

      let actionHtml = '';
      if (isActive) {
        actionHtml = `<button class="btn-task-action" onclick="window.garvinixApp.cancelTask('${task.id}')">Cancel</button>`;
      } else if (isFinished) {
        actionHtml = `
          <button class="btn-task-action" style="background: var(--garvinix-gradient); border: none;" onclick="window.garvinixPlayer.playFile('${task.media_type}', '${this.escapeHtml(task.filename)}', window.garvinixPlayer.libraryFiles)">▶ Play</button>
          <button class="btn-task-action" onclick="window.garvinixApp.openFolder('${task.media_type}')">📂 Folder</button>
        `;
      } else {
        actionHtml = `<button class="btn-task-action" onclick="window.garvinixApp.clearTask('${task.id}')">Dismiss</button>`;
      }

      return `
        <div class="download-task-item" id="task-${task.id}">
          <img class="task-thumb" src="${this.escapeHtml(task.thumbnail || '/static/img/logo.svg')}" alt="Thumb" onerror="this.src='https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150';" />
          <div class="task-info">
            <div class="task-title" title="${this.escapeHtml(task.title)}">${this.escapeHtml(task.title)}</div>
            <div class="task-meta-row">
              <span class="badge-format-chip">${this.escapeHtml(task.quality_label)} (${task.media_type.toUpperCase()})</span>
              <span>• ${this.escapeHtml(task.uploader)}</span>
              ${task.speed !== '0 KB/s' ? `<span>• ⚡ ${task.speed}</span>` : ''}
              ${task.eta && task.eta !== '--:--' && task.eta !== 'Done' ? `<span>• ⏳ ETA ${task.eta}</span>` : ''}
            </div>

            <div class="task-progress-bar-wrap">
              <div class="task-progress-fill" style="width: ${task.progress}%;"></div>
            </div>

            <div class="task-stats-row">
              <span class="task-status-tag ${task.status}">${task.status} (${task.progress}%)</span>
              <span>${task.downloaded_str} / ${task.total_str}</span>
            </div>
            ${task.error_message ? `<div style="color: #ff3366; font-size: 11px; margin-top: 4px;">Error: ${this.escapeHtml(task.error_message)}</div>` : ''}
          </div>
          <div class="task-actions">
            ${actionHtml}
          </div>
        </div>
      `;
    }).join('');
  }

  async cancelTask(taskId) {
    try {
      await fetch(`/api/download/${taskId}/cancel`, { method: 'POST' });
      this.showToast('⏹️ Download cancelled.');
      this.fetchActiveDownloads();
    } catch (e) {
      console.error(e);
    }
  }

  async clearTask(taskId) {
    try {
      await fetch(`/api/download/${taskId}/clear`, { method: 'POST' });
      this.fetchActiveDownloads();
    } catch (e) {
      console.error(e);
    }
  }

  async clearCompletedTasks() {
    try {
      const res = await fetch('/api/downloads');
      const data = await res.json();
      const finished = (data.tasks || []).filter(t => ['completed', 'cancelled', 'error'].includes(t.status));
      for (const t of finished) {
        await fetch(`/api/download/${t.id}/clear`, { method: 'POST' });
      }
      this.showToast('🧹 Cleared finished download tasks.');
      this.fetchActiveDownloads();
    } catch (e) {
      console.error(e);
    }
  }

  async openFolder(folderType = "all") {
    try {
      const res = await fetch('/api/library/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: folderType })
      });
      const data = await res.json();
      if (data.success) {
        this.showToast('📂 Opened Downloads folder in Explorer.');
      } else {
        this.showToast(`Folder location: ${data.path}`);
      }
    } catch (e) {
      console.error(e);
    }
  }

  showToast(message) {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;

    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.innerText = message;
    stack.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.garvinixApp = new GarvinixApp();
});
