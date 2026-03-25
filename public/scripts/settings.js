const lsKey = 'audioSettingsV1';

const defaults = {
  gain: 1.0,
  bass: 0,
  treble: 0,
  reverb: 0,
  noiseSuppression: true,
  bypass: false,
};

const load = () => {
  try {
    const raw = localStorage.getItem(lsKey);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch (_) {
    return { ...defaults };
  }
};

const save = (state) => {
  try {
    localStorage.setItem(lsKey, JSON.stringify(state));
  } catch (_) {}
};

const state = load();

const getEl = (id) => document.getElementById(id);

const gainSlider = getEl('gainSlider');
const bassSlider = getEl('bassSlider');
const trebleSlider = getEl('trebleSlider');
const reverbSlider = getEl('reverbSlider');
const nsToggle = getEl('nsToggle');
const bypassToggle = getEl('bypassToggle');
const monitorToggle = getEl('monitorToggle');

const gainVal = getEl('gainVal');
const bassVal = getEl('bassVal');
const trebleVal = getEl('trebleVal');
const reverbVal = getEl('reverbVal');

let ctx;
let src;
let eqLow;
let eqHigh;
let convolver;
let wetGain;
let masterGain;
let highpass;
let compressor;
let monitorOn = false;
let analyser;
let meterRAF;

const buildImpulse = (context, durationSeconds, decay) => {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * durationSeconds));
  const impulse = context.createBuffer(2, length, rate);
  for (let ch = 0; ch < impulse.numberOfChannels; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
};

const teardownMonitor = () => {
  try { cancelAnimationFrame(meterRAF); } catch (_) {}
  try { src && src.disconnect(); } catch (_) {}
  try { eqLow && eqLow.disconnect(); } catch (_) {}
  try { eqHigh && eqHigh.disconnect(); } catch (_) {}
  try { convolver && convolver.disconnect(); } catch (_) {}
  try { wetGain && wetGain.disconnect(); } catch (_) {}
  try { masterGain && masterGain.disconnect(); } catch (_) {}
  try { highpass && highpass.disconnect(); } catch (_) {}
  try { compressor && compressor.disconnect(); } catch (_) {}
  try { ctx && ctx.close(); } catch (_) {}
  ctx = null;
  src = null;
  analyser = null;
  monitorOn = false;
  if (monitorToggle) monitorToggle.checked = false;
};

const wireMonitor = async () => {
  if (monitorOn) {
    teardownMonitor();
    return;
  }
  // Need a user gesture to start audio on some platforms
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      noiseSuppression: !!state.noiseSuppression,
      echoCancellation: !!state.noiseSuppression,
      autoGainControl: false
    },
    video: false
  });
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  src = ctx.createMediaStreamSource(stream);

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.85;

  // Build chain similar to app
  eqLow = ctx.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqLow.frequency.value = 250;
  eqLow.gain.value = state.bass;

  eqHigh = ctx.createBiquadFilter();
  eqHigh.type = 'highshelf';
  eqHigh.frequency.value = 3000;
  eqHigh.gain.value = state.treble;

  convolver = ctx.createConvolver();
  convolver.buffer = buildImpulse(ctx, 2.2, 2.5);
  wetGain = ctx.createGain();
  wetGain.gain.value = state.reverb;

  masterGain = ctx.createGain();
  masterGain.gain.value = state.gain;

  highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 120;
  highpass.Q.value = 0.707;

  compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -40;
  compressor.knee.value = 20;
  compressor.ratio.value = 12;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  // Wiring depending on bypass and ns
  const dest = ctx.destination;
  if (state.bypass) {
    src.connect(analyser);
    analyser.connect(dest);
  } else {
    if (state.noiseSuppression) {
      src.connect(highpass);
      highpass.connect(compressor);
      compressor.connect(eqLow);
    } else {
      src.connect(eqLow);
    }
    eqLow.connect(eqHigh);
    eqHigh.connect(masterGain);
    eqHigh.connect(convolver);
    convolver.connect(wetGain);
    wetGain.connect(masterGain);
    masterGain.connect(analyser);
    analyser.connect(dest);
  }
  monitorOn = true;
  if (monitorToggle) monitorToggle.checked = true;
  startMeterLoop();
};

const startMeterLoop = () => {
  const fill = document.getElementById('levelFill');
  const text = document.getElementById('levelText');
  if (!analyser || !fill || !text) return;
  const buffer = new Uint8Array(analyser.fftSize);
  const loop = () => {
    analyser.getByteTimeDomainData(buffer);
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
      const v = (buffer[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / buffer.length);
    const db = 20 * Math.log10(rms || 1e-8);
    const pct = Math.min(100, Math.max(0, Math.round(((db + 60) / 60) * 100)));
    fill.style.width = pct + '%';
    text.textContent = (rms < 1e-4) ? '-∞ dB' : db.toFixed(1) + ' dB';
    meterRAF = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(meterRAF);
  loop();
};

// Init UI from state
if (gainSlider) { gainSlider.value = state.gain; gainVal.textContent = `${parseFloat(state.gain).toFixed(2)}×`; }
if (bassSlider) { bassSlider.value = state.bass; bassVal.textContent = `${state.bass} dB`; }
if (trebleSlider) { trebleSlider.value = state.treble; trebleVal.textContent = `${state.treble} dB`; }
if (reverbSlider) { reverbSlider.value = state.reverb; reverbVal.textContent = `${Math.round(state.reverb * 100)}%`; }
if (nsToggle) { nsToggle.checked = !!state.noiseSuppression; }
if (bypassToggle) { bypassToggle.checked = !!state.bypass; }

// Handlers
const setSliderFill = (el) => {
  if (!el) return;
  const min = parseFloat(el.min || '0');
  const max = parseFloat(el.max || '1');
  const val = parseFloat(el.value || '0');
  const pct = ((val - min) / (max - min)) * 100;
  el.style.setProperty('--sx', pct + '%');
};

[gainSlider, bassSlider, trebleSlider, reverbSlider].forEach(setSliderFill);
['input', 'change'].forEach(evt => {
  [gainSlider, bassSlider, trebleSlider, reverbSlider].forEach(el => el?.addEventListener(evt, () => setSliderFill(el)));
});
gainSlider?.addEventListener('input', (e) => {
  state.gain = parseFloat(e.target.value);
  gainVal.textContent = `${state.gain.toFixed(2)}×`;
  save(state);
});
bassSlider?.addEventListener('input', (e) => {
  state.bass = parseFloat(e.target.value);
  bassVal.textContent = `${state.bass} dB`;
  save(state);
});
trebleSlider?.addEventListener('input', (e) => {
  state.treble = parseFloat(e.target.value);
  trebleVal.textContent = `${state.treble} dB`;
  save(state);
});
reverbSlider?.addEventListener('input', (e) => {
  state.reverb = parseFloat(e.target.value);
  reverbVal.textContent = `${Math.round(state.reverb * 100)}%`;
  save(state);
});
nsToggle?.addEventListener('change', (e) => {
  state.noiseSuppression = !!e.target.checked;
  save(state);
});
bypassToggle?.addEventListener('change', (e) => {
  state.bypass = !!e.target.checked;
  save(state);
});

// Buttons
document.getElementById('resetBtn')?.addEventListener('click', () => {
  const next = { ...defaults };
  save(next);
  window.location.reload();
});

monitorToggle?.addEventListener('change', (e) => {
  if (e.target.checked) {
    wireMonitor();
  } else {
    teardownMonitor();
  }
});

// Live update monitor on changes
[gainSlider, bassSlider, trebleSlider, reverbSlider, nsToggle, bypassToggle].forEach((el) => {
  el?.addEventListener('input', () => {
    if (!monitorOn) return;
    // Rebuild to reflect new settings
    teardownMonitor();
    // slight delay to allow context close
    setTimeout(() => wireMonitor(), 10);
  });
  el?.addEventListener('change', () => {
    if (!monitorOn) return;
    teardownMonitor();
    setTimeout(() => wireMonitor(), 10);
  });
});


