const socket = io('/', {
  transports: ['polling', 'websocket'],
  upgrade: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000
});
const videoGrid = document.getElementById('video-grid');
const myVideo = document.createElement('video');
myVideo.id = 'video-self';
myVideo.muted = true;

/** Входящие звонки до готовности микрофона — иначе answer() не вызывается и связи нет. */
const pendingIncomingCalls = [];

const peer = new Peer(undefined, {
  path: '/peerjs',
  host: location.hostname,
  port: location.port ? location.port : (location.protocol === 'https:' ? '443' : '80'),
  secure: location.protocol === 'https:',
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  }
});

let originalStream;
let processedStream;
let screenStream = null;
const activeCalls = new Map();
/** Последний список участников комнаты — чтобы дозвониться, если room-users пришёл до myPeerId. */
let lastRoomUsers = [];

// Web Audio nodes
let audioContext;
let mediaStreamDestination;
let sourceNode;
let eqLow;
let eqHigh;
let convolver;
let wetGain;
let masterGain;
let highpass;
let compressor;
let nsEnabled = true;
// Nicknames mapping and local nick
const userNicknames = {};
let myNick = '';
try { myNick = (localStorage.getItem('userNick') || '').trim(); } catch (_) { myNick = ''; }

/** Peer id from PeerJS; join-room only after this and media are ready (avoids losing room-users). */
let myPeerId = null;
let mediaReady = false;
let hasJoinedRoom = false;

const tryEmitJoinRoom = () => {
  if (hasJoinedRoom || !myPeerId || !mediaReady) return;
  socket.emit('join-room', ROOM_ID, myPeerId, myNick || '');
  hasJoinedRoom = true;
};

const buildOutgoingStream = () => {
  if (screenStream) {
    const vt = screenStream.getVideoTracks()[0];
    if (vt && vt.readyState === 'live') {
      const at = processedStream && processedStream.getAudioTracks()[0];
      return new MediaStream([vt, at].filter(Boolean));
    }
  }
  return processedStream;
};

const findVideoSender = (pc) => {
  const withTrack = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (withTrack) return withTrack;
  const tr = pc.getTransceivers().find(
    (t) => t.sender && t.sender.track && t.sender.track.kind === 'video'
  );
  return tr ? tr.sender : null;
};

const syncStreamToPeer = async (call, stream) => {
  const pc = call.peerConnection;
  if (!pc || pc.connectionState === 'closed') return;
  const v = stream.getVideoTracks()[0];
  const a = stream.getAudioTracks()[0];
  const audioSender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
  const videoSender = findVideoSender(pc);
  if (a && audioSender) {
    await audioSender.replaceTrack(a);
  }
  if (v) {
    if (videoSender) {
      await videoSender.replaceTrack(v);
    } else {
      pc.addTrack(v, stream);
    }
  } else if (videoSender) {
    try {
      if (videoSender.track) videoSender.track.stop();
    } catch (_) {}
    pc.removeTrack(videoSender);
  }
};

const syncOutgoingToPeers = async () => {
  const stream = buildOutgoingStream();
  for (const [, call] of activeCalls) {
    try {
      if (call.peerConnection && call.peerConnection.connectionState !== 'closed') {
        await syncStreamToPeer(call, stream);
      }
    } catch (e) {
      console.error('syncOutgoingToPeers', e);
    }
  }
};

const wireIncomingCall = (call) => {
  activeCalls.set(call.peer, call);
  call.on('close', () => activeCalls.delete(call.peer));
  call.on('error', (e) => {
    console.error('MediaConnection error', call.peer, e);
    activeCalls.delete(call.peer);
  });
  const video = document.createElement('video');
  try {
    video.id = `video-${call.peer}`;
  } catch (_) {}
  call.on('stream', (userVideoStream) => {
    const onRemoteTracksChanged = () => {
      refreshRemoteVideoPresentation(video, userVideoStream);
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      updateLayout();
    };
    userVideoStream.addEventListener('addtrack', onRemoteTracksChanged);
    userVideoStream.addEventListener('removetrack', onRemoteTracksChanged);
    try {
      const pc = call.peerConnection;
      if (pc) {
        pc.addEventListener('track', (ev) => {
          const rs = (ev.streams && ev.streams[0]) || userVideoStream;
          refreshRemoteVideoPresentation(video, rs);
          video.play().catch(() => {});
          updateLayout();
        });
      }
    } catch (_) {}
    addVideoStream(video, userVideoStream);
  });
  try {
    const pc = call.peerConnection;
    if (pc) {
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed') {
          console.warn('WebRTC connection failed for peer', call.peer);
        }
      });
    }
  } catch (_) {}
};

const answerIncomingCall = (call) => {
  wireIncomingCall(call);
  call.answer(buildOutgoingStream());
};

peer.on('call', (call) => {
  if (processedStream) {
    answerIncomingCall(call);
  } else {
    pendingIncomingCalls.push(call);
  }
});

const showToast = (msg) => {
  const el = document.getElementById('roomToast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('room-toast--visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.classList.remove('room-toast--visible');
    el.hidden = true;
  }, 2400);
};

const setLocalScreenPreview = () => {
  const hasScreen = screenStream && screenStream.getVideoTracks().some((t) => t.readyState === 'live');
  const avatarEl = document.getElementById('avatar-video-self');
  if (hasScreen) {
    const combined = buildOutgoingStream();
    myVideo.srcObject = combined;
    myVideo.classList.remove('none');
    myVideo.classList.add('videoBlock');
    if (avatarEl) avatarEl.remove();
  } else {
    myVideo.srcObject = processedStream;
    myVideo.classList.add('none');
    myVideo.classList.remove('videoBlock');
    if (!document.getElementById('avatar-video-self') && videoGrid) {
      const avatar = document.createElement('div');
      avatar.id = 'avatar-video-self';
      addAvatar(avatar);
    }
  }
  updateLayout();
};

const getEl = (id) => document.getElementById(id);
const lsKey = 'audioSettingsV1';
const loadSettings = () => {
  try {
    const raw = localStorage.getItem(lsKey);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
};

const setupAudioProcessing = (stream) => {
  originalStream = stream;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();

  sourceNode = audioContext.createMediaStreamSource(stream);

  // EQ
  eqLow = audioContext.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqLow.frequency.value = 250;
  eqLow.gain.value = 0;

  eqHigh = audioContext.createBiquadFilter();
  eqHigh.type = 'highshelf';
  eqHigh.frequency.value = 3000;
  eqHigh.gain.value = 0;

  // Reverb via Convolver with generated IR
  convolver = audioContext.createConvolver();
  convolver.buffer = generateImpulseResponse(audioContext, 2.2, 2.5); // duration, decay

  wetGain = audioContext.createGain();
  wetGain.gain.value = 0.0; // start dry

  masterGain = audioContext.createGain();
  masterGain.gain.value = 1.0;

  mediaStreamDestination = audioContext.createMediaStreamDestination();

  // Noise suppression stage (toggleable)
  highpass = audioContext.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 120; // cut low rumble
  highpass.Q.value = 0.707;

  compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -40; // dB
  compressor.knee.value = 20;
  compressor.ratio.value = 12; // strong compression
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  // Downstream wiring (constant): eqLow -> eqHigh -> master and reverb branch -> destination
  eqLow.connect(eqHigh);
  eqHigh.connect(masterGain);
  eqHigh.connect(convolver);
  convolver.connect(wetGain);
  wetGain.connect(masterGain);
  masterGain.connect(mediaStreamDestination);

  processedStream = mediaStreamDestination.stream;

  // Apply saved settings
  const st = loadSettings() || {};
  if (typeof st.gain === 'number') masterGain.gain.value = st.gain;
  if (typeof st.bass === 'number') eqLow.gain.value = st.bass;
  if (typeof st.treble === 'number') eqHigh.gain.value = st.treble;
  if (typeof st.reverb === 'number') wetGain.gain.value = st.reverb;
  if (typeof st.noiseSuppression === 'boolean') nsEnabled = st.noiseSuppression;
  wireNoiseSuppression(nsEnabled);

  // Initial upstream wiring based on nsEnabled
  wireNoiseSuppression(nsEnabled);
};

const generateImpulseResponse = (context, durationSeconds, decay) => {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * durationSeconds));
  const impulse = context.createBuffer(2, length, rate);
  for (let channelIndex = 0; channelIndex < impulse.numberOfChannels; channelIndex++) {
    const channelData = impulse.getChannelData(channelIndex);
    for (let i = 0; i < length; i++) {
      channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
};

const initEffectsUI = () => {
  const gainSlider = getEl('gainSlider');
  const bassSlider = getEl('bassSlider');
  const trebleSlider = getEl('trebleSlider');
  const reverbSlider = getEl('reverbSlider');
  const bypassToggle = getEl('bypassToggle');
  const nsToggle = getEl('nsToggle');

  const gainVal = getEl('gainVal');
  const bassVal = getEl('bassVal');
  const trebleVal = getEl('trebleVal');
  const reverbVal = getEl('reverbVal');

  if (gainSlider) {
    gainSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (masterGain) masterGain.gain.value = value;
      if (gainVal) gainVal.textContent = `${value.toFixed(2)}×`;
    });
  }
  if (bassSlider) {
    bassSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (eqLow) eqLow.gain.value = value;
      if (bassVal) bassVal.textContent = `${value} dB`;
    });
  }
  if (trebleSlider) {
    trebleSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (eqHigh) eqHigh.gain.value = value;
      if (trebleVal) trebleVal.textContent = `${value} dB`;
    });
  }
  if (reverbSlider) {
    reverbSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (wetGain) wetGain.gain.value = value;
      if (reverbVal) reverbVal.textContent = `${Math.round(value * 100)}%`;
    });
  }
  if (bypassToggle) {
    bypassToggle.addEventListener('change', (e) => {
      const isBypassed = e.target.checked;
      // Set EQ to neutral and reverb to 0 when bypassed
      if (eqLow) eqLow.gain.value = isBypassed ? 0 : parseFloat(getEl('bassSlider')?.value || '0');
      if (eqHigh) eqHigh.gain.value = isBypassed ? 0 : parseFloat(getEl('trebleSlider')?.value || '0');
      if (wetGain) wetGain.gain.value = isBypassed ? 0 : parseFloat(getEl('reverbSlider')?.value || '0');

      // Optionally dim controls when bypassed
      [gainSlider, bassSlider, trebleSlider, reverbSlider].forEach((el) => {
        if (!el) return;
        el.disabled = isBypassed;
        el.style.opacity = isBypassed ? '0.6' : '1';
      });
    });
  }

  if (nsToggle) {
    nsToggle.checked = true;
    nsToggle.addEventListener('change', async (e) => {
      nsEnabled = !!e.target.checked;
      wireNoiseSuppression(nsEnabled);
      try {
        const track = originalStream && originalStream.getAudioTracks && originalStream.getAudioTracks()[0];
        if (track && track.applyConstraints) {
          await track.applyConstraints({
            noiseSuppression: nsEnabled,
            echoCancellation: nsEnabled
          });
        }
      } catch (_) {}
    });
  }
};

const wireNoiseSuppression = (enabled) => {
  try {
    // Disconnect upstream from source
    sourceNode.disconnect();
  } catch (_) {}
  if (enabled) {
    sourceNode.connect(highpass);
    highpass.connect(compressor);
    compressor.connect(eqLow);
  } else {
    try {
      highpass.disconnect();
    } catch (_) {}
    try {
      compressor.disconnect();
    } catch (_) {}
    sourceNode.connect(eqLow);
  }
};

const getMicStream = () => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    const msg =
      'Микрофон недоступен: в Chrome для сайта по HTTP (кроме localhost) отключён доступ к медиа. Нужен HTTPS (домен + сертификат) или откройте приложение с localhost.';
    const toast = document.getElementById('roomToast');
    if (toast) {
      toast.textContent = msg;
      toast.hidden = false;
      toast.classList.add('room-toast--visible');
    } else {
      window.alert(msg);
    }
    return Promise.reject(new Error('mediaDevices.getUserMedia unavailable'));
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: false
    },
    video: false
  });
};

getMicStream()
.then((stream) => {
  setupAudioProcessing(stream);

  // Show local processed stream in our grid
  addVideoStream(myVideo, processedStream);

  while (pendingIncomingCalls.length) {
    const c = pendingIncomingCalls.shift();
    try {
      answerIncomingCall(c);
    } catch (e) {
      console.error('answer pending call', e);
    }
  }

  socket.on('user-connected', (payload) => {
      const userId = typeof payload === 'string' ? payload : payload?.userId;
      const nick = typeof payload === 'string' ? '' : (payload?.nick || '');
      if (userId) userNicknames[userId] = (nick || '').trim();
      if (userId && myPeerId) connectToNewUser(userId);
  });

  socket.on('room-users', (users) => {
    lastRoomUsers = Array.isArray(users) ? users : [];
    try {
      lastRoomUsers.forEach(({ userId, nick }) => {
        if (userId) userNicknames[userId] = (nick || '').trim();
        if (userId && myPeerId && userId !== myPeerId && processedStream) {
          connectToNewUser(userId);
        }
      });
    } catch (_) {}
  });

  socket.on('user-disconnected', (payload) => {
    removePeerFromRoom(payload);
  });

  mediaReady = true;
  tryEmitJoinRoom();

  const muteBtn = document.getElementById('muteButton');
  const screenBtn = document.getElementById('screenShareButton');

  const setMicMuted = (muted) => {
    const t = processedStream && processedStream.getAudioTracks()[0];
    if (t) t.enabled = !muted;
    if (muteBtn) {
      muteBtn.classList.toggle('ctrl-btn--muted', muted);
      muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
      muteBtn.setAttribute('aria-label', muted ? 'Включить микрофон' : 'Выключить микрофон');
      const icon = document.getElementById('muteButtonIcon');
      if (icon) {
        icon.src = muted ? '/images/call-mic-off.svg' : '/images/call-mic.svg';
      }
    }
  };

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      const t = processedStream && processedStream.getAudioTracks()[0];
      if (!t) return;
      setMicMuted(t.enabled);
    });
  }

  const setScreenUiActive = (on) => {
    if (!screenBtn) return;
    screenBtn.classList.toggle('ctrl-btn--active', on);
    screenBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    screenBtn.setAttribute(
      'aria-label',
      on ? 'Выключить демонстрацию экрана' : 'Включить демонстрацию экрана'
    );
  };

  const stopScreenShare = () => {
    if (screenStream) {
      screenStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch (_) {}
      });
      screenStream = null;
    }
    setScreenUiActive(false);
    setLocalScreenPreview();
    syncOutgoingToPeers();
  };

  const openDisplayMediaViaElectronDesktop = async () => {
    const api = typeof window !== 'undefined' && window.cumchatka;
    if (!api || typeof api.getScreenSourceId !== 'function') return null;
    const sourceId = await api.getScreenSourceId();
    if (!sourceId) return null;
    const flat = {
      audio: false,
      video: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId
      }
    };
    const nested = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      }
    };
    try {
      return await navigator.mediaDevices.getUserMedia(nested);
    } catch (e1) {
      try {
        return await navigator.mediaDevices.getUserMedia(flat);
      } catch (e2) {
        throw e2 || e1;
      }
    }
  };

  const openDisplayMedia = async () => {
    const md = navigator.mediaDevices;
    const attempts = [
      { video: { cursor: 'always' }, audio: false },
      { video: true, audio: false },
      { video: true }
    ];
    let lastErr;

    if (md && typeof md.getDisplayMedia === 'function') {
      for (const constraints of attempts) {
        try {
          return await md.getDisplayMedia(constraints);
        } catch (e) {
          lastErr = e;
          if (e.name !== 'NotSupportedError' && e.name !== 'TypeError' && e.name !== 'OverconstrainedError') {
            throw e;
          }
        }
      }
    }

    try {
      const viaElectron = await openDisplayMediaViaElectronDesktop();
      if (viaElectron) return viaElectron;
    } catch (e) {
      lastErr = lastErr || e;
      if (e && e.name !== 'NotSupportedError' && e.name !== 'TypeError') {
        throw e;
      }
    }

    if (!md || typeof md.getDisplayMedia !== 'function') {
      showToast('Демонстрация экрана не поддерживается в этом окружении');
    }
    throw lastErr || new Error('getDisplayMedia failed');
  };

  if (screenBtn) {
    screenBtn.addEventListener('click', async () => {
      if (screenStream && screenStream.getVideoTracks().some((t) => t.readyState === 'live')) {
        stopScreenShare();
        return;
      }
      try {
        screenStream = await openDisplayMedia();
        const vt = screenStream.getVideoTracks()[0];
        if (vt) {
          vt.onended = () => {
            stopScreenShare();
          };
        }
        setScreenUiActive(true);
        setLocalScreenPreview();
        await syncOutgoingToPeers();
      } catch (e) {
        console.error('getDisplayMedia', e);
        screenStream = null;
        setScreenUiActive(false);
        if (e && e.name === 'NotAllowedError') {
          showToast('Доступ к экрану отклонён');
        } else if (e && e.name === 'NotSupportedError') {
          showToast('Экран: не поддерживается (нужен HTTPS или обновите Electron/браузер)');
        } else {
          showToast('Не удалось начать демонстрацию экрана');
        }
      }
    });
  }

})
.catch((err) => {
  console.error('getUserMedia failed:', err);
});
const connectToNewUser = (userId) => {
  if (!userId || !myPeerId || activeCalls.has(userId)) return;
  /** Два одновременных peer.call между одной парой ломают аудио (glare). Звонит только «меньший» peer id. */
  if (String(myPeerId) >= String(userId)) return;
  const out = buildOutgoingStream();
  const call = peer.call(userId, out);
  wireIncomingCall(call);
};

/** Если room-users пришёл до peer.on('open'), исходящий call не создавался — повторяем. */
const tryConnectToPeersInRoom = () => {
  if (!myPeerId || !processedStream) return;
  try {
    lastRoomUsers.forEach(({ userId, nick }) => {
      if (userId) userNicknames[userId] = (nick || '').trim();
      if (userId && userId !== myPeerId) {
        connectToNewUser(userId);
      }
    });
  } catch (_) {}
};

peer.on('open', (id) => {
  myPeerId = id;
  tryEmitJoinRoom();
  tryConnectToPeersInRoom();
});
peer.on('error', (err) => {
  console.error('PeerJS error:', err);
});

/**
 * Удалённый поток сначала часто только audio — показываем аватар.
 * Когда собеседник включает экран, приходит новый video track; событие `stream` в PeerJS не повторяется,
 * поэтому слушаем addtrack/removetrack и обновляем превью.
 */
const refreshRemoteVideoPresentation = (video, stream) => {
  if (!video || !stream) return;
  video.srcObject = stream;
  const hasVideo = stream.getVideoTracks().some((t) => t.readyState !== 'ended');
  const avatarEl = document.getElementById(`avatar-${video.id}`);
  if (hasVideo) {
    video.classList.add('videoBlock');
    video.classList.remove('none');
    if (avatarEl) avatarEl.remove();
  } else {
    video.classList.add('none');
    video.classList.remove('videoBlock');
    if (!document.getElementById(`avatar-${video.id}`) && videoGrid) {
      const avatar = document.createElement('div');
      avatar.id = `avatar-${video.id}`;
      addAvatar(avatar);
    }
  }
};

const addVideoStream = (video, stream) => {
  video.srcObject = stream;
  const isVideoInclude = stream.getVideoTracks().reduce((acc, track) => acc || track.kind === 'video', false);

  video.autoplay = true;
  video.playsInline = true;
  if (video.id && video.id !== 'video-self') {
    video.muted = false;
    try {
      video.volume = 1;
    } catch (_) {}
  }
  if (isVideoInclude) {
    video.classList.add('videoBlock');
  } else {
    const avatar = document.createElement('div');
    // self video will have id 'video-self'
    const vidId = video.id || 'video-self';
    avatar.id = `avatar-${vidId}`;
    addAvatar(avatar);
    video.classList.add('none');
  }

  video.addEventListener('loadedmetadata', () => {
    const p = video.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        
      });
    }
    videoGrid.append(video);
    updateLayout();
  });
};

const addAvatar = (avatar) => {
  const realAvatr = document.createElement('img');
  realAvatr.src = '/images/avatar.png';
  avatar.classList.add('avatar');
  realAvatr.classList.add('img');
  videoGrid.append(avatar);
  avatar.append(realAvatr);
  const name = document.createElement('span');
  name.classList.add('name');
  // Determine label based on avatar id and known nicknames
  let label = 'Гость';
  const aid = avatar.id || '';
  if (aid.startsWith('avatar-video-')) {
    const uid = aid.slice('avatar-video-'.length);
    if (uid === 'self') {
      label = myNick || 'Я';
    } else {
      label = (userNicknames[uid] || '').trim() || 'Гость';
    }
  } else {
    // Fallback: if avatar id doesn't follow pattern, detect self by proximity
    label = myNick || 'Гость';
  }
  name.textContent = label;
  avatar.append(name);
  updateLayout();
}

const resumePlayback = () => {
  document.querySelectorAll('video').forEach(v => {
    if (v.paused) {
      v.play().catch(() => {});
    }
  });
  window.removeEventListener('click', resumePlayback);
  window.removeEventListener('touchstart', resumePlayback, { passive: true });
};
window.addEventListener('click', resumePlayback);
window.addEventListener('touchstart', resumePlayback, { passive: true });

// Ensure AudioContext resumes on gesture for iOS/Safari policies
const resumeAudioContextIfNeeded = async () => {
  try {
    if (audioContext && audioContext.state !== 'running') {
      await audioContext.resume();
    }
  } catch (_) {}
};
window.addEventListener('click', resumeAudioContextIfNeeded);
window.addEventListener('touchstart', resumeAudioContextIfNeeded, { passive: true });


// Layout logic according to rules (1, 2-3, 4-6, 7-9)
const updateLayout = () => {
  if (!videoGrid) return;
  const tiles = Array.from(videoGrid.children).filter(el => el && (el.classList.contains('videoBlock') || el.classList.contains('avatar')));
  const count = tiles.length;

  // Reset positions
  tiles.forEach(t => { t.style.gridRow = ''; t.style.gridColumn = ''; });

  if (count <= 0) return;

  if (count === 1) {
    videoGrid.style.gridAutoFlow = 'row';
    videoGrid.style.gridTemplateRows = '1fr';
    videoGrid.style.gridTemplateColumns = '1fr';
    return;
  }

  if (count === 2) {
    // Two participants: split screen 50/50
    videoGrid.style.gridAutoFlow = 'row';
    videoGrid.style.gridTemplateRows = '1fr';
    videoGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
    return;
  }

  if (count === 3) {
    // Three participants: single row with 3 columns
    videoGrid.style.gridAutoFlow = 'row';
    videoGrid.style.gridTemplateRows = '1fr';
    videoGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    return;
  }

  // >3 participants: rows of 3 columns; center remainder on the last row
  const rows = Math.ceil(count / 3);
  videoGrid.style.gridAutoFlow = 'row';
  videoGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
  videoGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  // Position tiles row-major
  tiles.forEach((tile, i) => {
    const row = Math.floor(i / 3) + 1;
    const col = (i % 3) + 1;
    tile.style.gridColumn = `${col}`;
    tile.style.gridRow = `${row}`;
  });

  const remainder = count % 3;
  if (remainder !== 0) {
    const lastRow = rows;
    const startIndex = (rows - 1) * 3; // first index on last row
    if (remainder === 1) {
      // Center one tile in column 2
      const tile = tiles[startIndex];
      if (tile) {
        tile.style.gridRow = `${lastRow}`;
        tile.style.gridColumn = '2';
      }
    } else if (remainder === 2) {
      // Place two tiles in columns 1 and 3
      const t1 = tiles[startIndex];
      const t2 = tiles[startIndex + 1];
      if (t1) { t1.style.gridRow = `${lastRow}`; t1.style.gridColumn = '1'; }
      if (t2) { t2.style.gridRow = `${lastRow}`; t2.style.gridColumn = '3'; }
    }
  }
};

const removePeerFromRoom = (rawId) => {
  const userId =
    typeof rawId === 'string'
      ? rawId
      : rawId && typeof rawId === 'object'
        ? rawId.userId ?? rawId.id
        : String(rawId ?? '');
  if (!userId) return;

  try {
    const call = activeCalls.get(userId);
    if (call) {
      try {
        call.close();
      } catch (_) {}
      activeCalls.delete(userId);
    }
  } catch (_) {}

  try {
    delete userNicknames[userId];
  } catch (_) {}

  document.getElementById(`video-${userId}`)?.remove();
  document.getElementById(`avatar-video-${userId}`)?.remove();

  updateLayout();
};

window.addEventListener('beforeunload', () => {
  try {
    socket.disconnect();
  } catch (_) {}
});
window.addEventListener('pagehide', () => {
  try {
    socket.disconnect();
  } catch (_) {}
});

document.getElementById('inviteButton')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    showToast('Ссылка скопирована');
  } catch (_) {
    showToast('Не удалось скопировать');
  }
});

document.getElementById('endCallButton')?.addEventListener('click', () => {
  try {
    socket.disconnect();
  } catch (_) {}
  try {
    peer.destroy();
  } catch (_) {}
});

