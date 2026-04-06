import * as THREE from 'three';

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

    currentMouse.lerp(targetMouse, 0.06);

    // Update feedback uniforms
    feedbackUniforms.uTime.value = elapsed;
    feedbackUniforms.uMudSpeed.value = params.mudSpeed;
    feedbackUniforms.uParticleAmount.value = params.particleAmount;
    feedbackUniforms.uEmotionIntensity.value = params.emotionIntensity;
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
  }

  animate();

  console.log('[The Unburial Core]');
  console.log('↑/↓ : Mud Speed (Pressure)');
  console.log('←/→ : Particle Amount');
  console.log('n/m : Emotion Intensity');
}

init();
