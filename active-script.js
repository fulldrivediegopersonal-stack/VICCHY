
    const decks = {
      a: { audio: document.getElementById('audio-a'), track: null, objectUrl: null, volume: 100 },
      b: { audio: document.getElementById('audio-b'), track: null, objectUrl: null, volume: 100 }
    };
    const musicLibrary = [];
    const crossfaderSpeeds = {
      slow: { interval: 100, step: 1 },
      normal: { interval: 60, step: 2 },
      fast: { interval: 30, step: 4 }
    };
    const cutIntervals = { slow: 900, normal: 550, fast: 260 };
    let autoCrossfaderTimer = null;
    let autoCrossfaderActive = false;
    let autoCrossfaderDirection = 1;
    let savedDirectoryHandle = null;
    let libraryDatabasePromise = null;

    function openLibraryDatabase() {
      if (libraryDatabasePromise) return libraryDatabasePromise;
      libraryDatabasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open('vycchy-mp3-library', 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('directories')) {
            database.createObjectStore('directories', { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('No se pudo abrir el almacenamiento local.'));
      });
      return libraryDatabasePromise;
    }

    async function readSavedDirectory() {
      const database = await openLibraryDatabase();
      return new Promise((resolve, reject) => {
        const request = database.transaction('directories', 'readonly').objectStore('directories').get('music');
        request.onsuccess = () => resolve(request.result?.handle || null);
        request.onerror = () => reject(request.error || new Error('No se pudo leer la carpeta guardada.'));
      });
    }

    async function saveDirectory(handle) {
      const database = await openLibraryDatabase();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction('directories', 'readwrite');
        transaction.objectStore('directories').put({ id: 'music', handle });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('No se pudo recordar la carpeta.'));
        transaction.onabort = () => reject(transaction.error || new Error('No se pudo guardar el acceso a la carpeta.'));
      });
    }

    async function initializeLibrary() {
      ['a', 'b'].forEach(deck => {
        const audio = decks[deck].audio;
        audio.addEventListener('play', () => updateDeckStatus(deck, 'REPRODUCIENDO', true));
        audio.addEventListener('pause', () => {
          if (!audio.ended) updateDeckStatus(deck, decks[deck].track ? 'EN PAUSA' : 'SIN TEMA', false);
        });
        audio.addEventListener('ended', () => updateDeckStatus(deck, 'FINALIZADO', false));
        audio.addEventListener('timeupdate', () => updateTrackTime(deck));
        audio.addEventListener('loadedmetadata', () => {
          updateTrackTime(deck);
          if (decks[deck].track) {
            decks[deck].track.duration = Number.isFinite(audio.duration) ? audio.duration : null;
            renderMatchSuggestions();
          }
        });
        audio.addEventListener('error', () => {
          if (decks[deck].track) {
            document.getElementById(`status-${deck}`).textContent = 'ERROR DE LECTURA';
            document.getElementById('library-status').textContent =
              `No se pudo reproducir ${decks[deck].track.file.name}. Comprueba que sea un MP3 válido.`;
          }
        });
      });

      document.getElementById('music-folder-input').addEventListener('change', event => {
        loadSelectedFiles(Array.from(event.target.files || []), true);
        event.target.value = '';
      });
      document.querySelectorAll('.match-filters input, .match-filters select').forEach(control => {
        control.addEventListener('change', renderMatchSuggestions);
      });
      applyVolumes();

      try {
        savedDirectoryHandle = await readSavedDirectory();
        if (!savedDirectoryHandle) return;
        document.getElementById('reconnect-folder').hidden = false;
        const permission = await savedDirectoryHandle.queryPermission({ mode: 'read' });
        if (permission === 'granted') {
          await loadDirectory(savedDirectoryHandle);
        } else {
          document.getElementById('library-status').textContent =
            'Hay una carpeta guardada. Pulsa «Volver a conectar» para autorizar el acceso de nuevo.';
        }
      } catch (error) {
        document.getElementById('library-status').textContent =
          `No se pudo recuperar la carpeta guardada: ${error.message}`;
      }
    }

    async function chooseMusicFolder() {
      if (window.AndroidMusicPicker && typeof window.AndroidMusicPicker.selectMusicFolder === 'function') {
        document.getElementById('library-status').textContent = 'Elige la carpeta Música del dispositivo…';
        window.AndroidMusicPicker.selectMusicFolder();
        return;
      }

      if (typeof window.showDirectoryPicker !== 'function') {
        document.getElementById('music-folder-input').click();
        return;
      }

      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        const permission = await handle.requestPermission({ mode: 'read' });
        if (permission !== 'granted') throw new Error('No se concedió permiso de lectura para la carpeta.');
        savedDirectoryHandle = handle;
        document.getElementById('reconnect-folder').hidden = false;
        await loadDirectory(handle);
        try {
          await saveDirectory(handle);
        } catch (error) {
          document.getElementById('library-status').textContent +=
            ` No se pudo recordar el acceso: ${error.message}`;
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          document.getElementById('library-status').textContent =
            `No se pudo abrir la carpeta: ${error.message}`;
        }
      }
    }

    async function loadAndroidMusicFiles(files) {
      const selectedFiles = files.map(file => ({
        androidId: file.id,
        lastModified: file.lastModified,
        libraryPath: file.path,
        name: file.name,
        size: file.size
      }));
      await loadSelectedFiles(selectedFiles, false);
    }

    function showAndroidMusicError(message) {
      document.getElementById('library-status').textContent = message;
    }

    function createDemoTrack(name, notes, bpm) {
      const sampleRate = 22050;
      const duration = 12;
      const sampleCount = sampleRate * duration;
      const buffer = new ArrayBuffer(44 + sampleCount * 2);
      const view = new DataView(buffer);
      const writeText = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) {
          view.setUint8(offset + index, text.charCodeAt(index));
        }
      };
      writeText(0, 'RIFF');
      view.setUint32(4, 36 + sampleCount * 2, true);
      writeText(8, 'WAVEfmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeText(36, 'data');
      view.setUint32(40, sampleCount * 2, true);

      const beatDuration = 60 / bpm;
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const time = sample / sampleRate;
        const beatPosition = time % beatDuration;
        const noteIndex = Math.floor(time / beatDuration) % notes.length;
        const frequency = 440 * (2 ** ((notes[noteIndex] - 69) / 12));
        const envelope = Math.min(1, beatPosition / 0.015, (beatDuration - beatPosition) / 0.06);
        const tone = Math.sin(2 * Math.PI * frequency * time) +
          0.25 * Math.sin(4 * Math.PI * frequency * time);
        view.setInt16(44 + sample * 2, Math.round(5000 * envelope * tone), true);
      }
      const file = new File([buffer], `${name}.wav`, { type: 'audio/wav', lastModified: Date.now() });
      Object.defineProperty(file, 'demoTrack', { value: true });
      return file;
    }

    async function loadDemoTracks() {
      const tracks = [
        createDemoTrack('Prueba Neon Pulse', [60, 64, 67, 72, 67, 64, 62, 67], 120),
        createDemoTrack('Prueba Night Drive', [57, 60, 64, 69, 64, 60, 55, 62], 96)
      ];
      await loadSelectedFiles(tracks, false, 'temas de prueba');
    }

    async function reconnectSavedFolder() {
      if (!savedDirectoryHandle) {
        document.getElementById('library-status').textContent = 'No hay una carpeta guardada para volver a conectar.';
        return;
      }

      try {
        const permission = await savedDirectoryHandle.requestPermission({ mode: 'read' });
        if (permission !== 'granted') throw new Error('No se concedió permiso de lectura para la carpeta.');
        await loadDirectory(savedDirectoryHandle);
      } catch (error) {
        document.getElementById('library-status').textContent =
          `No se pudo volver a conectar la carpeta: ${error.message}`;
      }
    }

    async function loadDirectory(directoryHandle) {
      const files = [];
      async function collectMp3Files(handle, relativePath) {
        for await (const entry of handle.values()) {
          const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
          if (entry.kind === 'directory') {
            await collectMp3Files(entry, entryPath);
          } else if (entry.name.toLowerCase().endsWith('.mp3')) {
            const file = await entry.getFile();
            Object.defineProperty(file, 'libraryPath', { value: entryPath });
            files.push(file);
          }
        }
      }

      document.getElementById('library-status').textContent = 'Leyendo los MP3 de la carpeta…';
      await collectMp3Files(directoryHandle, '');
      await loadSelectedFiles(files, false);
    }

    async function loadSelectedFiles(files, fromFolderInput, sourceLabel = '') {
      const mp3Files = files.filter(file =>
        file.demoTrack || file.name.toLowerCase().endsWith('.mp3')
      );
      musicLibrary.length = 0;
      const errors = [];
      const status = document.getElementById('library-status');
      status.textContent = `Analizando ${mp3Files.length} archivo(s) MP3…`;

      for (let index = 0; index < mp3Files.length; index += 1) {
        const file = mp3Files[index];
        let tags = {};
        try {
          tags = await readMp3Tags(file);
        } catch (error) {
          errors.push(`${file.name}: ${error.message}`);
        }
        let duration = null;
        try {
          duration = await measureDuration(file);
        } catch (error) {
          errors.push(`${file.name}: no se pudo leer la duración (${error.message})`);
        }
        const path = file.libraryPath || file.webkitRelativePath || file.name;
        const title = tags.title || file.name.replace(/\.(mp3|wav)$/i, '');
        musicLibrary.push({
          file,
          path,
          title,
          artist: tags.artist || '',
          album: tags.album || '',
          genre: tags.genre || '',
          bpm: tags.bpm || null,
          key: tags.key || '',
          duration,
          id: `${path}:${file.size}:${file.lastModified}`
        });
        status.textContent = `Analizando MP3… ${index + 1} de ${mp3Files.length}`;
      }

      renderLibrary();
      document.getElementById('folder-badge').textContent = `${musicLibrary.length} MP3`;
      if (!musicLibrary.length) {
        status.textContent = 'No se encontraron archivos MP3 en la selección.';
      } else {
        const source = sourceLabel || (fromFolderInput ? 'selección' : 'carpeta Música');
        status.textContent = `${musicLibrary.length} MP3 listos desde la ${source}. Los archivos no se suben a Internet.`;
      }
      if (errors.length) {
        status.textContent += ` ${errors.length} archivo(s) no pudieron analizarse por completo.`;
        console.warn('Problemas al analizar archivos MP3:', errors);
      }
      renderMatchSuggestions();
    }

    async function readMp3Tags(file) {
      if (file.androidId) return {};
      const buffer = await file.slice(0, 1024 * 1024).arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes.length < 10 || String.fromCharCode(...bytes.slice(0, 3)) !== 'ID3') return {};

      const version = bytes[3];
      const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
        ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
      const tags = {};
      const frames = {
        TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre',
        TBPM: 'bpm', TKEY: 'key', TDRC: 'year', TYER: 'year',
        TT2: 'title', TP1: 'artist', TAL: 'album', TCO: 'genre',
        TBP: 'bpm', TKE: 'key', TYE: 'year'
      };
      let offset = 10;
      const limit = Math.min(bytes.length, 10 + tagSize);

      while (offset + 10 <= limit) {
        const idLength = version === 2 ? 3 : 4;
        const frameId = String.fromCharCode(...bytes.slice(offset, offset + idLength));
        if (!frameId.trim() || /^\0+$/.test(frameId)) break;
        const frameHeaderLength = version === 2 ? 6 : 10;
        if (offset + frameHeaderLength > limit) break;
        const frameSize = version === 2
          ? (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5]
          : version === 4
            ? ((bytes[offset + 4] & 0x7f) << 21) | ((bytes[offset + 5] & 0x7f) << 14) |
              ((bytes[offset + 6] & 0x7f) << 7) | (bytes[offset + 7] & 0x7f)
            : (bytes[offset + 4] * 0x1000000) + (bytes[offset + 5] << 16) +
              (bytes[offset + 6] << 8) + bytes[offset + 7];
        const dataStart = offset + frameHeaderLength;
        const dataEnd = dataStart + frameSize;
        if (!frameSize || dataEnd > limit) break;
        const property = frames[frameId];
        if (property && !tags[property]) tags[property] = decodeTagText(bytes.subarray(dataStart, dataEnd));
        offset = dataEnd;
      }

      const bpm = Number.parseFloat(String(tags.bpm || '').replace(',', '.'));
      if (Number.isFinite(bpm) && bpm > 0) tags.bpm = bpm;
      else delete tags.bpm;
      return tags;
    }

    function decodeTagText(bytes) {
      if (!bytes.length) return '';
      const encoding = bytes[0];
      const payload = bytes.subarray(1);
      const decoder = encoding === 0
        ? new TextDecoder('windows-1252')
        : encoding === 1
          ? new TextDecoder('utf-16')
          : encoding === 2
            ? new TextDecoder('utf-16be')
            : new TextDecoder('utf-8');
      return decoder.decode(payload).replace(/\0/g, '').trim();
    }

    function measureDuration(file) {
      return new Promise(resolve => {
        const audio = document.createElement('audio');
        const objectUrl = file.androidId ? null : URL.createObjectURL(file);
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          resolve(Number.isFinite(audio.duration) ? audio.duration : null);
        };
        audio.onerror = () => {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          resolve(null);
        };
        audio.src = file.androidId
          ? `https://vycchy.local/audio/${encodeURIComponent(file.androidId)}`
          : objectUrl;
      });
    }

    function renderLibrary() {
      const grid = document.getElementById('music-library-grid');
      if (!musicLibrary.length) {
        grid.innerHTML = '';
        return;
      }
      grid.innerHTML = musicLibrary.map((track, index) => {
        const metadata = [
          track.artist,
          track.album,
          track.genre,
          track.bpm ? `${track.bpm} BPM` : '',
          track.key ? `Tonalidad ${track.key}` : '',
          track.duration ? formatTime(track.duration) : ''
        ].filter(Boolean).join(' · ');
        return `<article class="library-track-card">
          <strong class="playlist-title">${escapeHtml(track.title)}</strong>
          <p class="track-card-meta">${escapeHtml(metadata || 'Sin etiquetas ID3 disponibles')}</p>
          <p>${escapeHtml(track.path)}</p>
          <div class="library-card-actions">
            <button class="btn btn-a" onclick="loadTrack('a', ${index})">Cargar A</button>
            <button class="btn btn-b" onclick="loadTrack('b', ${index})">Cargar B</button>
          </div>
        </article>`;
      }).join('');
    }

    function loadTrack(deckName, index) {
      const track = musicLibrary[index];
      if (!track || !decks[deckName]) return;
      const deck = decks[deckName];
      deck.audio.pause();
      if (deck.objectUrl) URL.revokeObjectURL(deck.objectUrl);
      deck.track = track;
      deck.objectUrl = track.file.androidId ? null : URL.createObjectURL(track.file);
      deck.audio.src = track.file.androidId
        ? `https://vycchy.local/audio/${encodeURIComponent(track.file.androidId)}`
        : deck.objectUrl;
      deck.audio.load();
      document.getElementById(`title-${deckName}`).textContent = track.title;
      document.getElementById(`meta-${deckName}`).textContent =
        [track.artist, track.album, track.genre, track.bpm ? `${track.bpm} BPM` : '',
          track.key ? `Tonalidad ${track.key}` : '', track.path].filter(Boolean).join(' · ');
      document.getElementById(`status-${deckName}`).textContent = 'LISTO';
      document.getElementById(`seek-${deckName}`).value = '0';
      document.getElementById(`time-${deckName}`).textContent =
        `0:00 / ${track.duration ? formatTime(track.duration) : '0:00'}`;
      applyVolumes();
      renderMatchSuggestions();
    }

    function playTrack(deckName) {
      const deck = decks[deckName];
      if (!deck.track) {
        document.getElementById('library-status').textContent = `Carga primero un MP3 en el Deck ${deckName.toUpperCase()}.`;
        return;
      }
      const playRequest = deck.audio.play();
      if (playRequest && typeof playRequest.catch === 'function') {
        playRequest.catch(error => {
          document.getElementById('library-status').textContent =
            `No se pudo iniciar ${deck.track.file.name}: ${error.message}`;
        });
      }
    }

    function pauseTrack(deckName) {
      decks[deckName].audio.pause();
    }

    async function transmitTrack(deckName) {
      const deck = decks[deckName];
      if (!deck.track) {
        document.getElementById('library-status').textContent =
          `Carga primero un MP3 en el Deck ${deckName.toUpperCase()} para transmitirlo.`;
        return;
      }

      if (deck.track.file.androidId &&
          window.AndroidMusicPicker &&
          typeof window.AndroidMusicPicker.shareMusicFile === 'function') {
        window.AndroidMusicPicker.shareMusicFile(
          deck.track.file.androidId,
          deck.track.title || deck.track.file.name
        );
        return;
      }

      if (!navigator.share || !navigator.canShare) {
        document.getElementById('library-status').textContent =
          'La transmisión compartida no está disponible en este navegador.';
        return;
      }
      try {
        const shareData = { title: deck.track.title || deck.track.file.name, files: [deck.track.file] };
        if (!navigator.canShare(shareData)) {
          document.getElementById('library-status').textContent =
            'Este navegador no puede compartir el archivo MP3 directamente.';
          return;
        }
        await navigator.share(shareData);
      } catch (error) {
        if (error.name !== 'AbortError') {
          document.getElementById('library-status').textContent =
            `No se pudo transmitir el tema: ${error.message}`;
        }
      }
    }

    function playBoth() {
      ['a', 'b'].forEach(playTrack);
    }

    function pauseBoth() {
      ['a', 'b'].forEach(pauseTrack);
    }

    function seekTrack(deckName, value) {
      const audio = decks[deckName].audio;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = (Number(value) / 1000) * audio.duration;
      }
    }

    function updateTrackTime(deckName) {
      const audio = decks[deckName].audio;
      const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      document.getElementById(`seek-${deckName}`).value =
        duration ? String(Math.round((current / duration) * 1000)) : '0';
      document.getElementById(`time-${deckName}`).textContent =
        `${formatTime(current)} / ${formatTime(duration)}`;
    }

    function updateDeckStatus(deckName, status, isPlaying) {
      const statusElement = document.getElementById(`status-${deckName}`);
      statusElement.textContent = status;
      statusElement.classList.toggle('playing', isPlaying);
      const disc = statusElement.closest('.deck').querySelector('.vinyl-disc');
      disc.classList.toggle('spinning', isPlaying);
    }

    function formatTime(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
      const minutes = Math.floor(seconds / 60);
      const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
      return `${minutes}:${remainder}`;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
      }[character]));
    }

    function normalize(value) {
      return String(value || '').trim().toLocaleLowerCase();
    }

    function getCamelotKey(value) {
      const text = normalize(value).replace(/[♯]/g, '#').replace(/[♭]/g, 'b');
      const camelot = text.match(/^(1[0-2]|[1-9])\s*([ab])$/i);
      if (camelot) return { number: Number(camelot[1]), letter: camelot[2].toUpperCase() };

      const note = text.match(/^([a-g])([#b]?)(?:\s*(major|maj|minor|min|m))?$/i);
      if (!note) return null;
      const pitch = `${note[1].toUpperCase()}${note[2]}`;
      const minor = /^(minor|min|m)$/i.test(note[3] || '');
      const keys = minor
        ? { C: '5A', 'C#': '12A', Db: '12A', D: '7A', 'D#': '2A', Eb: '2A', E: '9A', F: '4A', 'F#': '11A', Gb: '11A', G: '6A', 'G#': '1A', Ab: '1A', A: '8A', 'A#': '3A', Bb: '3A', B: '10A' }
        : { C: '8B', 'C#': '3B', Db: '3B', D: '10B', 'D#': '5B', Eb: '5B', E: '12B', F: '7B', 'F#': '2B', Gb: '2B', G: '9B', 'G#': '4B', Ab: '4B', A: '11B', 'A#': '6B', Bb: '6B', B: '1B' };
      const result = keys[pitch];
      return result ? { number: Number(result.slice(0, -1)), letter: result.slice(-1) } : null;
    }

    function keysAreCompatible(first, second) {
      const keyA = getCamelotKey(first);
      const keyB = getCamelotKey(second);
      if (!keyA || !keyB) return null;
      if (keyA.letter === keyB.letter) {
        const distance = Math.min(
          Math.abs(keyA.number - keyB.number),
          12 - Math.abs(keyA.number - keyB.number)
        );
        return distance <= 1;
      }
      return keyA.number === keyB.number;
    }

    function getTrackPairScore(source, candidate) {
      const criteria = [];
      if (source.genre && candidate.genre) {
        criteria.push([30, normalize(source.genre) === normalize(candidate.genre)]);
      }
      if (source.artist && candidate.artist) {
        criteria.push([16, normalize(source.artist) === normalize(candidate.artist)]);
      }
      if (source.album && candidate.album) {
        criteria.push([10, normalize(source.album) === normalize(candidate.album)]);
      }
      if (source.bpm && candidate.bpm) {
        const difference = Math.abs(source.bpm - candidate.bpm);
        criteria.push([25, Math.max(0, 1 - difference / 15)]);
      }
      const harmonicMatch = keysAreCompatible(source.key, candidate.key);
      if (harmonicMatch !== null) criteria.push([25, harmonicMatch]);
      if (source.duration && candidate.duration) {
        const difference = Math.abs(source.duration - candidate.duration);
        criteria.push([8, Math.max(0, 1 - difference / 120)]);
      }
      const folderA = source.path.split('/').slice(0, -1).join('/');
      const folderB = candidate.path.split('/').slice(0, -1).join('/');
      if (folderA && folderB) criteria.push([6, normalize(folderA) === normalize(folderB)]);
      const titleTokensA = new Set(normalize(source.title).split(/\W+/).filter(token => token.length > 2));
      const titleTokensB = new Set(normalize(candidate.title).split(/\W+/).filter(token => token.length > 2));
      if (titleTokensA.size && titleTokensB.size) {
        const intersection = [...titleTokensA].filter(token => titleTokensB.has(token)).length;
        const union = new Set([...titleTokensA, ...titleTokensB]).size;
        criteria.push([8, intersection / union]);
      }
      const totalWeight = criteria.reduce((sum, [weight]) => sum + weight, 0);
      const score = totalWeight
        ? Math.round(criteria.reduce((sum, [weight, match]) => sum + weight * Number(match), 0) / totalWeight * 100)
        : 0;
      return { score, criteriaCount: criteria.length };
    }

    function passesMatchFilters(source, candidate) {
      const sameGenre = document.getElementById('filter-genre').checked;
      const sameArtist = document.getElementById('filter-artist').checked;
      const limitBpm = document.getElementById('filter-bpm').checked;
      const harmonicOnly = document.getElementById('filter-key').checked;
      const similarDuration = document.getElementById('filter-duration').checked;

      if (sameGenre && source.genre && candidate.genre &&
        normalize(source.genre) !== normalize(candidate.genre)) return false;
      if (sameArtist && source.artist && candidate.artist &&
        normalize(source.artist) !== normalize(candidate.artist)) return false;
      if (limitBpm && source.bpm && candidate.bpm &&
        Math.abs(source.bpm - candidate.bpm) > Number(document.getElementById('bpm-tolerance').value)) return false;
      if (harmonicOnly && source.key && candidate.key &&
        keysAreCompatible(source.key, candidate.key) === false) return false;
      if (similarDuration && source.duration && candidate.duration &&
        Math.abs(source.duration - candidate.duration) > Number(document.getElementById('duration-tolerance').value)) return false;
      return true;
    }

    function renderMatchSuggestions() {
      const sourceDeckName = document.getElementById('match-source').value;
      const targetDeckName = sourceDeckName === 'a' ? 'b' : 'a';
      const source = decks[sourceDeckName].track;
      const status = document.getElementById('match-status');
      const results = document.getElementById('match-suggestions');
      if (!source) {
        status.textContent = `Carga un tema en el Deck ${sourceDeckName.toUpperCase()} para ver sugerencias.`;
        results.innerHTML = '';
        return;
      }

      const matches = musicLibrary
        .filter(candidate => candidate.id !== source.id && passesMatchFilters(source, candidate))
        .map(candidate => ({ candidate, ...getTrackPairScore(source, candidate) }))
        .sort((left, right) => right.score - left.score || left.candidate.title.localeCompare(right.candidate.title))
        .slice(0, 6);
      if (!matches.length) {
        status.textContent = 'No hay temas que cumplan los filtros. Desactiva alguno o carga más MP3.';
        results.innerHTML = '';
        return;
      }

      status.textContent = `Mejores coincidencias para «${source.title}». Se comparan etiquetas ID3 disponibles, BPM, tonalidad, carpeta, duración y nombre.`;
      results.innerHTML = matches.map(({ candidate, score, criteriaCount }) => {
        const index = musicLibrary.indexOf(candidate);
        const details = [
          candidate.artist,
          candidate.genre,
          candidate.bpm ? `${candidate.bpm} BPM` : '',
          candidate.key ? `Tonalidad ${candidate.key}` : '',
          candidate.duration ? formatTime(candidate.duration) : ''
        ].filter(Boolean).join(' · ');
        return `<article class="suggestion-card">
          <strong class="playlist-title">${escapeHtml(candidate.title)}</strong>
          <span class="track-card-meta">${escapeHtml(details || 'Sin etiquetas ID3')}</span>
          <span class="suggestion-score">${criteriaCount ? `${score}% de compatibilidad` : 'Sin datos comparables'}</span>
          <button class="btn ${targetDeckName === 'a' ? 'btn-a' : 'btn-b'}" onclick="loadTrack('${targetDeckName}', ${index})">Cargar Deck ${targetDeckName.toUpperCase()}</button>
        </article>`;
      }).join('');
    }

    function setLights(mode) {
      document.body.classList.remove('lights-active', 'lights-fast');
      if (mode === 'smooth') document.body.classList.add('lights-active');
      if (mode === 'fast') document.body.classList.add('lights-fast');
    }

    function setIndividualVolume(deckName, value) {
      decks[deckName].volume = Number(value);
      document.getElementById(`vol-display-${deckName}`).textContent = `${value}%`;
      applyVolumes();
    }

    function applyVolumes() {
      const crossfader = Number(document.getElementById('crossfader').value) / 100;
      decks.a.audio.volume = (decks.a.volume / 100) * (1 - crossfader);
      decks.b.audio.volume = (decks.b.volume / 100) * crossfader;
    }

    function toggleAutoCrossfader() {
      if (autoCrossfaderActive) stopAutoCrossfader();
      else startAutoCrossfader();
    }

    function startAutoCrossfader() {
      const button = document.getElementById('auto-crossfader');
      const crossfader = document.getElementById('crossfader');
      const speed = crossfaderSpeeds[document.getElementById('crossfader-speed').value];
      if (autoCrossfaderActive) return;
      if (Number(crossfader.value) >= 100) autoCrossfaderDirection = -1;
      else if (Number(crossfader.value) <= 0) autoCrossfaderDirection = 1;
      const mode = document.getElementById('crossfader-mode').value;
      const selectedSpeed = document.getElementById('crossfader-speed').value;
      if (mode === 'ascending') autoCrossfaderDirection = 1;
      if (mode === 'descending') autoCrossfaderDirection = -1;
      autoCrossfaderActive = true;
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      button.textContent = 'DETENER';
      autoCrossfaderTimer = setInterval(() => {
        let value = Number(crossfader.value);
        if (mode === 'cut') {
          value = value < 50 ? 100 : 0;
        } else {
          value += autoCrossfaderDirection * speed.step;
          if (mode === 'alternate') {
            if (value >= 100) {
              value = 100;
              autoCrossfaderDirection = -1;
            } else if (value <= 0) {
              value = 0;
              autoCrossfaderDirection = 1;
            }
          } else if (value >= 100 || value <= 0) {
            value = Math.max(0, Math.min(100, value));
          }
        }
        crossfader.value = value;
        applyVolumes();
        if (mode !== 'alternate' && mode !== 'cut' && (value === 0 || value === 100)) {
          stopAutoCrossfader();
        }
      }, mode === 'cut' ? cutIntervals[selectedSpeed] : speed.interval);
    }

    function stopAutoCrossfader() {
      if (autoCrossfaderTimer) clearInterval(autoCrossfaderTimer);
      autoCrossfaderTimer = null;
      autoCrossfaderActive = false;
      const button = document.getElementById('auto-crossfader');
      button.classList.remove('active');
      button.setAttribute('aria-pressed', 'false');
      button.textContent = 'AUTO';
    }

    const matrixCanvas = document.getElementById('matrix-bg');
    const matrixContext = matrixCanvas.getContext('2d', { alpha: true });
    const matrixCharacters = '01ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜ';
    const matrixFontSize = 17;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let matrixDrops = [];
    let matrixLastFrame = 0;

    function resizeMatrixCanvas() {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      matrixCanvas.width = Math.ceil(window.innerWidth * pixelRatio);
      matrixCanvas.height = Math.ceil(window.innerHeight * pixelRatio);
      matrixContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      matrixDrops = Array.from(
        { length: Math.ceil(window.innerWidth / matrixFontSize) },
        () => Math.random() * -30
      );
      if (reducedMotion) drawMatrixRain();
    }

    function drawMatrixRain() {
      const width = window.innerWidth;
      const height = window.innerHeight;
      matrixContext.globalCompositeOperation = 'destination-out';
      matrixContext.fillStyle = 'rgba(0, 0, 0, 0.2)';
      matrixContext.fillRect(0, 0, width, height);
      matrixContext.globalCompositeOperation = 'source-over';
      matrixContext.font = `${matrixFontSize}px Bahnschrift, "Yu Gothic", monospace`;
      matrixContext.textBaseline = 'top';

      matrixDrops.forEach((drop, column) => {
        const character = matrixCharacters[Math.floor(Math.random() * matrixCharacters.length)];
        const x = column * matrixFontSize;
        const y = drop * matrixFontSize;
        matrixContext.fillStyle = Math.random() > 0.98 ? '#eaffef' : '#00ff41';
        matrixContext.shadowColor = '#00ff41';
        matrixContext.shadowBlur = 3;
        matrixContext.fillText(character, x, y);
        matrixContext.shadowBlur = 0;

        matrixDrops[column] = y > height && Math.random() > 0.975
          ? Math.random() * -24
          : drop + 0.55 + Math.random() * 0.9;
      });
    }

    function animateMatrix(timestamp) {
      if (timestamp - matrixLastFrame >= 50) {
        drawMatrixRain();
        matrixLastFrame = timestamp;
      }
      requestAnimationFrame(animateMatrix);
    }

    window.addEventListener('resize', resizeMatrixCanvas);
    resizeMatrixCanvas();
    if (!reducedMotion) requestAnimationFrame(animateMatrix);
    initializeLibrary();
  