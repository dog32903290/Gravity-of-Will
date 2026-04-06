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

  // Initialize Recorder (Press 'R' to toggle)
  const recorder = new WebglRecorder(renderer);

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

  // ---------- Audio state ----------
  let audioCtx = null;
  let audioPlaying = false;
  let audioNodes = null;

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

    // Update ALL feedback uniforms (GUI sliders + keyboard both write to params)
    feedbackUniforms.uTime.value = elapsed;
    feedbackUniforms.uMudSpeed.value = params.mudSpeed;
    feedbackUniforms.uBaseSharp.value = params.baseSharp;
    feedbackUniforms.uSharpK.value = params.sharpK;
    feedbackUniforms.uFeedbackDecay.value = params.feedbackDecay;
    feedbackUniforms.uZoomSpeed.value = params.zoomSpeed;
    feedbackUniforms.uRotationSpeed.value = params.rotationSpeed;
    feedbackUniforms.uParticleAmount.value = params.particleAmount;
    feedbackUniforms.uEmotionIntensity.value = params.emotionIntensity;
    feedbackUniforms.uParticleSize.value = params.particleSize;
    feedbackUniforms.uDensityCap.value = params.densityCap;
    feedbackUniforms.uCenterHoleSize.value = params.centerHoleSize;
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
  function handleMidiMessage(event) {
    const [status, cc, value] = event.data;
    if ((status & 0xF0) !== 0xB0) return;
    if (midiMappingTarget) {
      // 移除舊映射
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
      if (!paramName || !paramRanges[paramName]) return;
      const [min, max] = paramRanges[paramName];
      params[paramName] = min + (value / 127) * (max - min);
      if (guiControllers[paramName]) guiControllers[paramName].updateDisplay();
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
    bassGain.connect(masterGain);
    bassGain.connect(convolver);

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

    const orbGain = ctx.createGain();
    orbGain.gain.value = 0;

    orbOsc1.connect(orbGain);
    orbOsc2.connect(orbGain);
    orbGain.connect(masterGain);
    orbGain.connect(convolver);

    orbOsc1.start();
    orbOsc2.start();

    // ========== SOUND 3: 粒子 Particles (>1kHz) ==========
    const MAX_P = 16;
    // D 小調: F5 G5 A5 D6 E6 G6 A6 C7
    const minorFreqs = [698.46, 783.99, 880.00, 1174.66, 1318.51, 1567.98, 1760.00, 2093.00];
    // D 大調: G5 A5 D6 E6 F#6 B6 C#7 D7
    const majorFreqs = [783.99, 880.00, 1174.66, 1318.51, 1479.98, 1975.53, 2217.46, 2349.32];

    const pOscs = [];
    const pGains = [];
    const particleBus = ctx.createGain();
    particleBus.gain.value = 0.2;
    particleBus.connect(masterGain); // dry only, no reverb

    // 粒子 delay: particleSize 越大 feedback 越多
    const pDelay = ctx.createDelay(0.5);
    pDelay.delayTime.value = 0.12;
    const pDelayFb = ctx.createGain();
    pDelayFb.gain.value = 0;
    particleBus.connect(pDelay);
    pDelay.connect(pDelayFb);
    pDelayFb.connect(pDelay);
    pDelay.connect(masterGain);

    for (let i = 0; i < MAX_P; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = minorFreqs[i % minorFreqs.length];
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g);
      g.connect(particleBus);
      osc.start();
      pOscs.push(osc);
      pGains.push(g);
    }

    audioPlaying = true;
    console.log('[Audio] 已啟動 — 按空白鍵暫停/播放');

    audioNodes = {
      ctx, bassFilter, bassDelay, bassDelayFb, orbGain, orbOsc1, orbOsc2,
      orbActive: false, pOscs, pGains, MAX_P, minorFreqs, majorFreqs,
      midBoost, reverbGain, holeGain, holeFilter,
      pDelayFb, flangerDepth, flangerFb, flangerLfo,
    };
  }

  function updateAudio(elapsed) {
    if (!audioNodes || !audioPlaying) return;
    const n = audioNodes;
    const t = n.ctx.currentTime;

    // --- Sound 1: Bass ---
    const mudNorm = (params.mudSpeed - 0.0001) / (0.01 - 0.0001);
    n.bassFilter.frequency.setTargetAtTime(80 + mudNorm * 2420, t, 0.08);

    const decayNorm = (params.feedbackDecay - 0.90) / (0.999 - 0.90);
    n.bassDelayFb.gain.setTargetAtTime(decayNorm * 0.65, t, 0.08);
    n.bassDelay.delayTime.setTargetAtTime(0.05 + decayNorm * 0.25, t, 0.08);

    // --- Sound 2: Orb ---
    const shouldBeActive = params.baseSharp <= 5;
    // 隨機音高: D6 A6 C#6 E7 A7 B7
    const orbPitches = [1174.66, 1760.00, 1108.73, 2637.02, 3520.00, 3951.07];
    if (shouldBeActive && !n.orbActive) {
      const orbFreq = orbPitches[Math.floor(Math.random() * orbPitches.length)];
      n.orbOsc1.frequency.setTargetAtTime(orbFreq, t, 0.08);
      n.orbOsc2.frequency.setTargetAtTime(orbFreq * 1.002, t, 0.08);
      n.orbGain.gain.setTargetAtTime(params.emotionIntensity * 0.15, t, 0.7);
      n.orbActive = true;
    } else if (!shouldBeActive && n.orbActive) {
      n.orbGain.gain.setTargetAtTime(0, t, 0.3);
      n.orbActive = false;
    } else if (shouldBeActive) {
      n.orbGain.gain.setTargetAtTime(params.emotionIntensity * 0.15, t, 0.1);
    }

    // --- Rotation → mid boost + tighter reverb + flanger ---
    const rotNorm = params.rotationSpeed / 0.02;
    n.midBoost.gain.setTargetAtTime(rotNorm * 8, t, 0.08);
    n.reverbGain.gain.setTargetAtTime(0.25 - rotNorm * 0.15, t, 0.08);
    // Flanger: 越快越瘋狂
    n.flangerDepth.gain.setTargetAtTime(rotNorm * 0.004, t, 0.08);  // LFO depth
    n.flangerFb.gain.setTargetAtTime(rotNorm * 0.75, t, 0.08);      // feedback
    n.flangerLfo.frequency.setTargetAtTime(0.3 + rotNorm * 6, t, 0.08); // LFO speed

    // --- Sound 4: 中心黑洞 Abyss ---
    const holeNorm = params.centerHoleSize / 2.0;
    n.holeGain.gain.setTargetAtTime(holeNorm * 0.4, t, 0.15);
    // 黑洞越大 → cutoff 越低 (400Hz → 40Hz)，更暗更深
    n.holeFilter.frequency.setTargetAtTime(400 - holeNorm * 360, t, 0.08);

    // --- Sound 3: Particles ---
    const activeCount = Math.floor(params.particleAmount * n.MAX_P);
    const density = params.particleAmount;
    const pSize = params.particleSize;

    // particleSize → delay feedback (大顆粒更多回音)
    n.pDelayFb.gain.setTargetAtTime(Math.min(pSize * 0.15, 0.7), t, 0.08);

    // release/decay time constant: 小粒子短 (0.01s)，大粒子長 (0.3s)
    const releaseTC = 0.01 + pSize * 0.06;

    for (let i = 0; i < n.MAX_P; i++) {
      if (i < activeCount) {
        const mF = n.minorFreqs[i % n.minorFreqs.length];
        const MF = n.majorFreqs[i % n.majorFreqs.length];
        const baseFreq = mF + (MF - mF) * density;
        const drift = Math.sin(elapsed * (0.4 + i * 0.27) + i * 1.7) * 5;
        n.pOscs[i].frequency.setTargetAtTime(baseFreq + drift, t, 0.02);
        const vol = 0.04 * pSize;
        // 短 attack (0.01s) — 聽得到紋路
        n.pGains[i].gain.setTargetAtTime(vol, t, 0.01);
      } else {
        // release 隨 particleSize 變長
        n.pGains[i].gain.setTargetAtTime(0, t, releaseTC);
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

  // Toggle GUI with 'H' key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') {
      gui.domElement.style.display = gui.domElement.style.display === 'none' ? '' : 'none';
    }
  });

  console.log('[The Unburial Core]');
  console.log('Space : 啟動/暫停聲音');
  console.log('H : 顯示/隱藏控制面板');
  console.log('↑/↓ : Mud Speed');
  console.log('←/→ : Particle Amount');
  console.log('n/m : Emotion Intensity');
  console.log(',/. : Particle Size');
}

init();
