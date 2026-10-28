/**
 * Garvinix - Screen-Smart Cinema Player & Up-Next Auto-Play Controller
 * Inspired by Avioc Cinema Player:
 * - Immersive Fullscreen/Chrome-Window Viewport Stage
 * - Floating Graphical UI Layer Over Video Stage
 * - Inactivity Auto-Hide (Controls, Badges, Dock & Cursor disappear after 3.5s)
 * - Docked Upcoming Videos Carousel (.pdock with .pthumb cards)
 * - Interactive Dock Card Switching with Auto-Center Scroll
 * - Reliable YouTube IFrame Player API (YT.Player) Auto-Next Detection
 * - Snappy 3-Second Up-Next Auto-Play Countdown
 * - Aspect Ratio Cycling (16:9 / 9:16 Shorts / Fill)
 * - Native Fullscreen, PiP, Double-Tap Seek & Keyboard Shortcuts
 */

class GarvinixPlayer {
  constructor() {
    this.modalPlayer = document.getElementById('modal-player');
    this.playerCard = document.querySelector('.player-modal-card');
    this.stageBox = document.getElementById('player-stage-box');
    this.videoEl = document.getElementById('cinema-video-element');
    this.audioEl = document.getElementById('cinema-audio-element');
    this.iframeEl = document.getElementById('cinema-iframe-element');
    this.audioVisualizer = document.getElementById('audio-visualizer-container');
    
    // Header elements
    this.playerTitle = document.getElementById('player-modal-title');
    this.playerMeta = document.getElementById('player-file-info');
    this.queueBadge = document.getElementById('player-queue-badge');
    this.formatPill = document.getElementById('player-format-pill');
    this.chkAutoplay = document.getElementById('chk-player-autoplay');
    this.btnAspect = document.getElementById('btn-player-aspect');
    this.aspectIcon = document.getElementById('aspect-mode-icon');
    this.btnPip = document.getElementById('btn-player-pip');
    this.btnFullscreen = document.getElementById('btn-player-fullscreen');
    this.fsIcon = document.getElementById('fs-icon');
    this.btnPlayerDownload = document.getElementById('btn-player-download-current');
    this.btnOpenFile = document.getElementById('btn-player-open-file');

    // Navigation elements
    this.btnPrev = document.getElementById('btn-player-prev');
    this.btnNext = document.getElementById('btn-player-next');

    // Docked Upcoming Playlist Carousel (Avioc Cinema Dock)
    this.dockEl = document.getElementById('pdock');
    this.dockList = document.getElementById('pdock-list');
    this.dockCount = document.getElementById('pdock-count');
    this.btnToggleDock = document.getElementById('btn-toggle-dock');
    this.dockToggleIcon = document.getElementById('dock-toggle-icon');
    this.btnSavePlaylist = document.getElementById('btn-save-current-playlist');

    // Up Next Overlay elements
    this.upNextOverlay = document.getElementById('player-up-next-overlay');
    this.upNextCountdownNum = document.getElementById('up-next-countdown-num');
    this.upNextTitle = document.getElementById('up-next-title');
    this.upNextUploader = document.getElementById('up-next-uploader');
    this.upNextThumb = document.getElementById('up-next-thumb');
    this.btnUpNextCancel = document.getElementById('btn-up-next-cancel');
    this.btnUpNextCancelAction = document.getElementById('btn-up-next-cancel-action');
    this.btnUpNextPlayNow = document.getElementById('btn-up-next-play-now');

    // Seek ripples
    this.seekLeft = document.getElementById('seek-ripple-left');
    this.seekRight = document.getElementById('seek-ripple-right');

    // In-Player Floating Download Progress
    this.dlProgressBox = document.getElementById('player-dl-progress');
    this.dlProgressTitle = document.getElementById('player-dl-title');
    this.dlProgressBadge = document.getElementById('player-dl-badge');
    this.dlProgressMeta = document.getElementById('player-dl-meta');
    this.dlProgressBarFill = document.getElementById('player-dl-bar-fill');
    this.btnPlayerDlClose = document.getElementById('btn-player-dl-close');
    this.currentDownloadTaskId = null;

    // Completion Watcher Worker state
    this.completionWatcherInterval = null;
    this.videoCompletedHandled = false;

    // State
    this.currentPlayingFile = null;
    this.currentOnlineUrl = null;
    this.currentMediaType = 'video';
    this.libraryFiles = [];
    this.currentFilter = 'all';

    // Playlist queue state
    this.currentPlaylist = [];
    this.currentIndex = -1;
    this.autoPlayNext = true;
    this.aspectMode = 'auto'; // 'auto', 'vertical', 'fill'
    this.countdownTimer = null;
    this.countdownSeconds = 3;

    // YouTube IFrame API state
    this.ytPlayer = null;
    this.ytApiReady = false;
    this.currentYtId = null;

    // Inactivity Auto-hide timer
    this.idleTimer = null;
    this.wakePlayer = null;

    this.init();
  }

  init() {
    this.setupYouTubeAPI();
    this.setupAutoHide();
    this.bindEvents();
    this.bindSmartScreenEvents();
  }

  // =========================================================================
  // YOUTUBE IFRAME PLAYER API INTEGRATION (FOR SEAMLESS AUTO-NEXT)
  // =========================================================================

  setupYouTubeAPI() {
    if (window.YT && window.YT.Player) {
      this.ytApiReady = true;
    }

    const prevCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevCallback === 'function') prevCallback();
      this.ytApiReady = true;
      if (this.currentYtId && !this.ytPlayer) {
        this.hookYouTubePlayer(this.currentYtId);
      }
    };

    // Secondary safety-net: listen to postMessage from YouTube iframe
    window.addEventListener('message', (event) => {
      try {
        let data = event.data;
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch (_) { return; }
        }
        if (!data) return;

        // Catch onStateChange = 0 (ENDED)
        if (data.event === 'onStateChange' && data.info === 0) {
          this.onVideoCompleted('postMessage_state_0');
        }
        // Catch infoDelivery with playerState === 0
        if (data.event === 'infoDelivery' && data.info && data.info.playerState === 0) {
          this.onVideoCompleted('postMessage_infoDelivery_0');
        }
        // Catch currentTime near duration
        if (data.info && typeof data.info.currentTime === 'number' && typeof data.info.duration === 'number') {
          if (data.info.duration > 0 && data.info.currentTime >= data.info.duration - 0.5) {
            this.onVideoCompleted('postMessage_near_end');
          }
        }
      } catch (e) {}
    });
  }

  // =========================================================================
  // AVIOC CINEMA INACTIVITY AUTO-HIDE (6.0s GENTLE FADEOUT WITH ACTIVE WAKE)
  // =========================================================================

  setupAutoHide() {
    const wake = () => {
      if (!this.modalPlayer || !this.modalPlayer.classList.contains('active')) return;
      clearTimeout(this.idleTimer);
      this.modalPlayer.classList.remove('idle');
      this.idleTimer = setTimeout(() => {
        if (this.modalPlayer && this.modalPlayer.classList.contains('active')) {
          this.modalPlayer.classList.add('idle');
        }
      }, 6000);
    };

    // Attach wake listener to modal, dock, header, controls, document, and window
    const wakeElements = [
      this.modalPlayer,
      this.dockEl,
      document.querySelector('.player-hdr-smart'),
      document.querySelector('.player-ftr-smart')
    ];

    wakeElements.forEach(el => {
      if (el) {
        ['pointerdown', 'pointermove', 'mousemove', 'mouseenter', 'touchstart', 'click'].forEach(evt => {
          el.addEventListener(evt, wake, { passive: true });
        });
      }
    });

    // Broad document and window listeners
    document.addEventListener('mousemove', wake, { passive: true });
    window.addEventListener('keydown', wake);
    window.addEventListener('focus', wake);
    this.wakePlayer = wake;
  }

  bindEvents() {
    // Close modal
    const btnClose = document.getElementById('btn-close-player-modal');
    if (btnClose) {
      btnClose.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closePlayer();
      });
    }

    // Toggle dock collapse/expand
    if (this.btnToggleDock) {
      this.btnToggleDock.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.dockEl) {
          this.dockEl.classList.toggle('collapsed');
          const isCollapsed = this.dockEl.classList.contains('collapsed');
          if (this.dockToggleIcon) {
            this.dockToggleIcon.innerText = isCollapsed ? '▴' : '▾';
          }
        }
      });
    }

    // Refresh library button
    const btnRefresh = document.getElementById('btn-refresh-library');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => {
        this.loadLibrary();
        if (window.garvinixApp) window.garvinixApp.showToast('🔄 Media Library refreshed.');
      });
    }

    // Filter pills (All, Videos, Audio)
    document.querySelectorAll('.filter-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.currentFilter = pill.getAttribute('data-filter') || 'all';
        this.renderLibrary();
      });
    });

    // Reveal in Explorer button from player
    if (this.btnOpenFile) {
      this.btnOpenFile.addEventListener('click', () => {
        if (window.garvinixApp) {
          window.garvinixApp.openFolder(this.currentMediaType);
        }
      });
    }

    // Download current video from player (seamless background flow)
    if (this.btnPlayerDownload) {
      this.btnPlayerDownload.addEventListener('click', () => {
        const targetUrl = this.currentOnlineUrl;
        if (!targetUrl || !window.garvinixApp) return;

        // Visual loading feedback directly on the download button
        this.btnPlayerDownload.innerHTML = '<span>⏳</span> Loading...';
        this.btnPlayerDownload.disabled = true;

        // Bring the format options directly on top of the player without closing it
        window.garvinixApp.analyzeAndOpenQuality(targetUrl, { fromPlayer: true });
      });
    }

    // Dismiss in-player download progress card
    if (this.btnPlayerDlClose) {
      this.btnPlayerDlClose.addEventListener('click', () => this.hideDownloadProgress());
    }

    // Save current dock queue as persistent playlist
    if (this.btnSavePlaylist) {
      this.btnSavePlaylist.addEventListener('click', (e) => {
        e.stopPropagation();
        this.saveCurrentQueueAsPlaylist();
      });
    }

    // Next / Previous Navigation buttons
    if (this.btnNext) {
      this.btnNext.addEventListener('click', () => this.playNext());
    }
    if (this.btnPrev) {
      this.btnPrev.addEventListener('click', () => this.playPrev());
    }

    // Autoplay checkbox toggle
    if (this.chkAutoplay) {
      this.chkAutoplay.addEventListener('change', () => {
        this.autoPlayNext = this.chkAutoplay.checked;
        if (!this.autoPlayNext) {
          this.cancelUpNextCountdown();
        }
      });
    }

    // Up Next Overlay action buttons
    const cancelCountdown = () => this.cancelUpNextCountdown();
    if (this.btnUpNextCancel) this.btnUpNextCancel.addEventListener('click', cancelCountdown);
    if (this.btnUpNextCancelAction) this.btnUpNextCancelAction.addEventListener('click', cancelCountdown);
    if (this.btnUpNextPlayNow) {
      this.btnUpNextPlayNow.addEventListener('click', () => {
        this.cancelUpNextCountdown();
        this.playNext();
      });
    }

    // Local Video ended event -> triggers completion
    if (this.videoEl) {
      this.videoEl.addEventListener('ended', () => {
        this.onVideoCompleted('html5_video_ended');
      });

      // Detect vertical video automatically
      this.videoEl.addEventListener('loadedmetadata', () => {
        if (this.videoEl.videoHeight > this.videoEl.videoWidth) {
          this.setAspectMode('vertical');
        } else if (this.aspectMode === 'vertical') {
          this.setAspectMode('auto');
        }
      });
    }

    // Local Audio ended event -> triggers completion
    if (this.audioEl) {
      this.audioEl.addEventListener('ended', () => {
        this.onVideoCompleted('html5_audio_ended');
      });
    }
  }

  bindSmartScreenEvents() {
    // Aspect Ratio Switch
    if (this.btnAspect) {
      this.btnAspect.addEventListener('click', () => this.cycleAspectMode());
    }

    // Picture-in-Picture
    if (this.btnPip) {
      this.btnPip.addEventListener('click', () => this.togglePiP());
    }

    // Fullscreen Toggle
    if (this.btnFullscreen) {
      this.btnFullscreen.addEventListener('click', () => this.toggleFullscreen());
    }

    // Listen for fullscreen change
    document.addEventListener('fullscreenchange', () => {
      const isFs = !!document.fullscreenElement;
      if (this.fsIcon) this.fsIcon.innerText = isFs ? '🗗' : '⛶';
      if (this.playerCard) {
        this.playerCard.classList.toggle('fullscreen-mode', isFs);
      }
    });

    // Double-tap / double-click to seek 10s
    if (this.stageBox) {
      this.stageBox.addEventListener('dblclick', (e) => {
        if (!this.videoEl || this.videoEl.style.display === 'none') return;

        const rect = this.stageBox.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const width = rect.width;

        if (clickX < width / 2) {
          this.videoEl.currentTime = Math.max(0, this.videoEl.currentTime - 10);
          this.showSeekRipple('left');
        } else {
          this.videoEl.currentTime = Math.min(this.videoEl.duration || 99999, this.videoEl.currentTime + 10);
          this.showSeekRipple('right');
        }
      });
    }

    // Comprehensive Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (!this.modalPlayer || !this.modalPlayer.classList.contains('active')) return;

      switch (e.key) {
        case 'Escape':
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            this.closePlayer();
          }
          break;

        case ' ': // Space: Play / Pause
          e.preventDefault();
          if (this.videoEl && this.videoEl.style.display !== 'none') {
            this.videoEl.paused ? this.videoEl.play() : this.videoEl.pause();
          } else if (this.audioEl && this.currentMediaType === 'audio') {
            this.audioEl.paused ? this.audioEl.play() : this.audioEl.pause();
          }
          break;

        case 'f':
        case 'F': // F: Fullscreen
          e.preventDefault();
          this.toggleFullscreen();
          break;

        case 'p':
        case 'P': // P: Picture-in-Picture
          e.preventDefault();
          this.togglePiP();
          break;

        case 'n':
        case 'N': // N: Next Video
          e.preventDefault();
          this.playNext();
          break;

        case 'b':
        case 'B': // B: Previous Video
          e.preventDefault();
          this.playPrev();
          break;

        case 'ArrowRight': // Seek forward 10s
          if (this.videoEl && this.videoEl.style.display !== 'none') {
            e.preventDefault();
            this.videoEl.currentTime = Math.min(this.videoEl.duration || 99999, this.videoEl.currentTime + 10);
            this.showSeekRipple('right');
          }
          break;

        case 'ArrowLeft': // Seek backward 10s
          if (this.videoEl && this.videoEl.style.display !== 'none') {
            e.preventDefault();
            this.videoEl.currentTime = Math.max(0, this.videoEl.currentTime - 10);
            this.showSeekRipple('left');
          }
          break;

        case 'ArrowUp': // Volume Up
          e.preventDefault();
          if (this.videoEl) this.videoEl.volume = Math.min(1.0, this.videoEl.volume + 0.1);
          if (this.audioEl) this.audioEl.volume = Math.min(1.0, this.audioEl.volume + 0.1);
          break;

        case 'ArrowDown': // Volume Down
          e.preventDefault();
          if (this.videoEl) this.videoEl.volume = Math.max(0.0, this.videoEl.volume - 0.1);
          if (this.audioEl) this.audioEl.volume = Math.max(0.0, this.audioEl.volume - 0.1);
          break;

        case 'm':
        case 'M': // Mute / Unmute
          if (this.videoEl) this.videoEl.muted = !this.videoEl.muted;
          if (this.audioEl) this.audioEl.muted = !this.audioEl.muted;
          break;
      }
    });
  }

  showSeekRipple(side) {
    const el = side === 'left' ? this.seekLeft : this.seekRight;
    if (!el) return;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 500);
  }

  cycleAspectMode() {
    if (this.aspectMode === 'auto') {
      this.setAspectMode('vertical');
    } else if (this.aspectMode === 'vertical') {
      this.setAspectMode('fill');
    } else {
      this.setAspectMode('auto');
    }
  }

  setAspectMode(mode) {
    this.aspectMode = mode;
    if (!this.stageBox) return;

    this.stageBox.classList.remove('vertical-shorts-mode', 'fill-screen-mode');

    if (mode === 'vertical') {
      this.stageBox.classList.add('vertical-shorts-mode');
      if (this.aspectIcon) this.aspectIcon.innerText = '📱';
      if (window.garvinixApp) window.garvinixApp.showToast('📱 Switched to 9:16 Vertical Shorts Mode');
    } else if (mode === 'fill') {
      this.stageBox.classList.add('fill-screen-mode');
      if (this.aspectIcon) this.aspectIcon.innerText = '🔲';
      if (window.garvinixApp) window.garvinixApp.showToast('🔲 Switched to Expanded Fill Screen');
    } else {
      if (this.aspectIcon) this.aspectIcon.innerText = '📺';
      if (window.garvinixApp) window.garvinixApp.showToast('📺 Switched to Standard Fit Mode');
    }
  }

  async toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        if (this.modalPlayer && this.modalPlayer.requestFullscreen) {
          await this.modalPlayer.requestFullscreen();
        } else if (this.videoEl && this.videoEl.requestFullscreen) {
          await this.videoEl.requestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch (e) {
      if (this.playerCard) {
        this.playerCard.classList.toggle('fullscreen-mode');
      }
    }
  }

  async togglePiP() {
    if (!this.videoEl || this.videoEl.style.display === 'none') {
      if (window.garvinixApp) window.garvinixApp.showToast('ℹ️ Picture-in-Picture is active for downloaded vault videos.');
      return;
    }

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await this.videoEl.requestPictureInPicture();
      }
    } catch (e) {
      console.warn('PiP error', e);
    }
  }

  // =========================================================================
  // PLAYLIST QUEUE & AVIOC CINEMA DOCKED CAROUSEL
  // =========================================================================

  setPlaylist(items = [], currentIndex = 0) {
    this.currentPlaylist = items || [];
    this.currentIndex = currentIndex >= 0 && currentIndex < this.currentPlaylist.length ? currentIndex : 0;
    this.updateQueueUI();
    this.renderDock();
  }

  hasNextItem() {
    return this.currentPlaylist.length > 0 && this.currentIndex < this.currentPlaylist.length - 1;
  }

  hasPrevItem() {
    return this.currentPlaylist.length > 0 && this.currentIndex > 0;
  }

  updateQueueUI() {
    if (this.queueBadge) {
      if (this.currentPlaylist.length > 1) {
        this.queueBadge.style.display = 'inline-block';
        this.queueBadge.innerText = `${this.currentIndex + 1} / ${this.currentPlaylist.length}`;
      } else {
        this.queueBadge.style.display = 'none';
      }
    }

    if (this.btnPrev) {
      this.btnPrev.disabled = !this.hasPrevItem();
    }
    if (this.btnNext) {
      this.btnNext.disabled = !this.hasNextItem() && this.currentPlaylist.length <= 1;
    }
  }

  renderDock() {
    if (!this.dockEl || !this.dockList) return;

    if (!this.currentPlaylist || this.currentPlaylist.length <= 1) {
      this.dockEl.style.display = 'none';
      return;
    }

    this.dockEl.style.display = 'block';
    if (this.dockCount) {
      this.dockCount.innerText = `${this.currentPlaylist.length} queued`;
    }

    this.dockList.innerHTML = this.currentPlaylist.map((item, idx) => {
      const isCurrent = idx === this.currentIndex;
      const isLocal = !!item.filename;
      const title = this.escapeHtml(item.title || item.filename || `Item ${idx + 1}`);
      const duration = this.escapeHtml(item.duration_str || (isLocal ? (item.ext?.toUpperCase() || 'FILE') : 'HD'));
      const thumbUrl = item.thumbnail ? this.escapeHtml(item.thumbnail) : '';

      if (isLocal) {
        const icon = item.media_type === 'video' ? '🎬' : '🎵';
        return `
          <button class="pthumb local-pthumb" data-idx="${idx}" aria-current="${isCurrent}" title="${title}">
            <span class="pthumb-badge">${duration}</span>
            <span class="pthumb-icon">${icon}</span>
            <span class="pthumb-title">${title}</span>
          </button>
        `;
      } else {
        const bgStyle = thumbUrl ? `style="background-image: url('${thumbUrl}');"` : '';
        return `
          <button class="pthumb" data-idx="${idx}" aria-current="${isCurrent}" title="${title}" ${bgStyle}>
            <span class="pthumb-badge">${duration}</span>
            <span class="pthumb-title">${title}</span>
          </button>
        `;
      }
    }).join('');

    // Attach click handlers to docked thumbnail cards
    this.dockList.querySelectorAll('.pthumb').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetIdx = parseInt(btn.getAttribute('data-idx') || '0', 10);
        this.playItemAtIndex(targetIdx);
      });
    });

    // Auto-scroll active card into center view (Avioc Cinema style)
    requestAnimationFrame(() => {
      const activeEl = this.dockList.querySelector('[aria-current="true"]');
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      }
    });
  }

  playNext() {
    this.cancelUpNextCountdown();
    if (this.currentPlaylist.length === 0) return;

    if (this.currentIndex < this.currentPlaylist.length - 1) {
      this.playItemAtIndex(this.currentIndex + 1);
    } else {
      // Loop to beginning of playlist
      this.playItemAtIndex(0);
    }
  }

  playPrev() {
    this.cancelUpNextCountdown();
    if (this.currentPlaylist.length === 0) return;

    if (this.currentIndex > 0) {
      this.playItemAtIndex(this.currentIndex - 1);
    } else {
      this.playItemAtIndex(this.currentPlaylist.length - 1);
    }
  }

  playPlaylist(items, startIndex = 0) {
    if (!items || !items.length) return;
    this.currentPlaylist = items;
    this.currentIndex = startIndex;
    this.playItemAtIndex(startIndex);
  }

  async saveCurrentQueueAsPlaylist() {
    if (!this.currentPlaylist || this.currentPlaylist.length === 0) {
      if (window.garvinixApp) window.garvinixApp.showToast('⚠️ No items in current queue to save.');
      return;
    }

    const defaultName = this.currentPlaylist[0]?.title 
      ? `Playlist: ${this.currentPlaylist[0].title.slice(0, 24)}...` 
      : `Playlist (${this.currentPlaylist.length} tracks)`;

    const playlistName = prompt('Enter a name for this playlist:', defaultName);
    if (!playlistName || !playlistName.trim()) return;

    try {
      const res = await fetch('/api/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: playlistName.trim(),
          items: this.currentPlaylist
        })
      });
      const data = await res.json();
      if (data.success) {
        if (window.garvinixApp) {
          window.garvinixApp.showToast(`💾 Saved playlist "${playlistName}" for future openings!`);
          window.garvinixApp.loadSavedPlaylists();
        }
      }
    } catch (err) {
      console.error('Failed to save playlist:', err);
    }
  }

  playItemAtIndex(index) {
    if (index < 0 || index >= this.currentPlaylist.length) return;
    this.currentIndex = index;
    const item = this.currentPlaylist[index];
    this.videoCompletedHandled = false;

    // Persist current session for future app openings
    try {
      localStorage.setItem('garvinix_last_session', JSON.stringify({
        playlist: this.currentPlaylist,
        index: this.currentIndex,
        item: item,
        timestamp: Date.now()
      }));
    } catch (_) {}

    if (item.filename) {
      this.playFile(item.media_type, item.filename, this.currentPlaylist, index);
    } else {
      this.playOnlineVideo(item.id, item.title, item.url, this.currentPlaylist, index);
    }
  }

  startUpNextCountdown() {
    if (!this.hasNextItem()) {
      if (this.currentPlaylist.length > 1) {
        // Loop back to first item when reaching end of queue
        this.playItemAtIndex(0);
      }
      return;
    }

    const nextItem = this.currentPlaylist[this.currentIndex + 1];
    if (!nextItem || !this.upNextOverlay) return;

    this.cancelUpNextCountdown();

    if (this.upNextTitle) this.upNextTitle.innerText = nextItem.title || nextItem.filename || 'Next Video';
    if (this.upNextUploader) this.upNextUploader.innerText = nextItem.uploader || (nextItem.filename ? 'Local Vault' : 'Channel');
    if (this.upNextThumb) {
      if (nextItem.thumbnail) {
        this.upNextThumb.src = nextItem.thumbnail;
        this.upNextThumb.style.display = 'block';
      } else {
        this.upNextThumb.style.display = 'none';
      }
    }

    this.countdownSeconds = 3;
    if (this.upNextCountdownNum) this.upNextCountdownNum.innerText = this.countdownSeconds;
    this.upNextOverlay.style.display = 'block';

    // Wake player so user sees the countdown overlay
    if (this.modalPlayer) {
      this.modalPlayer.classList.remove('idle');
    }

    this.countdownTimer = setInterval(() => {
      this.countdownSeconds--;
      if (this.upNextCountdownNum) this.upNextCountdownNum.innerText = this.countdownSeconds;

      if (this.countdownSeconds <= 0) {
        this.cancelUpNextCountdown();
        this.playNext();
      }
    }, 1000);
  }

  cancelUpNextCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.upNextOverlay) {
      this.upNextOverlay.style.display = 'none';
    }
  }

  // =========================================================================
  // ONLINE & LOCAL PLAYBACK
  // =========================================================================

  playOnlineVideo(videoId, title, webpageUrl, playlist = null, index = -1) {
    this.cancelUpNextCountdown();
    this.currentOnlineUrl = webpageUrl || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : '');
    this.currentMediaType = 'video';
    this.currentPlayingFile = null;

    if (playlist && Array.isArray(playlist)) {
      this.currentPlaylist = playlist;
      this.currentIndex = index >= 0 ? index : playlist.findIndex(x => (x.id === videoId || x.url === webpageUrl));
    }
    this.updateQueueUI();
    this.renderDock();

    // Stop local video & audio
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      this.videoEl.load();
      this.videoEl.style.display = 'none';
    }
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
    }
    if (this.audioVisualizer) {
      this.audioVisualizer.style.display = 'none';
    }

    const cleanId = this.extractYouTubeId(videoId || webpageUrl);
    this.currentYtId = cleanId;

    if (this.iframeEl) {
      this.iframeEl.style.display = 'block';
      if (cleanId) {
        // ALWAYS set iframe.src directly so video loads and plays INSTANTLY!
        this.iframeEl.src = `https://www.youtube-nocookie.com/embed/${cleanId}?autoplay=1&enablejsapi=1&rel=0&modestbranding=1&playsinline=1`;
        this.hookYouTubePlayer(cleanId);
      } else if (webpageUrl) {
        this.iframeEl.src = webpageUrl;
      }
    }

    if (this.playerTitle) {
      this.playerTitle.innerHTML = `<span>▶</span> ${this.escapeHtml(title || 'Online Video')}`;
    }

    if (this.formatPill) {
      this.formatPill.innerText = 'ONLINE HD';
    }

    if (this.playerMeta) {
      this.playerMeta.innerText = `Online Stream • Press 'N' for Next, 'F' for Fullscreen`;
    }

    if (this.btnOpenFile) {
      this.btnOpenFile.style.display = 'none';
    }

    if (this.btnPlayerDownload) {
      this.btnPlayerDownload.style.display = 'inline-flex';
    }

    if (this.modalPlayer) {
      this.modalPlayer.classList.add('active');
      this.modalPlayer.classList.remove('idle');
      if (this.wakePlayer) this.wakePlayer();
    }

    this.videoCompletedHandled = false;
    this.resetDownloadButtonState();
    this.startCompletionWatcher();
  }

  hookYouTubePlayer(videoId) {
    if (!window.YT || !window.YT.Player) return;

    try {
      if (this.ytPlayer && typeof this.ytPlayer.loadVideoById === 'function') {
        try {
          this.ytPlayer.loadVideoById(videoId);
          return;
        } catch (e) {
          this.ytPlayer = null;
        }
      }

      this.ytPlayer = new window.YT.Player('cinema-iframe-element', {
        events: {
          onReady: (event) => {
            try { event.target.playVideo(); } catch (e) {}
          },
          onStateChange: (event) => {
            // YT.PlayerState.ENDED is 0
            if (event.data === (window.YT?.PlayerState?.ENDED ?? 0)) {
              this.onVideoCompleted('yt_api_ended');
            }
          }
        }
      });
    } catch (err) {
      console.warn('YouTube API hook note:', err);
    }
  }

  playYouTubeVideoById(videoId) {
    if (this.iframeEl) {
      this.iframeEl.style.display = 'block';
      this.iframeEl.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&enablejsapi=1&rel=0&modestbranding=1&playsinline=1`;
    }
    this.hookYouTubePlayer(videoId);
  }

  extractYouTubeId(urlOrId) {
    if (!urlOrId) return '';
    if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) return urlOrId;
    const match = urlOrId.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : '';
  }

  playFile(mediaType, filename, playlist = null, index = -1) {
    this.cancelUpNextCountdown();
    this.currentPlayingFile = filename;
    this.currentMediaType = mediaType;
    this.currentOnlineUrl = null;

    if (playlist && Array.isArray(playlist)) {
      this.currentPlaylist = playlist;
      this.currentIndex = index >= 0 ? index : playlist.findIndex(x => x.filename === filename);
    }
    this.updateQueueUI();
    this.renderDock();

    // Stop YouTube playback
    if (this.ytPlayer && typeof this.ytPlayer.stopVideo === 'function') {
      try { this.ytPlayer.stopVideo(); } catch (e) {}
    }
    if (this.iframeEl) {
      this.iframeEl.removeAttribute('src');
      this.iframeEl.style.display = 'none';
    }

    const streamUrl = `/stream/${mediaType}/${encodeURIComponent(filename)}`;

    if (this.playerTitle) {
      this.playerTitle.innerHTML = `<span>${mediaType === 'video' ? '🎬' : '🎵'}</span> ${this.escapeHtml(filename)}`;
    }

    if (this.formatPill) {
      this.formatPill.innerText = mediaType === 'video' ? 'VAULT VIDEO' : 'VAULT AUDIO';
    }

    if (this.playerMeta) {
      this.playerMeta.innerText = `${mediaType.toUpperCase()} Vault Stream • Press 'N' for Next, 'F' for Fullscreen`;
    }

    if (this.btnOpenFile) {
      this.btnOpenFile.style.display = 'inline-flex';
    }

    if (this.btnPlayerDownload) {
      this.btnPlayerDownload.style.display = 'none';
    }

    if (mediaType === 'video') {
      if (this.audioVisualizer) this.audioVisualizer.style.display = 'none';
      if (this.audioEl) {
        this.audioEl.pause();
        this.audioEl.removeAttribute('src');
      }

      if (this.videoEl) {
        this.videoEl.style.display = 'block';
        this.videoEl.src = streamUrl;
        this.videoEl.play().catch(e => console.log('Autoplay deferred:', e));
      }
    } else {
      // Audio / MP3 Mode
      if (this.videoEl) {
        this.videoEl.pause();
        this.videoEl.removeAttribute('src');
        this.videoEl.style.display = 'none';
      }

      if (this.audioVisualizer) this.audioVisualizer.style.display = 'flex';
      if (this.audioEl) {
        this.audioEl.src = streamUrl;
        this.audioEl.play().catch(e => console.log('Autoplay deferred:', e));
      }
    }

    if (this.modalPlayer) {
      this.modalPlayer.classList.add('active');
      this.modalPlayer.classList.remove('idle');
      if (this.wakePlayer) this.wakePlayer();
    }

    this.videoCompletedHandled = false;
    this.resetDownloadButtonState();
    this.startCompletionWatcher();
  }

  closePlayer() {
    this.cancelUpNextCountdown();
    this.stopCompletionWatcher();
    this.hideDownloadProgress();
    this.resetDownloadButtonState();

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.ytPlayer && typeof this.ytPlayer.stopVideo === 'function') {
      try { this.ytPlayer.stopVideo(); } catch (e) {}
    }
    if (this.iframeEl) {
      this.iframeEl.removeAttribute('src');
      this.iframeEl.style.display = 'none';
    }
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      this.videoEl.load();
    }
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    if (this.playerCard) {
      this.playerCard.classList.remove('fullscreen-mode');
    }
    if (this.modalPlayer) {
      this.modalPlayer.classList.remove('active', 'idle');
    }
    this.currentOnlineUrl = null;
    this.currentPlayingFile = null;
  }

  isOpen() {
    return !!(this.modalPlayer && this.modalPlayer.classList.contains('active'));
  }

  // =========================================================================
  // COMPLETION WATCHER WORKER (POLLED LISTENER FOR INSTANT AUTO-NEXT)
  // =========================================================================

  startCompletionWatcher() {
    this.stopCompletionWatcher();
    this.videoCompletedHandled = false;

    this.completionWatcherInterval = setInterval(() => {
      if (!this.isOpen()) return;
      if (this.videoCompletedHandled) return;

      // 1. Check Local Video Element
      if (this.videoEl && this.videoEl.style.display !== 'none' && this.videoEl.src) {
        if (this.videoEl.ended) {
          this.onVideoCompleted('local_video_ended');
          return;
        }
        if (this.videoEl.duration && this.videoEl.duration > 0) {
          const remaining = this.videoEl.duration - this.videoEl.currentTime;
          if (remaining <= 0.4 && this.videoEl.currentTime > 1) {
            this.onVideoCompleted('local_video_near_end');
            return;
          }
        }
      }

      // 2. Check Local Audio Element
      if (this.audioEl && this.audioVisualizer && this.audioVisualizer.style.display !== 'none' && this.audioEl.src) {
        if (this.audioEl.ended) {
          this.onVideoCompleted('local_audio_ended');
          return;
        }
        if (this.audioEl.duration && this.audioEl.duration > 0) {
          const remaining = this.audioEl.duration - this.audioEl.currentTime;
          if (remaining <= 0.4 && this.audioEl.currentTime > 1) {
            this.onVideoCompleted('local_audio_near_end');
            return;
          }
        }
      }

      // 3. Check YouTube Embed Player
      if (this.ytPlayer && typeof this.ytPlayer.getPlayerState === 'function') {
        try {
          const state = this.ytPlayer.getPlayerState();
          // YT.PlayerState.ENDED is 0
          if (state === 0) {
            this.onVideoCompleted('yt_state_0');
            return;
          }
          if (typeof this.ytPlayer.getCurrentTime === 'function' && typeof this.ytPlayer.getDuration === 'function') {
            const cur = this.ytPlayer.getCurrentTime();
            const dur = this.ytPlayer.getDuration();
            if (dur > 0 && cur > 1 && (dur - cur <= 0.6)) {
              this.onVideoCompleted('yt_near_end');
              return;
            }
          }
        } catch (e) {
          // Cross-origin iframe or transient error
        }
      }
    }, 400);
  }

  stopCompletionWatcher() {
    if (this.completionWatcherInterval) {
      clearInterval(this.completionWatcherInterval);
      this.completionWatcherInterval = null;
    }
  }

  onVideoCompleted(source = 'unknown') {
    if (this.videoCompletedHandled) return;
    this.videoCompletedHandled = true;
    console.log(`[Garvinix Watcher] Video completion detected via: ${source} (autoPlayNext=${this.autoPlayNext})`);

    if (this.autoPlayNext && (this.hasNextItem() || this.currentPlaylist.length > 1)) {
      this.startUpNextCountdown();
    }
  }

  // =========================================================================
  // BACKGROUND IN-PLAYER DOWNLOAD & PLAYBACK RESUME
  // =========================================================================

  resumePlayback() {
    try {
      if (this.videoEl && this.videoEl.style.display !== 'none' && this.videoEl.paused) {
        this.videoEl.play().catch(e => console.log('Resume video note:', e));
      } else if (this.audioEl && this.audioVisualizer && this.audioVisualizer.style.display !== 'none' && this.audioEl.paused) {
        this.audioEl.play().catch(e => console.log('Resume audio note:', e));
      } else if (this.ytPlayer && typeof this.ytPlayer.playVideo === 'function') {
        this.ytPlayer.playVideo();
      }
    } catch (e) {
      console.warn('Resume playback note:', e);
    }
  }

  resetDownloadButtonState() {
    if (this.btnPlayerDownload) {
      this.btnPlayerDownload.innerHTML = '<span>⚡</span> Download';
      this.btnPlayerDownload.disabled = false;
    }
  }

  trackDownloadProgress(taskId, title, quality) {
    this.currentDownloadTaskId = taskId;
    if (!this.dlProgressBox) return;

    if (this.dlProgressTitle) this.dlProgressTitle.innerText = title || 'Downloading video...';
    if (this.dlProgressBadge) this.dlProgressBadge.innerText = quality || 'HD';
    if (this.dlProgressMeta) this.dlProgressMeta.innerText = '0% • Connecting...';
    if (this.dlProgressBarFill) this.dlProgressBarFill.style.width = '0%';

    this.dlProgressBox.classList.remove('completed', 'failed');
    this.dlProgressBox.style.display = 'block';

    if (this.modalPlayer) {
      this.modalPlayer.classList.remove('idle');
    }
  }

  updateDownloadProgress(task) {
    if (!this.dlProgressBox || !this.currentDownloadTaskId) return;
    if (task.id !== this.currentDownloadTaskId) return;

    const percent = Math.min(100, Math.max(0, task.percent || 0));
    if (this.dlProgressBarFill) {
      this.dlProgressBarFill.style.width = `${percent}%`;
    }

    if (task.status === 'completed') {
      if (this.dlProgressTitle) this.dlProgressTitle.innerText = '✓ Download Complete! Saved to Vault.';
      if (this.dlProgressMeta) this.dlProgressMeta.innerText = '100% • Finished';
      if (this.dlProgressBarFill) this.dlProgressBarFill.style.width = '100%';
      this.dlProgressBox.classList.add('completed');

      setTimeout(() => {
        if (this.currentDownloadTaskId === task.id) {
          this.hideDownloadProgress();
        }
      }, 5000);
    } else if (task.status === 'error') {
      if (this.dlProgressTitle) this.dlProgressTitle.innerText = '❌ Download Failed';
      if (this.dlProgressMeta) this.dlProgressMeta.innerText = task.error || 'Failed';
      this.dlProgressBox.classList.add('failed');
    } else {
      const speedStr = task.speed ? `${task.speed} • ` : '';
      const etaStr = task.eta ? `ETA: ${task.eta}` : '';
      if (this.dlProgressMeta) {
        this.dlProgressMeta.innerText = `${percent.toFixed(1)}% • ${speedStr}${etaStr}`.replace(/ • $/, '');
      }
    }
  }

  hideDownloadProgress() {
    this.currentDownloadTaskId = null;
    if (this.dlProgressBox) {
      this.dlProgressBox.style.display = 'none';
      this.dlProgressBox.classList.remove('completed', 'failed');
    }
  }

  async loadLibrary() {
    try {
      const res = await fetch('/api/library');
      if (!res.ok) return;
      const data = await res.json();
      this.libraryFiles = data.files || [];

      // Update badge count
      const badgeCount = document.getElementById('header-library-count');
      if (badgeCount) {
        badgeCount.innerText = this.libraryFiles.length;
      }

      this.renderLibrary();
    } catch (err) {
      console.error('Failed to load library', err);
    }
  }

  renderLibrary() {
    const grid = document.getElementById('library-grid-container');
    if (!grid) return;

    let filtered = this.libraryFiles;
    if (this.currentFilter === 'video') {
      filtered = filtered.filter(f => f.media_type === 'video');
    } else if (this.currentFilter === 'audio') {
      filtered = filtered.filter(f => f.media_type === 'audio');
    }

    if (!filtered || filtered.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="empty-icon">📁</div>
          <h3>Your Library is Empty</h3>
          <p>Downloaded videos and songs will appear here. Start downloading in the Search tab!</p>
          <button class="btn-accent-pill" onclick="window.garvinixApp.switchTab('tab-search')">
            + Find Media to Download
          </button>
        </div>
      `;
      return;
    }

    grid.innerHTML = filtered.map((file, idx) => {
      const isVideo = file.media_type === 'video';
      const icon = isVideo ? '🎬' : '🎵';
      const badgeClass = isVideo ? '' : 'audio';

      return `
        <div class="library-card">
          <div class="lib-card-top">
            <div class="lib-media-icon ${badgeClass}">${icon}</div>
            <div class="lib-meta-info">
              <div class="lib-filename" title="${this.escapeHtml(file.filename)}">
                ${this.escapeHtml(file.filename)}
              </div>
              <div class="lib-sub-info">
                <span>${file.size_str}</span> • <span>${file.ext.toUpperCase()}</span> • <span>${file.date_str}</span>
              </div>
            </div>
          </div>
          <div class="lib-actions-bar">
            <button class="btn-lib-play" onclick="window.garvinixPlayer.playFile('${file.media_type}', '${this.escapeHtml(file.filename)}', window.garvinixPlayer.libraryFiles, ${idx})">
              ▶ Play Now
            </button>
            <div style="display: flex; align-items: center; gap: 4px;">
              <a href="${file.stream_url}" download="${this.escapeHtml(file.filename)}" class="btn-secondary-sm" style="text-decoration: none; padding: 6px 10px;" title="Save / Download File">
                ⬇️
              </a>
              <button class="btn-lib-del" onclick="window.garvinixPlayer.deleteFile('${file.media_type}', '${this.escapeHtml(file.filename)}')" title="Delete from disk">
                🗑️
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  async deleteFile(mediaType, filename) {
    if (!confirm(`Are you sure you want to permanently delete "${filename}"?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/library/${mediaType}/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        if (window.garvinixApp) window.garvinixApp.showToast(`🗑️ Deleted: ${filename}`);
        this.loadLibrary();
      } else {
        alert(`Error deleting file: ${data.error}`);
      }
    } catch (err) {
      console.error(err);
      alert('Could not delete file.');
    }
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
  window.garvinixPlayer = new GarvinixPlayer();
});
