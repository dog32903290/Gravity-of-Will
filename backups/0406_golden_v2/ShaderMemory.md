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

---
*Generated for AI Efficiency. Context optimized for Claude/Gemini.*
