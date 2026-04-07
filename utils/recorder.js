/**
 * WebglRecorder.js
 * Records WebGL canvas + Web Audio at 1080×1920 (portrait).
 * In-memory mode: accumulates chunks, auto-stops at maxDuration, then downloads.
 * Press 'R' to Start/Stop recording.
 */

export class WebglRecorder {
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    this.canvas = renderer.domElement;
    this.fps = options.fps || 60;
    this.width = options.width || 1080;
    this.height = options.height || 1920;
    this.maxDuration = options.maxDuration || 180; // seconds, default 3 min
    this.getAudioStream = options.getAudioStream || null;
    this.onStart = options.onStart || null;
    this.onStop = options.onStop || null;
    this.isRecording = false;
    this.mediaRecorder = null;
    this.mimeType = '';
    this.startTime = 0;
    this.autoStopTimer = null;
    this.chunks = [];

    // UI
    this.indicator = document.createElement('div');
    this.setupUI();

    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'r') this.toggle();
    });

    console.log(`📹 WebglRecorder ready (R to toggle) — ${this.width}×${this.height} portrait, max ${this.maxDuration}s in-memory`);
  }

  setupUI() {
    Object.assign(this.indicator.style, {
      position: 'fixed', top: '20px', right: '20px',
      padding: '10px 20px', borderRadius: '20px',
      background: 'rgba(255,0,0,0.8)', color: '#fff',
      fontFamily: 'monospace', fontSize: '12px', fontWeight: 'bold',
      zIndex: '9999', display: 'none',
    });
    document.body.appendChild(this.indicator);
  }

  updateIndicator() {
    if (!this.isRecording) return;
    const sec = Math.floor((Date.now() - this.startTime) / 1000);
    const remaining = this.maxDuration - sec;
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    const rm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const rs = String(remaining % 60).padStart(2, '0');
    this.indicator.innerText = `🔴 REC ${m}:${s}  ⏱ ${rm}:${rs}`;
    requestAnimationFrame(() => this.updateIndicator());
  }

  toggle() {
    if (this.isRecording) this.stop();
    else this.start();
  }

  async start() {
    // VP9+Opus — best quality in Chrome for WebM
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    this.mimeType = '';
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) { this.mimeType = mime; break; }
    }

    this.chunks = [];

    // Resize renderer to recording resolution
    if (this.onStart) this.onStart(this.width, this.height);

    // Streams
    const videoStream = this.canvas.captureStream(this.fps);
    const tracks = [...videoStream.getVideoTracks()];
    const audioStream = this.getAudioStream?.();
    if (audioStream) audioStream.getAudioTracks().forEach(t => tracks.push(t));
    const combinedStream = new MediaStream(tracks);

    // 80Mbps video + 320kbps Opus audio
    const opts = {
      videoBitsPerSecond: 80_000_000,
      audioBitsPerSecond: 320_000,
    };
    if (this.mimeType) opts.mimeType = this.mimeType;

    this.mediaRecorder = new MediaRecorder(combinedStream, opts);

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    this.mediaRecorder.onstop = () => this.finalize();

    // Collect data every second
    this.mediaRecorder.start(1000);
    this.isRecording = true;
    this.startTime = Date.now();
    this.indicator.style.display = 'block';
    this.updateIndicator();

    // Auto-stop at maxDuration
    this.autoStopTimer = setTimeout(() => {
      if (this.isRecording) {
        console.log(`⏱ Auto-stop at ${this.maxDuration}s`);
        this.stop();
      }
    }, this.maxDuration * 1000);

    const codec = this.mimeType.includes('vp9') ? 'VP9' : 'VP8';
    console.log(`🎬 Recording ${this.width}×${this.height} WebM/${codec} @80Mbps`
      + (audioStream ? ' + Opus 320kbps' : ' (no audio — press Space first)')
      + ` — auto-stop in ${this.maxDuration}s`);
  }

  stop() {
    if (this.autoStopTimer) { clearTimeout(this.autoStopTimer); this.autoStopTimer = null; }
    this.mediaRecorder.stop();
    this.isRecording = false;
    this.indicator.style.display = 'none';
    if (this.onStop) this.onStop();
    console.log('🛑 Recording stopped — preparing download…');
  }

  async finalize() {
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `unburial_core_${Date.now()}.webm`;
    a.click();
    URL.revokeObjectURL(url);
    this.chunks = [];
    console.log(`✅ Downloaded unburial_core.webm (${sizeMB} MB)`);
  }
}
