precision highp float;

uniform sampler2D uPrevFrame;
uniform float uTime;
uniform float uMudSpeed;
uniform float uBaseSharp;
uniform float uSharpK;
uniform float uFeedbackDecay;
uniform float uZoomSpeed;
uniform float uRotationSpeed;
uniform float uParticleAmount;
uniform float uEmotionIntensity;
uniform vec2 uResolution;

varying vec2 vUv;

// --- Noise utilities ---

float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);

  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float val = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 5; i++) {
    val += amp * noise(p * freq);
    freq *= 2.0;
    amp *= 0.5;
    p += vec2(1.7, 9.2);
  }
  return val;
}

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

float voronoi(vec2 x, out vec2 cellCenter) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float F1 = 8.0;
  float F2 = 8.0;
  vec2 bestCell = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash2(n + g);
      vec2 r = g - f + o;
      float d = dot(r, r);
      if (d < F1) {
        F2 = F1;
        F1 = d;
        bestCell = n + g + o;
      } else if (d < F2) {
        F2 = d;
      }
    }
  }
  cellCenter = bestCell;
  return sqrt(F2) - sqrt(F1);
}

void main() {
  vec2 uv = vUv;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);

  // ORB WANDER
  vec2 orbWander = vec2(
    fbm(vec2(uTime * 0.03, 0.0)) - 0.5,
    fbm(vec2(0.0, uTime * 0.03 + 50.0)) - 0.5
  ) * 0.4;
  vec2 center = vec2(0.5) + orbWander;

  // SPIRAL DOLLY IN
  vec2 fromCenter = uv - center;
  float rDist = length(fromCenter * aspect);
  float dollyAmount = uZoomSpeed * (1.0 + rDist * 3.0);
  float ang = uRotationSpeed;
  float s = sin(ang);
  float c = cos(ang);
  mat2 rot = mat2(c, -s, s, c);
  float barrel = 1.0 + rDist * rDist * 0.15;
  vec2 rotatedFromCenter = rot * fromCenter;
  vec2 zoomUV = center + rotatedFromCenter * (1.0 - dollyAmount) * barrel;

  vec2 diff = center - uv;
  vec2 diffAspect = diff * aspect;
  float distFromCenter = length(diffAspect);
  vec2 toCenter = distFromCenter > 0.001 ? normalize(diff) : vec2(0.0);

  // ============================================================
  // CONCENTRIC RIPPLE DYNAMICS
  // ============================================================
  float r = distFromCenter;
  float rippleFreq = 25.0; 
  float ripplePhase = uTime * uMudSpeed * 200.0;
  float ringWarp = fbm(uv * 4.0 + uTime * 0.02);
  float rDistorted = r + ringWarp * 0.05;
  float ringID = floor(rDistorted * rippleFreq);
  float ringHash = hash(vec2(ringID, 13.0));
  float ringDrift = mix(0.8, 1.2, ringHash);
  vec2 warp = vec2(
    fbm(uv * 5.0 + uTime * 0.012),
    fbm(uv * 5.0 + 50.0 + uTime * 0.012)
  );
  vec2 moveCoords = uv - toCenter * (uTime * 0.015 * (1.0 + (1.0-r)*0.5));
  vec2 cellCenter;
  float mudTexture = voronoi(moveCoords * 10.0 + warp * 0.3, cellCenter);

  // ============================================================
  // BI-DIRECTIONAL EMOTIONAL PARTICLES (DENSITY x2)
  // ============================================================
  vec3 particlesRGB = vec3(0.0);
  float particleEffectScalar = 0.0;
  float angle = atan(diffAspect.y, diffAspect.x);
  float numSpokes = 120.0;

  for (int ii = 0; ii < 24; ii++) { // Increased to 24
      float fi = float(ii);
      float speed = 0.06;
      float phaseOffset = fi * 0.0416; // 1.0 / 24.0
      float cycle = floor(uTime * speed + phaseOffset);
      float t = fract(uTime * speed + phaseOffset);

      float rayAngle = angle + fbm(uv * 5.0 + uTime * 0.04) * 0.2;
      float normalizedAngle = fract(rayAngle / 6.28318);
      float angleGrid = floor(normalizedAngle * numSpokes);
      
      float h = hash(vec2(angleGrid, cycle * 7.33 + fi));
      float isParticle = step(1.0 - mix(0.0001, 0.4, uParticleAmount), h);

      float energyHash = hash(vec2(h, 44.0));
      float satIndiv = hash(vec2(h, 22.0)); 
      float emotionPower = mix(1.0, 10.0, uEmotionIntensity); 
      float emotionForce = mix(0.2, 8.0, pow(energyHash, emotionPower)); 
      float emotionalT = pow(t, mix(0.4, 2.5, hash(vec2(h, 33.0))));

      bool isInward = (mod(fi, 2.0) > 0.5);
      float expectedRadius;
      vec3 particleColor;
      float dotSize;
      float sharpnessP;
      float pushSign;
      float fade;
      float intensityMix = smoothstep(0.1, 5.0, emotionForce);

      if (!isInward) {
          // YELLOW/GOLD (OUTWARD)
          expectedRadius = emotionalT * 1.3 * emotionForce; 
          vec3 desat = vec3(0.4, 0.35, 0.3);
          vec3 vivid = vec3(1.0, 0.4, 0.0);
          vec3 peak = vec3(1.0, 0.95, 0.4);
          particleColor = mix(mix(desat, vivid, satIndiv), peak, intensityMix * satIndiv);
          dotSize = mix(0.0015, 0.008, t); 
          sharpnessP = mix(0.95, 0.05, t); 
          pushSign = 1.0; 
          fade = smoothstep(0.0, 0.1, t) * smoothstep(1.0, 0.7, t);
      } else {
          // BLUE/CYAN (INWARD)
          float startR = 1.3 * (1.0 + emotionForce * 0.1); 
          float endR = 0.15; 
          expectedRadius = mix(startR, endR, emotionalT);
          vec3 desat = vec3(0.3, 0.35, 0.4);
          vec3 vivid = vec3(0.0, 0.3, 1.0);
          vec3 peak = vec3(0.4, 1.0, 1.0);
          particleColor = mix(mix(desat, vivid, satIndiv), peak, intensityMix * satIndiv);
          dotSize = mix(0.025, 0.0015, t);  
          sharpnessP = mix(0.02, 0.98, t); 
          pushSign = -1.8; 
          fade = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.7, 0.95, t));
      }

      float distToParticle = abs(distFromCenter - expectedRadius);
      float spokeCenter = (angleGrid + 0.1 + 0.8 * hash(vec2(h, 11.0))) / numSpokes;
      float angularDiff = abs(normalizedAngle - spokeCenter);
      angularDiff = min(angularDiff, 1.0 - angularDiff);
      float cartesianAngDist = angularDiff * 6.28318 * distFromCenter;
      float trueDist = sqrt(distToParticle * distToParticle + cartesianAngDist * cartesianAngDist);
      
      float dotShape = smoothstep(dotSize, dotSize * sharpnessP, trueDist) * isParticle;
      float intensity = dotShape * fade * (1.5 + emotionForce * 0.6) * 3.2;
      particlesRGB += particleColor * intensity;
      particleEffectScalar += dotShape * fade * emotionForce * 0.5 * pushSign;
  }
  
  float particleFade = exp(-distFromCenter * 1.5);
  vec3 finalParticles = particlesRGB * particleFade;
  float particlePush = particleEffectScalar * particleFade * 0.06;

  vec2 sampleUV = zoomUV - toCenter * uMudSpeed * ringDrift * 1.5 + toCenter * particlePush;
  sampleUV = clamp(sampleUV, 0.0, 1.0);

  float angleF = atan(diffAspect.y, diffAspect.x);
  float decayNoise = fbm(vec2(angleF * 12.0, uTime * 0.1));
  float localDecay = uFeedbackDecay - mix(0.0, 0.12, pow(decayNoise, 2.0));
  vec4 prev = texture2D(uPrevFrame, sampleUV) * localDecay;

  float cracks = smoothstep(0.0, 0.05, mudTexture);
  float plateShade = mix(0.015, 0.045, hash(cellCenter));
  float grain = noise(uv * 150.0 + uTime * 0.1) * 0.01;
  plateShade += grain;
  float edge = smoothstep(0.05, 0.0, mudTexture) * smoothstep(-0.02, 0.05, mudTexture);
  plateShade += edge * 0.02;
  float mudVignette = 1.0 - smoothstep(0.2, 0.85, distFromCenter);
  plateShade *= mudVignette;

  vec3 finalMudColor = vec3(plateShade) * cracks;

  vec3 result = prev.rgb + finalMudColor * 0.12 + finalParticles;
  result = result / (1.0 + result * 0.1);
  gl_FragColor = vec4(result, 1.0);
}
