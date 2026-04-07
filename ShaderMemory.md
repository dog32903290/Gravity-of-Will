# Shader Memory Core: The Unburial Core (v2.5)

## 0. 核心上下文 (Context)
- **主題**：生命意志 vs 黑色泥沼。
- **視覺**：3D Log-Polar 隧道，意志光點漫遊於中心，放射狀粒子與泥沼進行物理對抗。

## 1. 視覺動力邏輯 (Dynamic Rules)
- **泥沼 (The Mud)**：Voronoi 細胞板塊，向心擠壓 (`uMudSpeed`)，中心壓暗。
- **意志 (The Will)**：中心光球，FBM 隨機漫遊，尺寸/亮度隨 `uEmotionIntensity` 耦合。
- **粒子 (Particles)**：
  - **Outward (金黃)**：向外穿刺，具備放射狀體積陰影。
  - **Inward (幽藍)**：向內回溯。
  - **物理感**：粒子具有推開泥沼的位移 (`particlePush`) 與阻尼感。
- **視角 (Dolly)**：主觀視角前進 (`uZoomSpeed`)，具備桶形畸變與隧道暗角。

## 2. 關鍵參數調音台 (Control Sheet)

| 類別 | 變量 | 預設值 | 視覺影響 |
| :--- | :--- | :--- | :--- |
| **空間** | `uZoomSpeed` | `0.001` | 隧道衝刺速度 |
| | `uRotationSpeed` | `-0.008` | 隧道自轉（負值為順時針） |
| **意志** | `uEmotionIntensity`| `1.0` | 粒子射程、亮度、光球銳度耦合 |
| | `uBaseSharp` | `28.0` | 光源核心凝聚度（越高越小） |
| **泥沼** | `uMudSpeed` | `0.001` | 泥沼板塊向心擠壓流速 |
| | `uFeedbackDecay` | `0.985` | 畫面殘影記憶量（0.99 黏稠，0.95 乾淨） |
| **能量** | `uParticleAmount` | `0.1` | 粒子噴發密度（↑↓鍵微調） |

## 3. 技術特徵 (Technical Specs)
- **座標系**：Log-Polar Tunnel Mapping (2D -> 3D Pipe)。
- **緩衝**：Ping-pong FBO Feedback (用於粒子軌跡與板塊堆疊)。
- **光影**：Backlit Rim Lighting + Radial Volumetric Shadows (35x 射線)。
- **渲染**：HDR Tone Mapping (`result / (1.0 + result * 0.1)`) + Gamma 校正。

## 4. 最新狀態 (Current State)
- **v2.5 (The Abyssal Tunnel)**: 空間摺疊完成，導入逆光陰影系統。
- **錄製**: 按 `R` 啟動 50Mbps 無損錄製 (`recorder.js`)。
- **控制**: 方向鍵微調流速與粒子密度。
- **v2.6 (lil-gui 控制面板)**: 加入即時 GUI slider 控制所有 uniform。
  - 備份存於 `backups/0406_golden_v2/`
  - `H` 鍵切換顯示/隱藏
  - 泥沼：向心流速、反饋衰減
  - 光球：銳度、銳度耦合 K
  - 粒子：密度、情緒強度
  - 鏡頭：Dolly 速度、旋轉速度
- **v2.7 (Audio Engine)**: 三層聲音引擎，根音 D，Web Audio API。
  - `Space` 鍵啟動/暫停音頻
- **v2.8 (Fullscreen)**: 全螢幕按鈕，隱藏瀏覽器網址列。
  - 左上角半透明按鈕 `⛶` 或按 `F` 鍵進入全螢幕
  - 全螢幕中按鈕變 `✕`，點擊或 `Esc` 退出
- **v2.9 (Mixer + Particle Rework)**:
  - 3 聲道 Mixer UI（Bass/Orb/Particles）：音量、3-band EQ、立體聲寬度
  - 粒子琶音：D major 2 octave，`particleAmount` 控制 poly 數+音域+琶音速度
  - `particleSize` 控制 envelope gate + auto-pan LFO 速度（不再控制音量）
  - `densityCap` 控制 poly 數量（2~24 voices）
  - Bass/Orb 寬度用 Haas effect，Particles 寬度用 per-voice auto-pan
  - `H` 鍵同時隱藏 GUI 和 Mixer

## 5. 音頻引擎 (Audio Engine v2.7)

### Signal Flow
```
Bass Drone ─┐
Orb Tone   ─┤─→ masterGain(0.7) ─→ Limiter(-6dB, ratio:20) ─→ speakers
Particles  ─┤                              ↑
             └─→ Convolver(2.5s IR) ─→ reverbGain(0.25) ─┘
```

### 三層聲音

| 層 | 音源 | 頻率 | 控制參數 | 行為 |
|:--|:--|:--|:--|:--|
| **泥沼 Bass** | D2 saw + D1 sine sub | 37–73 Hz | `mudSpeed` → lowpass cutoff (80–2500Hz)；`feedbackDecay` → delay feedback (0–0.65) | 低=悶吼，高=呲；高衰減=更多高頻延遲尾巴 |
| **光球 Orb** | D6 sine ×2 (微detune) | 1175 Hz | `baseSharp` ≤5 觸發（attack ~2s）；`emotionIntensity` → 音量 | 銳度拉到最小開啟，情緒強度控制響度 |
| **粒子** | 2~24× bandpass noise (hi-hat) | 1000–2500 Hz | `particleAmount` → 觸發速率 (5→40Hz)；`densityCap` → poly 數 (2~24)；`particleSize` → attack+decay 長度+auto-pan 速度；`emotionIntensity` → HPF cutoff (800→3000Hz) | 無 reverb/delay，紋理清晰。小=砂粒click，大=swoosh。情緒高=極亮銳利 |

### 粒子 Signal Chain (v3.0)
```
共用 noise buffer → BufferSource(loop) → BPF(1000~2500Hz) → HPF(ei) → VCA(envelope) → Pan → particleBus → strip → masterGain
```
- 無 reverb、無 delay，紋理清楚
- 24 voice 各自 BPF center freq 均勻分佈，Q=3~5
- Per-voice auto-pan，golden ratio 錯開速度

### Mixer (v2.9)
- 3 聲道：Bass Drone / Orb / Particles
- 每聲道：Volume (0–150%), 3-band EQ (±12dB: 200Hz/1kHz/4kHz), Stereo Width
- Bass/Orb width: Haas delay (0–15ms)；Particles width: auto-pan LFO amplitude

---
*Generated for AI Efficiency. Context optimized for Claude/Gemini.*
