/**
 * WebglRecorder.js
 * A reusable, frame-accurate recorder for WebGL/Three.js projects.
 * Press 'R' to Start/Stop recording.
 */

export class WebglRecorder {
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    this.canvas = renderer.domElement;
    this.fps = options.fps || 60;
    this.isRecording = false;
    this.chunks = [];
    this.mediaRecorder = null;
    this.stream = null;

    // UI Feedback (Optional)
    this.indicator = document.createElement('div');
    this.setupUI();

    // Bind keys
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'r') {
        this.toggle();
      }
    });

    console.log('📹 WebglRecorder initialized. Press "R" to toggle recording.');
  }

  setupUI() {
    this.indicator.style.position = 'fixed';
    this.indicator.style.top = '20px';
    this.indicator.style.right = '20px';
    this.indicator.style.padding = '10px 20px';
    this.indicator.style.borderRadius = '20px';
    this.indicator.style.background = 'rgba(255, 0, 0, 0.8)';
    this.indicator.style.color = '#fff';
    this.indicator.style.fontFamily = 'monospace';
    this.indicator.style.fontSize = '12px';
    this.indicator.style.fontWeight = 'bold';
    this.indicator.style.zIndex = '9999';
    this.indicator.style.display = 'none';
    this.indicator.innerText = '🔴 RECORDING...';
    document.body.appendChild(this.indicator);
  }

  toggle() {
    if (this.isRecording) {
      this.stop();
    } else {
      this.start();
    }
  }

  start() {
    console.log('🎬 Starting recording...');
    this.chunks = [];
    // Using high bitrate for "Exquisite/Premium" quality
    this.stream = this.canvas.captureStream(this.fps);
    
    const options = {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 50000000 // 50 Mbps for high fidelity
    };

    try {
      this.mediaRecorder = new MediaRecorder(this.stream, options);
    } catch (e) {
      console.warn('VP9 not supported, falling back to default.');
      this.mediaRecorder = new MediaRecorder(this.stream);
    }

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    this.mediaRecorder.onstop = () => this.download();

    this.mediaRecorder.start();
    this.isRecording = true;
    this.indicator.style.display = 'block';
  }

  stop() {
    console.log('🛑 Stopping recording...');
    this.mediaRecorder.stop();
    this.isRecording = false;
    this.indicator.style.display = 'none';
  }

  download() {
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `unburial_core_${Date.now()}.webm`;
    a.click();
    URL.revokeObjectURL(url);
    console.log('✅ Recording saved.');
  }
}
