import * as THREE from 'three';
import GUI from 'lil-gui';
import { WebglRecorder } from './utils/recorder.js';

// ---------- Shader sources (inline fetch) ----------

async function loadShader(url) {
  const res = await fetch(url);
  return res.text();
}

async function init() {
  // Load shaders
  const [feedbackVert, feedbackFrag, outputFrag] = await Promise.all([
    loadShader('shaders/feedback.vert'),
    loadShader('shaders/feedback.frag'),
    loadShader('shaders/output.frag'),
  ]);

  // ---------- Renderer ----------
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  // Initialize Recorder (Press 'R' to toggle) — 1920×1080 + audio
  const recorder = new WebglRecorder(renderer, {
    width: 1080, height: 1920, // portrait
    maxDuration: 180,          // 3 min auto-stop
    getAudioStream: () => audioNodes?.audioDest?.stream,
    onStart: (w, h) => {
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
      rtA.setSize(w, h);
      rtB.setSize(w, h);
      feedbackUniforms.uResolution.value.set(w, h);
      outputUniforms.uResolution.value.set(w, h);
    },
    onStop: () => {
      const pr = Math.min(window.devicePixelRatio, 2);
      renderer.setPixelRatio(pr);
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h);
      rtA.setSize(w, h);
      rtB.setSize(w, h);
      feedbackUniforms.uResolution.value.set(w, h);
      outputUniforms.uResolution.value.set(w, h);
    },
  });

  // ---------- Scene & Camera (fullscreen quad) ----------
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.PlaneGeometry(2, 2);

  // ---------- Ping-pong FBO ----------
  const fboParams = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
  };
  let rtA = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, fboParams);
  let rtB = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, fboParams);

  // ---------- Uniforms (shared state) ----------
  const params = {
    mudSpeed: 0.001,
    baseSharp: 28.0,    // 極集中的紅光核心
    sharpK: 120.0,
    feedbackDecay: 0.988,
    zoomSpeed: 0.0008,  // 持續向內推進的主觀視角
    particleAmount: 0.5, // 白光粒子的數量
    emotionIntensity: 0.5, // 情緒強度
    rotationSpeed: 0.003, // 提升至兩倍：加速螺旋捲入感
    particleSize: 1.0,     // 粒子大小倍率
    densityCap: 0.4,       // 粒子密度上限
    centerHoleSize: 0.0,   // 中心黑洞大小
  };

  // ---------- MIDI mapping state ----------
  let midiMappingTarget = null;
  const midiMap = {};
  const midiMapBtns = {};
  const guiControllers = {};
  const paramRanges = {
    mudSpeed: [0.0001, 0.01], feedbackDecay: [0.90, 0.999],
    baseSharp: [3, 60], sharpK: [10, 400],
    particleAmount: [0, 1], densityCap: [0.05, 1.0],
    particleSize: [0.1, 5.0], emotionIntensity: [0, 1],
    centerHoleSize: [0, 2.0], zoomSpeed: [0, 0.005], rotationSpeed: [0, 0.02],
  };

  // ---------- LFO state (Ableton-style: each LFO → one target) ----------
  const lfos = Array.from({ length: 4 }, () => ({
    rate: 1, depth: 0.5, offset: 0, phase: 0, wave: 'sine',
    target: null, lastNoise: 0, noiseHold: 0,
  }));
  let lfoMappingMode = -1;

  function lfoWave(lfo, elapsed) {
    const p = elapsed * lfo.rate + lfo.phase;
    switch (lfo.wave) {
      case 'sine': return Math.sin(p * Math.PI * 2);
      case 'triangle': return Math.abs(((p % 1 + 1) % 1) * 4 - 2) - 1;
      case 'square': return ((p % 1 + 1) % 1) < 0.5 ? 1 : -1;
      case 'noise': {
        const period = lfo.rate > 0 ? 1 / lfo.rate : 9999;
        if (elapsed - lfo.noiseHold >= period) {
          lfo.lastNoise = Math.random() * 2 - 1;
          lfo.noiseHold = elapsed;
        }
        return lfo.lastNoise;
      }
      default: return 0;
    }
  }

  // modParams = base params + all LFO modulation
  const modParams = { ...params };
  function updateModParams(elapsed) {
    for (const key in params) modParams[key] = params[key];
    for (const lfo of lfos) {
      if (!lfo.target) continue;
      const wave = lfoWave(lfo, elapsed);

      if (lfo.target.startsWith('mix_')) {
        // Mixer param: mix_bass_vol → chKey=bass, param=vol
        const parts = lfo.target.split('_');
        const chKey = parts[1];
        const param = parts.slice(2).join('_');
        const handler = midiHandlers[lfo.target];
        if (!handler) continue;
        const { min, max } = handler;
        const span = max - min;
        const base = mixerParams[chKey][param];
        const offsetVal = lfo.offset * span;
        const swing = lfo.depth * span * 0.5;
        const v = Math.max(min, Math.min(max, base + offsetVal + wave * swing));
        applyMixerParam(chKey, param, v);
      } else if (paramRanges[lfo.target]) {
        const [min, max] = paramRanges[lfo.target];
        const span = max - min;
        const base = params[lfo.target];
        const offsetVal = lfo.offset * span;
        const swing = lfo.depth * span * 0.5;
        const v = Math.max(min, Math.min(max, base + offsetVal + wave * swing));
        modParams[lfo.target] = v;
      }
    }
  }

  // ---------- Audio state ----------
  let audioCtx = null;
  let audioPlaying = false;
  let audioNodes = null;

  // ---------- Mixer state (persists before audio init) ----------
  const mixerParams = {
    bass:      { vol: 1.0, eqLo: 0, eqMid: 0, eqHi: 0, width: 0 },
    orb:       { vol: 1.0, eqLo: 0, eqMid: 0, eqHi: 0, width: 0 },
    particles: { vol: 1.0, eqLo: 0, eqMid: 0, eqHi: 0, width: 0.5 },
  };

  let targetMouse = new THREE.Vector2(0.5, 0.5);
  let currentMouse = new THREE.Vector2(0.5, 0.5);

  // ---------- Feedback material ----------
  const feedbackUniforms = {
    uPrevFrame: { value: rtA.texture },
    uTime: { value: 0 },
    uMudSpeed: { value: params.mudSpeed },
    uBaseSharp: { value: params.baseSharp },
    uSharpK: { value: params.sharpK },
    uFeedbackDecay: { value: params.feedbackDecay },
    uZoomSpeed: { value: params.zoomSpeed },
    uRotationSpeed: { value: params.rotationSpeed },
    uParticleAmount: { value: params.particleAmount },
    uEmotionIntensity: { value: params.emotionIntensity },
    uParticleSize: { value: params.particleSize },
    uDensityCap: { value: params.densityCap },
    uCenterHoleSize: { value: params.centerHoleSize },
    uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
  };

  const feedbackMaterial = new THREE.ShaderMaterial({
    vertexShader: feedbackVert,
    fragmentShader: feedbackFrag,
    uniforms: feedbackUniforms,
  });

  const feedbackScene = new THREE.Scene();
  feedbackScene.add(new THREE.Mesh(quad, feedbackMaterial));

  // ---------- Output material ----------
  const outputUniforms = {
    uFinalFrame: { value: rtB.texture },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
  };

  const outputMaterial = new THREE.ShaderMaterial({
    vertexShader: feedbackVert, 
    fragmentShader: outputFrag,
    uniforms: outputUniforms,
  });

  const outputScene = new THREE.Scene();
  outputScene.add(new THREE.Mesh(quad.clone(), outputMaterial));

  // ---------- Clock ----------
  const clock = new THREE.Clock();

  // ---------- Keyboard controls ----------
  const keys = {};
  window.addEventListener('keydown', (e) => { keys[e.key] = true; });
  window.addEventListener('keyup', (e) => { keys[e.key] = false; });

  window.addEventListener('mousemove', (e) => {
    targetMouse.x = e.clientX / window.innerWidth;
    targetMouse.y = 1.0 - (e.clientY / window.innerHeight);
  });

  // ---------- Resize ----------
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);

    rtA.setSize(w, h);
    rtB.setSize(w, h);

    feedbackUniforms.uResolution.value.set(w, h);
    outputUniforms.uResolution.value.set(w, h);
  });

  // ---------- Animation loop ----------
  function animate() {
    requestAnimationFrame(animate);

    const elapsed = clock.getElapsedTime();

    // Keyboard controls
    if (keys['ArrowUp']) {
      params.mudSpeed = Math.min(params.mudSpeed + 0.00005, 0.005);
    }
    if (keys['ArrowDown']) {
      params.mudSpeed = Math.max(params.mudSpeed - 0.00005, 0.0001);
    }

    if (keys['ArrowLeft']) {
      params.particleAmount = Math.max(params.particleAmount - 0.002, 0.0);
    }
    if (keys['ArrowRight']) {
      params.particleAmount = Math.min(params.particleAmount + 0.002, 1.0);
    }

    if (keys['n']) {
      params.emotionIntensity = Math.max(params.emotionIntensity - 0.005, 0.0);
    }
    if (keys['m']) {
      params.emotionIntensity = Math.min(params.emotionIntensity + 0.005, 1.0);
    }

    if (keys[',']) {
      params.particleSize = Math.max(params.particleSize - 0.01, 0.1);
    }
    if (keys['.']) {
      params.particleSize = Math.min(params.particleSize + 0.01, 5.0);
    }

    currentMouse.lerp(targetMouse, 0.06);

    // Compute LFO-modulated params
    updateModParams(elapsed);

    // Update ALL feedback uniforms using modulated values
    feedbackUniforms.uTime.value = elapsed;
    feedbackUniforms.uMudSpeed.value = modParams.mudSpeed;
    feedbackUniforms.uBaseSharp.value = modParams.baseSharp;
    feedbackUniforms.uSharpK.value = modParams.sharpK;
    feedbackUniforms.uFeedbackDecay.value = modParams.feedbackDecay;
    feedbackUniforms.uZoomSpeed.value = modParams.zoomSpeed;
    feedbackUniforms.uRotationSpeed.value = modParams.rotationSpeed;
    feedbackUniforms.uParticleAmount.value = modParams.particleAmount;
    feedbackUniforms.uEmotionIntensity.value = modParams.emotionIntensity;
    feedbackUniforms.uParticleSize.value = modParams.particleSize;
    feedbackUniforms.uDensityCap.value = modParams.densityCap;
    feedbackUniforms.uCenterHoleSize.value = modParams.centerHoleSize;
    feedbackUniforms.uMouse.value.copy(currentMouse);
    feedbackUniforms.uPrevFrame.value = rtA.texture;

    // Pass 1: Feedback — read rtA, write rtB
    renderer.setRenderTarget(rtB);
    renderer.render(feedbackScene, camera);

    // Pass 2: Output — read rtB, write to screen
    outputUniforms.uFinalFrame.value = rtB.texture;
    renderer.setRenderTarget(null);
    renderer.render(outputScene, camera);

    // Swap buffers
    const temp = rtA;
    rtA = rtB;
    rtB = temp;

    // Update audio engine
    updateAudio(elapsed);
  }

  animate();

  // ============================================================
  // lil-gui — 即時控制面板
  // 所有 slider 變動直接寫入 params，animate loop 每幀同步到 uniforms
  // ============================================================
  const gui = new GUI({ title: 'The Unburial Core' });

  // --- 泥沼 (Mud) ---
  const fMud = gui.addFolder('泥沼 Mud');
  guiControllers['mudSpeed']      = fMud.add(params, 'mudSpeed', 0.0001, 0.01, 0.0001).name('向心流速');
  guiControllers['feedbackDecay'] = fMud.add(params, 'feedbackDecay', 0.90, 0.999, 0.001).name('反饋衰減');

  // --- 光球 (Orb) ---
  const fOrb = gui.addFolder('光球 Orb');
  guiControllers['baseSharp'] = fOrb.add(params, 'baseSharp', 3, 60, 0.5).name('銳度 (大小)');
  guiControllers['sharpK']    = fOrb.add(params, 'sharpK', 10, 400, 1).name('銳度耦合 K');

  // --- 粒子 (Particles) ---
  const fParticle = gui.addFolder('粒子 Particles');
  guiControllers['particleAmount']   = fParticle.add(params, 'particleAmount', 0, 1, 0.001).name('密度');
  guiControllers['densityCap']       = fParticle.add(params, 'densityCap', 0.05, 1.0, 0.01).name('密度上限');
  guiControllers['particleSize']     = fParticle.add(params, 'particleSize', 0.1, 5.0, 0.05).name('粒子大小');
  guiControllers['emotionIntensity'] = fParticle.add(params, 'emotionIntensity', 0, 1, 0.005).name('情緒強度');

  // --- 空間 (Space) ---
  const fSpace = gui.addFolder('空間 Space');
  guiControllers['centerHoleSize'] = fSpace.add(params, 'centerHoleSize', 0, 2.0, 0.01).name('中心黑洞');
  guiControllers['zoomSpeed']      = fSpace.add(params, 'zoomSpeed', 0, 0.005, 0.0001).name('Dolly 速度');
  guiControllers['rotationSpeed']  = fSpace.add(params, 'rotationSpeed', 0, 0.02, 0.0005).name('旋轉速度');

  // ---------- MIDI mapping ----------
  // midiHandlers: paramKey → { min, max, set(normalised 0-1) }
  // Populated as sliders are created (params, mixer, LFO)
  const midiHandlers = {};

  // Register all params sliders
  for (const [key, range] of Object.entries(paramRanges)) {
    const [min, max] = range;
    midiHandlers[key] = {
      min, max,
      set: (n) => {
        params[key] = min + n * (max - min);
        if (guiControllers[key]) guiControllers[key].updateDisplay();
      },
    };
  }

  function handleMidiMessage(event) {
    const [status, cc, value] = event.data;
    if ((status & 0xF0) !== 0xB0) return;
    if (midiMappingTarget) {
      const oldParam = midiMap[cc];
      if (oldParam && midiMapBtns[oldParam]) {
        midiMapBtns[oldParam].classList.remove('mapped');
        midiMapBtns[oldParam].textContent = 'M';
      }
      midiMap[cc] = midiMappingTarget;
      const btn = midiMapBtns[midiMappingTarget];
      if (btn) { btn.classList.remove('listening'); btn.classList.add('mapped'); btn.textContent = cc; }
      midiMappingTarget = null;
    } else {
      const paramName = midiMap[cc];
      const handler = midiHandlers[paramName];
      if (!handler) return;
      handler.set(value / 127);
    }
  }

  navigator.requestMIDIAccess?.().then(access => {
    for (const input of access.inputs.values()) input.onmidimessage = handleMidiMessage;
    access.onstatechange = (e) => {
      if (e.port.type === 'input' && e.port.state === 'connected') e.port.onmidimessage = handleMidiMessage;
    };
  }).catch(() => console.warn('Web MIDI API 不支援'));

  function toggleMidiMapping(paramName) {
    const btn = midiMapBtns[paramName];
    if (midiMappingTarget === paramName) {
      // 取消 listen
      midiMappingTarget = null;
      btn.classList.remove('listening');
      const cc = Object.keys(midiMap).find(k => midiMap[k] === paramName);
      btn.textContent = cc !== undefined ? cc : 'M';
      if (cc !== undefined) btn.classList.add('mapped');
    } else if (btn.classList.contains('mapped')) {
      // 取消映射
      const cc = Object.keys(midiMap).find(k => midiMap[k] === paramName);
      if (cc !== undefined) delete midiMap[cc];
      btn.classList.remove('mapped');
      btn.textContent = 'M';
    } else {
      // 進入 listen
      if (midiMappingTarget) {
        const prev = midiMapBtns[midiMappingTarget];
        if (prev) { prev.classList.remove('listening'); prev.textContent = 'M'; }
      }
      midiMappingTarget = paramName;
      btn.classList.add('listening');
      btn.textContent = '●';
    }
  }

  for (const [paramName, ctrl] of Object.entries(guiControllers)) {
    const row = ctrl.domElement;
    const btn = document.createElement('button');
    btn.className = 'midi-map-btn';
    btn.textContent = 'M';
    btn.title = `MIDI 映射：${paramName}`;
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleMidiMapping(paramName); });
    midiMapBtns[paramName] = btn;
    row.appendChild(btn);
  }

  // ============================================================
  // LFO — 4 Ableton-style modulation sources
  // Each LFO: Rate / Depth / Offset / Wave / Map button → one target
  // ============================================================
  const lfoWaveTypes = ['sine', 'triangle', 'square', 'noise'];
  const lfoTargetDisplays = []; // update target label per LFO

  for (let li = 0; li < 4; li++) {
    const lfo = lfos[li];
    const fLfo = gui.addFolder(`LFO ${li + 1}`);
    fLfo.close();

    // Wave type
    const waveObj = { wave: lfo.wave };
    fLfo.add(waveObj, 'wave', lfoWaveTypes).name('Wave').onChange(v => { lfo.wave = v; });

    const rateCtrl   = fLfo.add(lfo, 'rate',   0, 40,  0.01).name('Rate (Hz)');
    const depthCtrl  = fLfo.add(lfo, 'depth',  0, 1,   0.001).name('Depth');
    const offsetCtrl = fLfo.add(lfo, 'offset', -1, 1,  0.001).name('Offset');
    fLfo.add(lfo, 'phase', 0, 1, 0.001).name('Phase');

    // Register LFO sliders in guiControllers so MIDI M buttons get added automatically
    const lfoPrefix = `lfo${li + 1}`;
    guiControllers[`${lfoPrefix}_rate`]   = rateCtrl;
    guiControllers[`${lfoPrefix}_depth`]  = depthCtrl;
    guiControllers[`${lfoPrefix}_offset`] = offsetCtrl;
    midiHandlers[`${lfoPrefix}_rate`]   = { min: 0, max: 40, set: n => { lfo.rate   = n * 40;           rateCtrl.updateDisplay();   } };
    midiHandlers[`${lfoPrefix}_depth`]  = { min: 0, max: 1,  set: n => { lfo.depth  = n;              depthCtrl.updateDisplay();  } };
    midiHandlers[`${lfoPrefix}_offset`] = { min: -1, max: 1, set: n => { lfo.offset = n * 2 - 1;      offsetCtrl.updateDisplay(); } };

    // Map / Unmap button
    const mapState = { target: '-- none --' };
    const mapCtrl = fLfo.add(mapState, 'target').name('Target').disable();
    lfoTargetDisplays.push(mapCtrl);

    const mapActions = {
      Map: () => {
        if (lfoMappingMode === li) {
          lfoMappingMode = -1;
          gui.domElement.classList.remove('lfo-mapping');
          mixer.classList.remove('lfo-mapping');
        } else {
          lfoMappingMode = li;
          gui.domElement.classList.add('lfo-mapping');
          mixer.classList.add('lfo-mapping');
        }
      },
      Unmap: () => {
        lfo.target = null;
        mapState.target = '-- none --';
        mapCtrl.updateDisplay();
        lfoMappingMode = -1;
        gui.domElement.classList.remove('lfo-mapping');
        mixer.classList.remove('lfo-mapping');
      },
    };
    fLfo.add(mapActions, 'Map').name('▶ Map');
    fLfo.add(mapActions, 'Unmap').name('✕ Unmap');
  }

  // Add MIDI M buttons to LFO controllers (registered after the first M-button pass)
  for (const key of Object.keys(guiControllers)) {
    if (!key.startsWith('lfo')) continue;
    if (midiMapBtns[key]) continue; // already has one
    const ctrl = guiControllers[key];
    const row = ctrl.domElement;
    const btn = document.createElement('button');
    btn.className = 'midi-map-btn';
    btn.textContent = 'M';
    btn.title = `MIDI 映射：${key}`;
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleMidiMapping(key); });
    midiMapBtns[key] = btn;
    row.appendChild(btn);
  }

  // Click any gui controller row → assign as LFO target
  for (const [paramKey, ctrl] of Object.entries(guiControllers)) {
    ctrl.domElement.addEventListener('click', () => {
      if (lfoMappingMode < 0) return;
      const li = lfoMappingMode;
      lfos[li].target = paramKey;
      lfoTargetDisplays[li].setValue(paramKey);
      lfoMappingMode = -1;
      gui.domElement.classList.remove('lfo-mapping');
      mixer.classList.remove('lfo-mapping');
    });
  }

  // ============================================================
  // Audio Engine — Web Audio API (根音 D)
  // ============================================================
  function createReverbIR(ctx, duration, decay) {
    const len = ctx.sampleRate * duration;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function initAudio() {
    const ctx = new AudioContext();
    audioCtx = ctx;

    // --- Limiter (保護喇叭) ---
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.05;
    limiter.connect(ctx.destination);

    // --- Audio capture for recorder ---
    const audioDest = ctx.createMediaStreamDestination();
    limiter.connect(audioDest);

    // --- Master bus ---
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.7;

    // Mid-boost EQ: rotationSpeed 越快越突出中頻，聲音扎實
    const midBoost = ctx.createBiquadFilter();
    midBoost.type = 'peaking';
    midBoost.frequency.value = 1000;
    midBoost.Q.value = 1.2;
    midBoost.gain.value = 0;
    midBoost.connect(limiter);

    // Flanger: rotationSpeed 越快越瘋狂
    const flangerDelay = ctx.createDelay(0.02);
    flangerDelay.delayTime.value = 0.005;
    const flangerLfo = ctx.createOscillator();
    flangerLfo.type = 'sine';
    flangerLfo.frequency.value = 0.5;
    const flangerDepth = ctx.createGain();
    flangerDepth.gain.value = 0;
    flangerLfo.connect(flangerDepth);
    flangerDepth.connect(flangerDelay.delayTime);
    flangerLfo.start();
    const flangerFb = ctx.createGain();
    flangerFb.gain.value = 0;

    masterGain.connect(midBoost);           // dry path
    masterGain.connect(flangerDelay);       // wet path
    flangerDelay.connect(midBoost);
    flangerDelay.connect(flangerFb);
    flangerFb.connect(flangerDelay);

    // --- Reverb ---
    const convolver = ctx.createConvolver();
    convolver.buffer = createReverbIR(ctx, 2.5, 2.0);
    const reverbGain = ctx.createGain();
    reverbGain.gain.value = 0.25;
    convolver.connect(reverbGain);
    reverbGain.connect(limiter);

    // --- Channel strip helper (EQ + Vol + Haas width) ---
    function makeStrip(dest, revDest) {
      const eqLo = ctx.createBiquadFilter();
      eqLo.type = 'lowshelf'; eqLo.frequency.value = 200; eqLo.gain.value = 0;
      const eqMid = ctx.createBiquadFilter();
      eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1; eqMid.gain.value = 0;
      const eqHi = ctx.createBiquadFilter();
      eqHi.type = 'highshelf'; eqHi.frequency.value = 4000; eqHi.gain.value = 0;
      const vol = ctx.createGain();
      vol.gain.value = 1.0;
      const widthDelay = ctx.createDelay(0.03);
      widthDelay.delayTime.value = 0;
      const merger = ctx.createChannelMerger(2);
      eqLo.connect(eqMid); eqMid.connect(eqHi); eqHi.connect(vol);
      vol.connect(merger, 0, 0);
      vol.connect(widthDelay);
      widthDelay.connect(merger, 0, 1);
      merger.connect(dest);
      if (revDest) merger.connect(revDest);
      return { input: eqLo, eqLo, eqMid, eqHi, vol, widthDelay };
    }

    // --- Particle strip (no Haas — width via per-voice panners) ---
    function makeParticleStrip(dest) {
      const eqLo = ctx.createBiquadFilter();
      eqLo.type = 'lowshelf'; eqLo.frequency.value = 200; eqLo.gain.value = 0;
      const eqMid = ctx.createBiquadFilter();
      eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1; eqMid.gain.value = 0;
      const eqHi = ctx.createBiquadFilter();
      eqHi.type = 'highshelf'; eqHi.frequency.value = 4000; eqHi.gain.value = 0;
      const vol = ctx.createGain();
      vol.gain.value = 1.0;
      eqLo.connect(eqMid); eqMid.connect(eqHi); eqHi.connect(vol);
      vol.connect(dest);
      return { input: eqLo, eqLo, eqMid, eqHi, vol };
    }

    // ========== SOUND 4: 中心黑洞 Abyss ==========
    // D1 (36.71Hz) sine — 深不見底的黑暗
    const holeOsc = ctx.createOscillator();
    holeOsc.type = 'sine';
    holeOsc.frequency.value = 36.71; // D1

    // 第二振盪器: 低八度 D0 (18.35Hz) — 體感震動
    const holeOsc2 = ctx.createOscillator();
    holeOsc2.type = 'sine';
    holeOsc2.frequency.value = 18.35;

    // Lowpass: 黑洞越大 cutoff 越低 (更暗更悶)
    const holeFilter = ctx.createBiquadFilter();
    holeFilter.type = 'lowpass';
    holeFilter.frequency.value = 400;
    holeFilter.Q.value = 1;

    const holeGain = ctx.createGain();
    holeGain.gain.value = 0;

    // 黑洞專屬長 reverb (5 秒，深不見底)
    const holeConvolver = ctx.createConvolver();
    holeConvolver.buffer = createReverbIR(ctx, 5.0, 1.2);
    const holeReverbGain = ctx.createGain();
    holeReverbGain.gain.value = 0.5;

    holeOsc.connect(holeFilter);
    holeOsc2.connect(holeFilter);
    holeFilter.connect(holeGain);
    holeGain.connect(midBoost); // dry path
    holeGain.connect(holeConvolver);
    holeConvolver.connect(holeReverbGain);
    holeReverbGain.connect(limiter);

    holeOsc.start();
    holeOsc2.start();

    // ========== SOUND 1: 黑色泥沼 Bass Drone ==========
    // D2 (73.42Hz) sawtooth + D1 (36.71Hz) sine sub
    const bassOsc = ctx.createOscillator();
    bassOsc.type = 'sawtooth';
    bassOsc.frequency.value = 73.42;

    const bassSub = ctx.createOscillator();
    bassSub.type = 'sine';
    bassSub.frequency.value = 36.71;

    // Lowpass: mudSpeed 控制 cutoff (低=吼 80Hz, 高=呲 2500Hz)
    const bassFilter = ctx.createBiquadFilter();
    bassFilter.type = 'lowpass';
    bassFilter.frequency.value = 200;
    bassFilter.Q.value = 2;

    // Delay: feedbackDecay 控制回音量
    const bassDelay = ctx.createDelay(1.0);
    bassDelay.delayTime.value = 0.15;
    const bassDelayFb = ctx.createGain();
    bassDelayFb.gain.value = 0.2;
    const bassDelayHpf = ctx.createBiquadFilter();
    bassDelayHpf.type = 'highpass';
    bassDelayHpf.frequency.value = 300;

    const bassGain = ctx.createGain();
    bassGain.gain.value = 0.35;
    const bassSubGain = ctx.createGain();
    bassSubGain.gain.value = 0.25;

    bassOsc.connect(bassFilter);
    bassSub.connect(bassSubGain);
    bassSubGain.connect(bassFilter);
    bassFilter.connect(bassGain);
    bassFilter.connect(bassDelay);
    bassDelay.connect(bassDelayHpf);
    bassDelayHpf.connect(bassDelayFb);
    bassDelayFb.connect(bassDelay);
    bassDelay.connect(bassGain);
    const bassStrip = makeStrip(masterGain, convolver);
    bassGain.connect(bassStrip.input);

    bassOsc.start();
    bassSub.start();

    // ========== SOUND 2: 黃色光球 Orb (~1kHz) ==========
    // D6 (1174.66Hz) sine × 2 微 detune
    const orbOsc1 = ctx.createOscillator();
    orbOsc1.type = 'sine';
    orbOsc1.frequency.value = 1174.66;

    const orbOsc2 = ctx.createOscillator();
    orbOsc2.type = 'sine';
    orbOsc2.frequency.value = 1174.66 * 1.002;

    // Emotion overtones: sub (-8va) + fifth (+P5)
    const orbOscSub = ctx.createOscillator();
    orbOscSub.type = 'sine';
    orbOscSub.frequency.value = 1174.66 / 2;
    const orbSubGain = ctx.createGain();
    orbSubGain.gain.value = 0;

    const orbOsc5th = ctx.createOscillator();
    orbOsc5th.type = 'sine';
    orbOsc5th.frequency.value = 1174.66 * 1.5;
    const orb5thGain = ctx.createGain();
    orb5thGain.gain.value = 0;

    const orbGain = ctx.createGain();
    orbGain.gain.value = 0;

    orbOsc1.connect(orbGain);
    orbOsc2.connect(orbGain);
    orbOscSub.connect(orbSubGain);
    orbSubGain.connect(orbGain);
    orbOsc5th.connect(orb5thGain);
    orb5thGain.connect(orbGain);
    const orbStrip = makeStrip(masterGain, convolver);
    orbGain.connect(orbStrip.input);

    orbOsc1.start();
    orbOsc2.start();
    orbOscSub.start();
    orbOsc5th.start();

    // ========== SOUND 3: 粒子 Particles — Hi-hat Noise ==========
    const MAX_P = 24;

    // 共用白噪聲 buffer (2 秒)
    const noiseBufLen = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, noiseBufLen, ctx.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseBufLen; i++) noiseData[i] = Math.random() * 2 - 1;

    const pSources = [];
    const pBPFs = [];
    const pHPFs = [];
    const pGains = [];
    const pPans = [];
    const pState = [];
    const particleBus = ctx.createGain();
    particleBus.gain.value = 0.6;
    const pStrip = makeParticleStrip(masterGain);

    // --- 3 formant resonators (peaking EQ, high Q, freq driven by noise LFO) ---
    const FORMANT_COUNT = 3;
    // Base center freqs spread across 1000~2500Hz
    const formantBaseFqs = [1100, 1700, 2300];
    const formantFilters = formantBaseFqs.map(f => {
      const flt = ctx.createBiquadFilter();
      flt.type = 'peaking';
      flt.frequency.value = f;
      flt.Q.value = 18;
      flt.gain.value = 14; // dB boost
      return flt;
    });
    // Noise LFO state per formant (S&H-style random walk)
    const formantState = formantBaseFqs.map(f => ({
      freq: f, target: f, lastHold: 0, holdTime: 0.4 + Math.random() * 0.6,
    }));

    // Chain: particleBus → f0 → f1 → f2 → pStrip
    particleBus.connect(formantFilters[0]);
    for (let k = 1; k < FORMANT_COUNT; k++) formantFilters[k - 1].connect(formantFilters[k]);
    formantFilters[FORMANT_COUNT - 1].connect(pStrip.input);

    for (let i = 0; i < MAX_P; i++) {
      // Noise source (loop shared buffer)
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      // Offset each voice's start position to avoid correlation
      src.loopStart = (i / MAX_P) * 2;
      src.loopEnd = 2;

      // Bandpass: center freq spread across 1000~2500Hz
      const bpf = ctx.createBiquadFilter();
      bpf.type = 'bandpass';
      bpf.frequency.value = 500 + (i / MAX_P) * 2000;
      bpf.Q.value = 3 + (i / MAX_P) * 2;

      // HPF: emotionIntensity control
      const hpf = ctx.createBiquadFilter();
      hpf.type = 'highpass';
      hpf.frequency.value = 800;
      hpf.Q.value = 0.7;

      const g = ctx.createGain();
      g.gain.value = 0;

      const pan = ctx.createStereoPanner();
      pan.pan.value = 0;

      src.connect(bpf);
      bpf.connect(hpf);
      hpf.connect(g);
      g.connect(pan);
      pan.connect(particleBus);
      src.start();

      pSources.push(src);
      pBPFs.push(bpf);
      pHPFs.push(hpf);
      pGains.push(g);
      pPans.push(pan);
      pState.push({ phase: (i / MAX_P) * 1.0, gateOpen: false });
    }

    audioPlaying = true;
    console.log('[Audio] 已啟動 — 按空白鍵暫停/播放');

    // Apply saved mixer params
    [['bass', bassStrip], ['orb', orbStrip], ['particles', pStrip]].forEach(([key, strip]) => {
      const mp = mixerParams[key];
      strip.eqLo.gain.value = mp.eqLo;
      strip.eqMid.gain.value = mp.eqMid;
      strip.eqHi.gain.value = mp.eqHi;
      strip.vol.gain.value = mp.vol;
      if (strip.widthDelay) strip.widthDelay.delayTime.value = mp.width * 0.015;
    });

    audioNodes = {
      ctx, bassFilter, bassDelay, bassDelayFb,
      orbGain, orbOsc1, orbOsc2, orbOscSub, orbOsc5th, orbSubGain, orb5thGain,
      orbActive: false,
      pGains, pBPFs, pHPFs, pPans, MAX_P, pState, lastElapsed: 0,
      formantFilters, formantState,
      midBoost, reverbGain, holeGain, holeFilter,
      flangerDepth, flangerFb, flangerLfo,
      bassStrip, orbStrip, pStrip, audioDest,
    };
  }

  function updateAudio(elapsed) {
    if (!audioNodes || !audioPlaying) return;
    const n = audioNodes;
    const t = n.ctx.currentTime;

    // --- Sound 1: Bass ---
    const mudNorm = (modParams.mudSpeed - 0.0001) / (0.01 - 0.0001);
    n.bassFilter.frequency.setTargetAtTime(80 + mudNorm * 2420, t, 0.08);

    const decayNorm = (modParams.feedbackDecay - 0.90) / (0.999 - 0.90);
    n.bassDelayFb.gain.setTargetAtTime(decayNorm * 0.65, t, 0.08);
    n.bassDelay.delayTime.setTargetAtTime(0.05 + decayNorm * 0.25, t, 0.08);

    // --- Sound 2: Orb ---
    const ei = modParams.emotionIntensity;
    const shouldBeActive = modParams.baseSharp <= 5;
    const orbPitches = [1174.66, 1760.00, 1108.73, 2637.02, 3520.00, 3951.07];
    if (shouldBeActive && !n.orbActive) {
      const orbFreq = orbPitches[Math.floor(Math.random() * orbPitches.length)];
      n.orbOsc1.frequency.setTargetAtTime(orbFreq, t, 0.08);
      n.orbOsc2.frequency.setTargetAtTime(orbFreq * 1.002, t, 0.08);
      n.orbOscSub.frequency.setTargetAtTime(orbFreq / 2, t, 0.08);
      n.orbOsc5th.frequency.setTargetAtTime(orbFreq * 1.5, t, 0.08);
      n.orbGain.gain.setTargetAtTime(ei * 0.15, t, 0.7);
      n.orbActive = true;
    } else if (!shouldBeActive && n.orbActive) {
      n.orbGain.gain.setTargetAtTime(0, t, 0.3);
      n.orbActive = false;
    } else if (shouldBeActive) {
      n.orbGain.gain.setTargetAtTime(ei * 0.15, t, 0.1);
    }
    // Emotion → orb overtone richness (sub -8va + fifth +P5)
    n.orbSubGain.gain.setTargetAtTime(ei * 0.8, t, 0.1);
    n.orb5thGain.gain.setTargetAtTime(ei * 0.5, t, 0.1);

    // --- Rotation → mid boost + tighter reverb + flanger ---
    const rotNorm = modParams.rotationSpeed / 0.02;
    n.midBoost.gain.setTargetAtTime(rotNorm * 8, t, 0.08);
    n.reverbGain.gain.setTargetAtTime(0.25 - rotNorm * 0.15, t, 0.08);
    // Flanger: 越快越瘋狂
    n.flangerDepth.gain.setTargetAtTime(rotNorm * 0.004, t, 0.08);  // LFO depth
    n.flangerFb.gain.setTargetAtTime(rotNorm * 0.75, t, 0.08);      // feedback
    n.flangerLfo.frequency.setTargetAtTime(0.3 + rotNorm * 6, t, 0.08); // LFO speed

    // --- Sound 4: 中心黑洞 Abyss ---
    const holeNorm = modParams.centerHoleSize / 2.0;
    n.holeGain.gain.setTargetAtTime(holeNorm * 0.4, t, 0.15);
    // 黑洞越大 → cutoff 越低 (400Hz → 40Hz)，更暗更深
    n.holeFilter.frequency.setTargetAtTime(400 - holeNorm * 360, t, 0.08);

    // --- Sound 3: Particles — Hi-hat Noise ---
    // densityCap → poly count (2~24)
    const polyCount = 2 + Math.round(modParams.densityCap * 22);
    const activeCount = Math.min(Math.floor(modParams.particleAmount * polyCount), polyCount);
    const density = modParams.particleAmount;
    const pSize = modParams.particleSize;
    const dt = elapsed - n.lastElapsed;
    n.lastElapsed = elapsed;

    // 觸發速率：5 Hz (稀疏) → 40 Hz (密集)
    const trigRate = 5 + density * 35;
    // Envelope: particleSize → attack + decay
    const attackTC = 0.001 + (pSize / 5.0) * 0.049;  // 0.001s ~ 0.05s
    const decayTC  = 0.01  + (pSize / 5.0) * 0.29;   // 0.01s  ~ 0.3s
    const gateRatio = Math.min(0.15 + pSize * 0.12, 0.85);
    // Auto-pan
    const panSpeed = 0.2 + (pSize / 5.0) * 3.8;
    const panWidth = mixerParams.particles.width;
    // emotionIntensity → HPF cutoff (800 ~ 3000 Hz)
    const hpfCutoff = 800 + ei * 2200;

    // --- Formant resonators: S&H noise LFO drives center freq ---
    for (let k = 0; k < n.formantState.length; k++) {
      const fs = n.formantState[k];
      if (elapsed - fs.lastHold >= fs.holdTime) {
        // Pick new random target within 1000~2500Hz band
        fs.target = 1000 + Math.random() * 1500;
        // Randomise next hold duration (0.15 ~ 0.8s, faster when dense)
        fs.holdTime = (0.15 + Math.random() * 0.65) / (0.5 + density);
        fs.lastHold = elapsed;
      }
      // Smooth glide toward target
      fs.freq += (fs.target - fs.freq) * Math.min(dt * 6, 1);
      n.formantFilters[k].frequency.setValueAtTime(fs.freq, t);
      // Q rises with density (sparse=8, dense=30) and emotion tightens it further
      n.formantFilters[k].Q.setValueAtTime(8 + density * 22 + ei * 10, t);
    }

    for (let i = 0; i < n.MAX_P; i++) {
      const st = n.pState[i];

      // Update HPF for all voices
      n.pHPFs[i].frequency.setTargetAtTime(hpfCutoff, t, 0.08);

      if (i < activeCount) {
        // Phase 推進 — golden ratio 錯開
        const goldenOffset = (i * 0.618) % 1;
        const voiceRate = trigRate * (0.7 + goldenOffset * 0.6);
        st.phase += dt * voiceRate;
        if (st.phase >= 1) st.phase -= Math.floor(st.phase);
        const gateOn = st.phase <= gateRatio;

        // Auto-pan
        const voicePanSpeed = panSpeed * (0.5 + goldenOffset);
        const panVal = Math.sin(elapsed * voicePanSpeed + i * 1.7) * panWidth;
        n.pPans[i].pan.setTargetAtTime(Math.max(-1, Math.min(1, panVal)), t, 0.02);

        if (gateOn && !st.gateOpen) {
          st.gateOpen = true;
          n.pGains[i].gain.setTargetAtTime(0.06, t, attackTC);
        } else if (!gateOn && st.gateOpen) {
          st.gateOpen = false;
          n.pGains[i].gain.setTargetAtTime(0, t, decayTC);
        }
      } else {
        if (st.gateOpen) {
          st.gateOpen = false;
          n.pGains[i].gain.setTargetAtTime(0, t, 0.01);
          n.pPans[i].pan.setTargetAtTime(0, t, 0.05);
        }
      }
    }
  }

  // --- 空白鍵: 啟動/暫停音頻 ---
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (!audioCtx) { initAudio(); return; }
      if (audioCtx.state === 'running') {
        audioCtx.suspend();
        audioPlaying = false;
        console.log('[Audio] 暫停');
      } else {
        audioCtx.resume();
        audioPlaying = true;
        console.log('[Audio] 播放');
      }
    }
  });

  // ============================================================
  // Mixer UI — 3 channel strips (Bass / Orb / Particles)
  // ============================================================
  const mixer = document.createElement('div');
  mixer.id = 'mixer';

  const mixerChannels = [
    { key: 'bass', label: 'Bass Drone', stripKey: 'bassStrip' },
    { key: 'orb', label: 'Orb', stripKey: 'orbStrip' },
    { key: 'particles', label: 'Particles', stripKey: 'pStrip' },
  ];

  function applyMixerParam(chKey, param, value) {
    mixerParams[chKey][param] = value;
    if (!audioNodes) return;
    const strip = audioNodes[mixerChannels.find(c => c.key === chKey).stripKey];
    if (!strip) return;
    if (param === 'vol') strip.vol.gain.value = value;
    else if (param === 'eqLo') strip.eqLo.gain.value = value;
    else if (param === 'eqMid') strip.eqMid.gain.value = value;
    else if (param === 'eqHi') strip.eqHi.gain.value = value;
    else if (param === 'width' && strip.widthDelay) strip.widthDelay.delayTime.value = value * 0.015;
    // particles width is read from mixerParams in updateAudio
  }

  mixerChannels.forEach(ch => {
    const div = document.createElement('div');
    div.className = 'mix-ch';

    const label = document.createElement('div');
    label.className = 'mix-label';
    label.textContent = ch.label;
    div.appendChild(label);

    const controls = [
      { name: 'Hi',  param: 'eqHi',  min: -12, max: 12, step: 0.5, def: 0, fmt: v => (v > 0 ? '+' : '') + v + 'dB' },
      { name: 'Mid', param: 'eqMid', min: -12, max: 12, step: 0.5, def: 0, fmt: v => (v > 0 ? '+' : '') + v + 'dB' },
      { name: 'Lo',  param: 'eqLo',  min: -12, max: 12, step: 0.5, def: 0, fmt: v => (v > 0 ? '+' : '') + v + 'dB' },
      { name: 'Vol', param: 'vol',    min: 0,   max: 1.5, step: 0.01, def: 1.0, fmt: v => Math.round(v * 100) + '%' },
      { name: 'W',   param: 'width',  min: 0,   max: 1,  step: 0.01, def: ch.key === 'particles' ? 0.5 : 0, fmt: v => Math.round(v * 100) + '%' },
    ];

    controls.forEach(c => {
      const row = document.createElement('div');
      row.className = 'mix-row';

      const mKey = `mix_${ch.key}_${c.param}`;
      midiHandlers[mKey] = {
        min: c.min, max: c.max,
        set: (n) => {
          const v = c.min + n * (c.max - c.min);
          slider.value = v;
          val.textContent = c.fmt(v);
          applyMixerParam(ch.key, c.param, v);
        },
      };

      // Label — click to enter MIDI mapping or LFO mapping
      const lbl = document.createElement('span');
      lbl.textContent = c.name;
      lbl.style.cursor = 'pointer';
      lbl.title = `點擊映射 MIDI / LFO：${ch.label} ${c.name}`;
      lbl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (lfoMappingMode >= 0) {
          const li = lfoMappingMode;
          lfos[li].target = mKey;
          lfoTargetDisplays[li].setValue(mKey);
          lfoMappingMode = -1;
          gui.domElement.classList.remove('lfo-mapping');
          mixer.classList.remove('lfo-mapping');
        } else {
          toggleMidiMapping(mKey);
        }
      });
      midiMapBtns[mKey] = lbl;

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = c.min; slider.max = c.max; slider.step = c.step; slider.value = c.def;
      const val = document.createElement('span');
      val.className = 'mix-val';
      val.textContent = c.fmt(c.def);
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        val.textContent = c.fmt(v);
        applyMixerParam(ch.key, c.param, v);
      });

      row.appendChild(lbl);
      row.appendChild(slider);
      row.appendChild(val);
      div.appendChild(row);
    });

    mixer.appendChild(div);
  });

  document.body.appendChild(mixer);

  // Toggle GUI + Mixer with 'H' key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') {
      const hidden = gui.domElement.style.display === 'none';
      gui.domElement.style.display = hidden ? '' : 'none';
      mixer.style.display = hidden ? '' : 'none';
    }
  });

  // ---------- Fullscreen toggle ----------
  const fsBtn = document.createElement('button');
  fsBtn.className = 'fullscreen-btn';
  fsBtn.textContent = '⛶';
  fsBtn.title = '全螢幕 (F)';
  document.body.appendChild(fsBtn);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }

  fsBtn.addEventListener('click', toggleFullscreen);

  document.addEventListener('fullscreenchange', () => {
    fsBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
    fsBtn.title = document.fullscreenElement ? '退出全螢幕 (F)' : '全螢幕 (F)';
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') {
      toggleFullscreen();
    }
  });

  console.log('[The Unburial Core]');
  console.log('Space : 啟動/暫停聲音');
  console.log('H : 顯示/隱藏控制面板');
  console.log('F : 全螢幕');
  console.log('↑/↓ : Mud Speed');
  console.log('←/→ : Particle Amount');
  console.log('n/m : Emotion Intensity');
  console.log(',/. : Particle Size');
}

init();
