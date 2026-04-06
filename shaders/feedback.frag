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
uniform vec2 uMouse;
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
  // TUNNEL CAVE MAPPING (空間摺疊)
  // ============================================================
  float r = max(0.0001, distFromCenter);
  
  // ======== LOG-POLAR TUNNEL 核心魔法 ========
  // 深度 Z 是距離的反比，接近圓心(無限遠)深度趨於無限
  float pipeZ = 0.4 / r; 
  float angleF = atan(diffAspect.y, diffAspect.x);
  float pipeU = angleF / 6.28318; // -0.5 to 0.5
  
  // 攝影機滑行 (向前與自轉)
  vec2 tunnelCoords = vec2(pipeU, pipeZ);
  tunnelCoords.x += uTime * uRotationSpeed * -8.0; // 再慢兩倍以上的沉重自轉
  tunnelCoords.y -= uTime * uZoomSpeed * 250.0;     // 向前衝刺

  // 用扭曲的管道座標產生細胞牆壁 (泥沼內壁)
  vec2 warp = vec2(
    fbm(tunnelCoords * 4.0 + uTime * 0.05),
    fbm(tunnelCoords * 4.0 + vec2(50.0, 10.0) + uTime * 0.05)
  ) * 0.15;

  vec2 cellCenter;
  float mudTexture = voronoi(tunnelCoords * vec2(6.0, 2.0) + warp, cellCenter);
  
  // 計算在管道中的不規則漂移
  float ringDrift = mix(0.5, 1.5, hash(vec2(floor(tunnelCoords.y * 3.0), 13.0)));

  // ============================================================
  // BI-DIRECTIONAL EMOTIONAL PARTICLES & DYNAMIC LIGHTING
  // ============================================================
  vec3 particlesRGB = vec3(0.0);
  float particleEffectScalar = 0.0;
  float angle = atan(diffAspect.y, diffAspect.x);
  float numSpokes = 120.0;
  
  vec2 uvAspect = (uv - center) * aspect; 
  float globalShadow = 0.0;

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
          // OUTWARD (Restored Colors, No Pure White)
          expectedRadius = emotionalT * 1.3 * emotionForce; 
          
          // 豐富的黃金/深橘色彩細節，避免達到 vec3(1.0) 的死白
          vec3 desat = vec3(0.6, 0.4, 0.2) * 0.6;
          vec3 vivid = vec3(0.9, 0.4, 0.0) * 0.8;
          vec3 peak  = vec3(0.95, 0.7, 0.2) * 0.9;
          particleColor = mix(mix(desat, vivid, satIndiv), peak, intensityMix * satIndiv);
          
          // 粒子全部縮小一倍
          dotSize = mix(0.0007, 0.004, t); 
          // 越靠近圓心(t=0)越虛/越亮，越靠近外圍(t=1)越銳利/越暗
          sharpnessP = mix(0.9, 0.02, t); 
          pushSign = 1.0; 
          fade = smoothstep(0.0, 0.1, t) * smoothstep(1.0, 0.5, t); 
      } else {
          // INWARD (Restored Colors, No Pure White)
          float startR = 1.3 * (1.0 + emotionForce * 0.1); 
          float endR = 0.15; 
          expectedRadius = mix(startR, endR, emotionalT);
          
          // 豐富的幽藍色彩細節
          vec3 desat = vec3(0.2, 0.4, 0.6) * 0.6;
          vec3 vivid = vec3(0.0, 0.4, 0.9) * 0.8;
          vec3 peak  = vec3(0.2, 0.8, 0.95) * 0.9;
          particleColor = mix(mix(desat, vivid, satIndiv), peak, intensityMix * satIndiv);

          // 粒子全部縮小一倍
          dotSize = mix(0.0125, 0.0007, t);  
          sharpnessP = mix(0.02, 0.9, t); 
          pushSign = -1.8; 
          fade = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.7, 0.95, t));
      }

      float distToParticle = abs(distFromCenter - expectedRadius);
      float spokeCenter = (angleGrid + 0.1 + 0.8 * hash(vec2(h, 11.0))) / numSpokes;
      float angularDiff = abs(normalizedAngle - spokeCenter);
      angularDiff = min(angularDiff, 1.0 - angularDiff);
      float cartesianAngDist = angularDiff * 6.28318 * distFromCenter;
      float trueDist = sqrt(distToParticle * distToParticle + cartesianAngDist * cartesianAngDist);
      
      // Calculate 3D Lighting & Shadows (Radial from Center)
      float rayDirAngle = spokeCenter * 6.28318 - fbm(uv * 5.0 + uTime * 0.04) * 0.2; 
      vec2 pPosAspect = vec2(cos(rayDirAngle), sin(rayDirAngle)) * expectedRadius;
      vec2 pToUV = uvAspect - pPosAspect;
      
      // 光源在圓心 (0,0)，所以從光到粒子的向量就是 pPosAspect 本身
      vec2 L2P = pPosAspect;
      float distL2P = length(L2P);
      vec2 shadowDir = distL2P > 0.001 ? (L2P / distL2P) : vec2(1.0, 0.0);
      
      // 粒子本體渲染
      float dotShape = smoothstep(dotSize, dotSize * sharpnessP, trueDist) * isParticle;
      
      // 逆光輪廓 (Backlit Rim & Silhouette)
      vec2 pNormal = normalize(pToUV + 1e-5);
      float nDotL = dot(pNormal, -shadowDir); // 迎光面 (朝向圓心) 為 1.0，背光面為 -1.0
      
      float backlitDiffuse = smoothstep(-0.2, 1.0, nDotL); // 只有朝向圓心的一側吃得到光
      float rim = smoothstep(0.0, dotSize, trueDist); // 越靠邊緣越透光
      float solidCore = mix(0.05, 3.5, backlitDiffuse * rim); // 產生逆光黑洞與月牙發光邊緣

      // 亮度減低一半，遠處較亮，外圍疊加 fade 暗化
      float intensity = dotShape * fade * (1.2 + emotionForce * 0.8) * solidCore * 0.5;
      particlesRGB += particleColor * intensity;
      particleEffectScalar += dotShape * fade * emotionForce * 0.5 * pushSign;

      // 放射狀拖曳陰影 (Radial Volumetric Rays)
      float proj = dot(pToUV, shadowDir);
      float perp = length(pToUV - shadowDir * proj);
      float shadowLength = dotSize * 35.0; // 極長的逆光拖影
      float shadowWidth = dotSize * mix(0.8, 8.0, clamp(proj/shadowLength, 0.0, 1.0));
      float shadowShape = smoothstep(shadowWidth, 0.0, perp) 
                        * smoothstep(-dotSize, dotSize * 2.0, proj) 
                        * smoothstep(shadowLength, 0.0, proj);
      
      globalShadow += shadowShape * isParticle * fade * clamp(1.0 - distL2P*1.5, 0.0, 1.0) * 0.85;
  }
  
  float particleFade = exp(-distFromCenter * 1.5);
  vec3 finalParticles = particlesRGB * particleFade;
  float particlePush = particleEffectScalar * particleFade * 0.06;

  vec2 sampleUV = zoomUV - toCenter * uMudSpeed * ringDrift * 1.5 + toCenter * particlePush;
  sampleUV = clamp(sampleUV, 0.0, 1.0);

  float decayNoise = fbm(vec2(angleF * 12.0, uTime * 0.1));
  float localDecay = uFeedbackDecay - mix(0.0, 0.12, pow(decayNoise, 2.0));
  vec4 prev = texture2D(uPrevFrame, sampleUV) * localDecay;

  float cracks = smoothstep(0.0, 0.06, mudTexture);
  float plateShade = mix(0.005, 0.035, hash(cellCenter)); // 洞穴岩壁的基礎顏色
  
  // 加上顆粒感
  float grain = noise(tunnelCoords * 150.0 + uTime * 0.1) * 0.015;
  plateShade += grain;
  
  float edge = smoothstep(0.1, 0.0, mudTexture) * smoothstep(-0.05, 0.1, mudTexture);
  plateShade += edge * 0.03; // 岩壁邊緣的高光
  
  // 3D 深度模糊與暗化 (無限遠的中心點一片漆黑)
  float mudVignette = smoothstep(0.0, 0.6, distFromCenter); // 越接近 0 (深處) 越黑
  plateShade *= mudVignette;

  // 動態壓暗機制：白光越多，背景環境光越暗
  float ambientDimming = mix(1.0, 0.05, uParticleAmount); 
  plateShade *= ambientDimming;

  vec3 finalMudColor = vec3(plateShade) * cracks;

  // 圓心光源的放射全局照明 (Light at the end of the tunnel)
  float centerGlow = exp(-distFromCenter * (7.0 - uEmotionIntensity * 3.0));
  // 亮度減半，保有顏色細節不至於爆光
  vec3 spotLightColor = vec3(0.9, 0.45, 0.1) * centerGlow * (1.0 - cracks * 0.9) * mix(0.2, 1.0, uEmotionIntensity);
  finalMudColor += spotLightColor * mudVignette * 1.5; // 邊緣反射光

  // 逆光陰影：放射狀粒子產生的巨大 3D 隧道壓影
  finalMudColor *= (1.0 - clamp(globalShadow, 0.0, 0.95));

  // 這裡調降為 0.08，讓暗度比摺疊前還要深不見底
  vec3 result = prev.rgb + finalMudColor * 0.08 + finalParticles;
  result = result / (1.0 + result * 0.1);
  gl_FragColor = vec4(result, 1.0);
}
