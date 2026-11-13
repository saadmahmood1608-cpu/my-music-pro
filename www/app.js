(() => {
  'use strict';

  const DB_NAME = 'MyMusicPro_UltraDB_v1';
  const META_STORE = 'meta';
  const BLOB_STORE = 'audio_blobs';
  const ROW_HEIGHT = 60;

  let db = null;
  let allTracks = [];
  let visibleTracks = [];
  let currentTrackId = null;
  let activeObjectUrl = null;
  let isShuffle = false;
  let isRepeat = false;
  let isImporting = false;
  let sleepTimerId = null;
  let searchDebounce = null;
  let audioCtx = null;
  let bassFilter = null;
  let trebleFilter = null;

  const fileInput = document.getElementById('fileInput');
  const searchInput = document.getElementById('searchInput');
  const sortSelect = document.getElementById('sortSelect');
  const statusBar = document.getElementById('statusBar');
  const storageStats = document.getElementById('storageStats');
  const scrollViewport = document.getElementById('scrollViewport');
  const virtualSpacer = document.getElementById('virtualSpacer');
  const virtualContent = document.getElementById('virtualContent');
  const emptyState = document.getElementById('emptyState');
  const nowPlaying = document.getElementById('nowPlaying');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const shuffleBtn = document.getElementById('shuffleBtn');
  const repeatBtn = document.getElementById('repeatBtn');
  const seekBar = document.getElementById('seekBar');
  const currentTimeEl = document.getElementById('currentTime');
  const durationEl = document.getElementById('duration');
  const eqSelect = document.getElementById('eqSelect');
  const speedSelect = document.getElementById('speedSelect');
  const sleepSelect = document.getElementById('sleepSelect');
  const audio = document.getElementById('audio');

  function showStatus(msg, autoClearMs = 0) {
    statusBar.textContent = msg;
    statusBar.classList.remove('hidden');
    if (autoClearMs > 0) {
      setTimeout(() => statusBar.classList.add('hidden'), autoClearMs);
    }
  }

  function hideStatus() {
    statusBar.classList.add('hidden');
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 MB';
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  async function requestPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        await navigator.storage.persist();
      } catch (_) {}
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: 'id', autoIncrement: true });
        }
        if (!database.objectStoreNames.contains(BLOB_STORE)) {
          database.createObjectStore(BLOB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function loadAllMetadata() {
    return new Promise((resolve) => {
      if (!db) return resolve([]);
      const tx = db.transaction(META_STORE, 'readonly');
      const store = tx.objectStore(META_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        allTracks = req.result || [];
        updateStats();
        applyFilterAndSort();
        resolve(allTracks);
      };
      req.onerror = () => resolve([]);
    });
  }

  function updateStats() {
    const totalBytes = allTracks.reduce((acc, t) => acc + (t.size || 0), 0);
    storageStats.textContent = `${allTracks.length} track${allTracks.length === 1 ? '' : 's'} • ${formatBytes(totalBytes)}`;
  }

  function applyFilterAndSort() {
    const query = searchInput.value.trim().toLowerCase();
    const sortBy = sortSelect.value;

    let list = allTracks.filter((t) => {
      if (sortBy === 'fav' && !t.fav) return false;
      if (query && !t.name.toLowerCase().includes(query)) return false;
      return true;
    });

    if (sortBy === 'az') {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === 'za') {
      list.sort((a, b) => b.name.localeCompare(a.name));
    } else {
      list.sort((a, b) => b.id - a.id);
    }

    visibleTracks = list;
    renderVirtualList();
  }

  function renderVirtualList() {
    const total = visibleTracks.length;
    if (total === 0) {
      virtualSpacer.style.height = '0px';
      virtualContent.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    virtualSpacer.style.height = `${total * ROW_HEIGHT}px`;

    const scrollTop = scrollViewport.scrollTop;
    const viewportHeight = scrollViewport.clientHeight || 500;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
    const endIdx = Math.min(total, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + 5);

    virtualContent.style.transform = `translateY(${startIdx * ROW_HEIGHT}px)`;

    let html = '';
    for (let i = startIdx; i < endIdx; i++) {
      const t = visibleTracks[i];
      const isActive = t.id === currentTrackId;
      html += `
        <div class="song-row ${isActive ? 'active' : ''}" data-id="${t.id}">
          <div class="song-meta">
            <div class="song-title">${escapeHtml(t.name)}</div>
            <div class="song-sub">${formatBytes(t.size)}</div>
          </div>
          <div class="row-actions">
            <button type="button" class="icon-btn ${t.fav ? 'fav-on' : ''}" data-action="fav" data-id="${t.id}">${t.fav ? '★' : '☆'}</button>
            <button type="button" class="icon-btn" data-action="del" data-id="${t.id}">✕</button>
          </div>
        </div>
      `;
    }
    virtualContent.innerHTML = html;
  }

  function saveSingleTrack(file) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([META_STORE, BLOB_STORE], 'readwrite');
      const metaStore = tx.objectStore(META_STORE);
      const blobStore = tx.objectStore(BLOB_STORE);

      const cleanName = file.name.replace(/\.[^/.]+$/, '') || 'Untitled Track';
      const metaReq = metaStore.add({
        name: cleanName,
        size: file.size || 0,
        type: file.type || 'audio/mpeg',
        fav: false,
        addedAt: Date.now()
      });

      metaReq.onsuccess = (e) => {
        const newId = e.target.result;
        blobStore.put({ id: newId, blob: file });
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length || isImporting) return;

    isImporting = true;
    let imported = 0;
    let failed = 0;

    for (let i = 0; i < files.length; i++) {
      showStatus(`Importing ${i + 1} of ${files.length}...`);
      try {
        await saveSingleTrack(files[i]);
        imported++;
        if (imported % 15 === 0) {
          await loadAllMetadata();
          await new Promise((r) => setTimeout(r, 15));
        }
      } catch (err) {
        failed++;
        if (err && err.name === 'QuotaExceededError') {
          showStatus('iPhone storage limit reached. Free up space to add more.', 5000);
          break;
        }
      }
    }

    await loadAllMetadata();
    isImporting = false;
    if (failed === 0) {
      showStatus(`Added ${imported} song${imported === 1 ? '' : 's'} offline.`, 2500);
    } else {
      showStatus(`Added ${imported} songs (${failed} skipped).`, 4000);
    }
  });

  function getTrackBlob(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_STORE, 'readonly');
      const req = tx.objectStore(BLOB_STORE).get(id);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function playTrackById(id) {
    const meta = allTracks.find((t) => t.id === id);
    if (!meta) return;

    try {
      const blob = await getTrackBlob(id);
      if (!blob) {
        showStatus('Audio file missing from storage.', 3000);
        return;
      }

      if (activeObjectUrl) {
        URL.revokeObjectURL(activeObjectUrl);
        activeObjectUrl = null;
      }

      audio.pause();
      activeObjectUrl = URL.createObjectURL(blob);
      audio.src = activeObjectUrl;
      audio.playbackRate = parseFloat(speedSelect.value) || 1;

      currentTrackId = id;
      nowPlaying.textContent = meta.name;
      renderVirtualList();

      setupWebAudioEQ();
      if (audioCtx && audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      await audio.play();
      playPauseBtn.textContent = '⏸';
      updateMediaSession(meta.name);
    } catch (err) {
      playPauseBtn.textContent = '▶';
      showStatus('Tap Play to start audio.', 2500);
    }
  }

  function toggleFavorite(id) {
    const track = allTracks.find((t) => t.id === id);
    if (!track) return;
    track.fav = !track.fav;
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(track);
    tx.oncomplete = () => applyFilterAndSort();
  }

  function deleteTrack(id) {
    const tx = db.transaction([META_STORE, BLOB_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(id);
    tx.objectStore(BLOB_STORE).delete(id);

    tx.oncomplete = () => {
      if (currentTrackId === id) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        if (activeObjectUrl) {
          URL.revokeObjectURL(activeObjectUrl);
          activeObjectUrl = null;
        }
        currentTrackId = null;
        nowPlaying.textContent = 'Select a song to play';
        playPauseBtn.textContent = '▶';
      }
      loadAllMetadata();
    };
  }

  virtualContent.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      e.stopPropagation();
      const id = Number(actionBtn.dataset.id);
      if (actionBtn.dataset.action === 'fav') toggleFavorite(id);
      if (actionBtn.dataset.action === 'del') deleteTrack(id);
      return;
    }

    const row = e.target.closest('.song-row');
    if (row) {
      playTrackById(Number(row.dataset.id));
    }
  });

  function togglePlay() {
    if (!audio.src) {
      if (visibleTracks.length > 0) playTrackById(visibleTracks[0].id);
      return;
    }
    if (audio.paused) {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      audio.play().then(() => { playPauseBtn.textContent = '⏸'; }).catch(() => {});
    } else {
      audio.pause();
      playPauseBtn.textContent = '▶';
    }
  }

  function playNext() {
    const list = visibleTracks.length ? visibleTracks : allTracks;
    if (!list.length) return;

    if (isShuffle && list.length > 1) {
      let randIdx;
      do {
        randIdx = Math.floor(Math.random() * list.length);
      } while (list[randIdx].id === currentTrackId);
      playTrackById(list[randIdx].id);
      return;
    }

    const idx = list.findIndex((t) => t.id === currentTrackId);
    const nextIdx = idx === -1 ? 0 : (idx + 1) % list.length;
    playTrackById(list[nextIdx].id);
  }

  function playPrev() {
    const list = visibleTracks.length ? visibleTracks : allTracks;
    if (!list.length) return;

    if (audio.currentTime > 4) {
      audio.currentTime = 0;
      return;
    }

    const idx = list.findIndex((t) => t.id === currentTrackId);
    const prevIdx = idx <= 0 ? list.length - 1 : idx - 1;
    playTrackById(list[prevIdx].id);
  }

  function setupWebAudioEQ() {
    if (audioCtx) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioCtx = new AudioContextClass();
      const source = audioCtx.createMediaElementSource(audio);

      bassFilter = audioCtx.createBiquadFilter();
      bassFilter.type = 'lowshelf';
      bassFilter.frequency.value = 180;

      trebleFilter = audioCtx.createBiquadFilter();
      trebleFilter.type = 'highshelf';
      trebleFilter.frequency.value = 3200;

      source.connect(bassFilter);
      bassFilter.connect(trebleFilter);
      trebleFilter.connect(audioCtx.destination);
      applyEQPreset(eqSelect.value);
    } catch (_) {}
  }

  function applyEQPreset(preset) {
    if (!bassFilter || !trebleFilter) return;
    if (preset === 'bass') {
      bassFilter.gain.value = 8;
      trebleFilter.gain.value = 0;
    } else if (preset === 'vocal') {
      bassFilter.gain.value = -3;
      trebleFilter.gain.value = 5;
    } else if (preset === 'treble') {
      bassFilter.gain.value = 0;
      trebleFilter.gain.value = 8;
    } else {
      bassFilter.gain.value = 0;
      trebleFilter.gain.value = 0;
    }
  }

  function updateMediaSession(title) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: 'My Music Pro',
        album: 'Offline Library'
      });
      navigator.mediaSession.setActionHandler('play', togglePlay);
      navigator.mediaSession.setActionHandler('pause', togglePlay);
      navigator.mediaSession.setActionHandler('previoustrack', playPrev);
      navigator.mediaSession.setActionHandler('nexttrack', playNext);
    } catch (_) {}
  }

  scrollViewport.addEventListener('scroll', () => {
    window.requestAnimationFrame(renderVirtualList);
  }, { passive: true });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(applyFilterAndSort, 120);
  });

  sortSelect.addEventListener('change', applyFilterAndSort);
  playPauseBtn.addEventListener('click', togglePlay);
  nextBtn.addEventListener('click', playNext);
  prevBtn.addEventListener('click', playPrev);

  shuffleBtn.addEventListener('click', () => {
    isShuffle = !isShuffle;
    shuffleBtn.classList.toggle('active-mode', isShuffle);
  });

  repeatBtn.addEventListener('click', () => {
    isRepeat = !isRepeat;
    audio.loop = isRepeat;
    repeatBtn.classList.toggle('active-mode', isRepeat);
  });

  eqSelect.addEventListener('change', (e) => applyEQPreset(e.target.value));
  speedSelect.addEventListener('change', (e) => {
    audio.playbackRate = parseFloat(e.target.value) || 1;
  });

  sleepSelect.addEventListener('change', (e) => {
    clearTimeout(sleepTimerId);
    const mins = Number(e.target.value);
    if (mins > 0) {
      showStatus(`Sleep timer set for ${mins} min`, 2500);
      sleepTimerId = setTimeout(() => {
        audio.pause();
        playPauseBtn.textContent = '▶';
        sleepSelect.value = '0';
      }, mins * 60 * 1000);
    }
  });

  audio.addEventListener('ended', () => {
    if (!isRepeat) playNext();
  });

  audio.addEventListener('error', () => {
    showStatus('Skipped unreadable audio file.', 2500);
    setTimeout(playNext, 500);
  });

  audio.addEventListener('loadedmetadata', () => {
    seekBar.max = Math.floor(audio.duration) || 0;
    durationEl.textContent = formatTime(audio.duration);
  });

  audio.addEventListener('timeupdate', () => {
    seekBar.value = Math.floor(audio.currentTime) || 0;
    currentTimeEl.textContent = formatTime(audio.currentTime);
  });

  seekBar.addEventListener('input', () => {
    audio.currentTime = Number(seekBar.value);
  });

  window.addEventListener('resize', renderVirtualList);

  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  (async function init() {
    await requestPersistentStorage();
    await openDatabase();
    await loadAllMetadata();
  })();
})();
