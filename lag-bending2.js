(function (Scratch) {
  'use strict';

  const { BlockType } = Scratch;

  class LagBendingExtension {
    constructor() {
      this.stream = null;
      this.video = null;
      this.canvas = null;
      this.context = null;
      this.overlay = null; // overlay Gandi 3 (si dispo)
      this.stageCanvas = null; // canvas de la scène (mode compat)
      this.observer = null;
      this.onWindowResize = null;
      this.startingCamera = false;
    }

    getInfo() {
      return {
        id: 'lagbending',
        name: 'LAG BENDING',
        color1: '#7B45D6',
        color2: '#6634BD',
        color3: '#51279C',
        blocks: [
          {
            opcode: 'enableCamera',
            blockType: BlockType.COMMAND,
            text: 'enable camera'
          },
          {
            opcode: 'advanceFrame',
            blockType: BlockType.COMMAND,
            text: 'advance frame'
          }
        ]
      };
    }

    /* ---------- Recherche du canvas de la scène (mode compat) ---------- */

    findStageCanvas() {
      // 1) Le renderer du VM, si accessible
      const rendererCanvas = Scratch.vm?.runtime?.renderer?.canvas;
      if (rendererCanvas instanceof HTMLCanvasElement) return rendererCanvas;

      // 2) Sinon, on cherche le plus gros canvas visible au ratio ~4:3
      const candidates = Array.from(document.querySelectorAll('canvas')).filter(
        (c) => c !== this.canvas && c.offsetWidth > 100 && c.offsetHeight > 100
      );
      candidates.sort(
        (a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight
      );
      const withRatio = candidates.find((c) => {
        const r = c.offsetWidth / c.offsetHeight;
        return r > 1.2 && r < 1.5;
      });
      return withRatio || candidates[0] || null;
    }

    syncCanvasToStage() {
      const stage = this.stageCanvas;
      const cv = this.canvas;
      if (!stage || !cv || !stage.isConnected) return;
      cv.style.left = stage.offsetLeft + 'px';
      cv.style.top = stage.offsetTop + 'px';
      cv.style.width = stage.offsetWidth + 'px';
      cv.style.height = stage.offsetHeight + 'px';
    }

    createCompatCanvas() {
      const stage = this.findStageCanvas();
      if (!stage || !stage.parentElement) {
        throw new Error('Could not find the stage canvas.');
      }
      this.stageCanvas = stage;

      const parent = stage.parentElement;
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }

      this.canvas = document.createElement('canvas');
      this.canvas.width = stage.width || 480;
      this.canvas.height = stage.height || 360;
      this.canvas.style.position = 'absolute';
      this.canvas.style.display = 'block';
      this.canvas.style.pointerEvents = 'none';
      this.canvas.style.zIndex = '10';
      parent.appendChild(this.canvas);

      this.syncCanvasToStage();

      if (typeof ResizeObserver === 'function') {
        this.observer = new ResizeObserver(() => this.syncCanvasToStage());
        this.observer.observe(stage);
      }
      this.onWindowResize = () => this.syncCanvasToStage();
      window.addEventListener('resize', this.onWindowResize);
    }

    /* ---------- Création du canvas (Gandi 3 ou compat) ---------- */

    createStageCanvas() {
      if (this.canvas) return;

      const stage = Scratch.gandi?.stage;

      if (typeof stage?.addOverlay === 'function') {
        // Chemin Gandi 3 : API officielle d'overlay
        this.overlay = stage.addOverlay({
          scale: true,
          interactive: false,
          name: 'lag-bending-camera'
        });
        if (!this.overlay) {
          throw new Error('The Gandi stage is not available yet.');
        }

        const stageCanvas =
          typeof stage.getCanvas === 'function' ? stage.getCanvas() : null;
        this.canvas = document.createElement('canvas');
        this.canvas.width = stageCanvas?.width || 480;
        this.canvas.height = stageCanvas?.height || 360;
        this.canvas.style.display = 'block';
        this.canvas.style.position = 'absolute';
        this.canvas.style.inset = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.objectFit = 'fill';
        this.canvas.style.pointerEvents = 'none';
        this.overlay.appendChild(this.canvas);
      } else {
        // Chemin compat : on colle un canvas par-dessus la scène
        this.createCompatCanvas();
      }

      this.context = this.canvas.getContext('2d', { alpha: false });
      if (!this.context) {
        throw new Error('Could not create the camera drawing canvas.');
      }
    }

    /* ---------- Blocs ---------- */

    async enableCamera() {
      if (this.startingCamera) return;
      if (this.stream && this.video && this.video.readyState >= 2) {
        return;
      }

      this.startingCamera = true;
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera access is unavailable. Use Gandi over HTTPS.');
        }

        this.createStageCanvas();

        this.stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });

        this.video = document.createElement('video');
        this.video.autoplay = true;
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.srcObject = this.stream;

        await new Promise((resolve, reject) => {
          if (this.video.readyState >= 2) {
            resolve();
            return;
          }

          const onReady = () => {
            cleanup();
            resolve();
          };
          const onError = () => {
            cleanup();
            reject(new Error('The camera stream could not be started.'));
          };
          const cleanup = () => {
            this.video.removeEventListener('loadeddata', onReady);
            this.video.removeEventListener('error', onError);
          };

          this.video.addEventListener('loadeddata', onReady, { once: true });
          this.video.addEventListener('error', onError, { once: true });
          this.video.play().catch((error) => {
            cleanup();
            reject(error);
          });
        });

        await this.video.play();
        this.captureCurrentFrame();
      } catch (error) {
        this.stopStream();
        console.error('[LAG BENDING] Camera error:', error);
        alert('LAG BENDING: ' + (error?.message || 'Could not access the camera.'));
      } finally {
        this.startingCamera = false;
      }
    }

    advanceFrame() {
      if (!this.video || !this.stream) return;
      if (this.video.readyState < 2) return;
      this.captureCurrentFrame();
    }

    captureCurrentFrame() {
      if (!this.video || !this.context || !this.canvas) return;
      if (this.video.videoWidth === 0 || this.video.videoHeight === 0) return;

      this.context.drawImage(
        this.video,
        0,
        0,
        this.canvas.width,
        this.canvas.height
      );
    }

    stopStream() {
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
      }
      this.stream = null;
      this.video = null;
    }
  }

  Scratch.extensions.register(new LagBendingExtension());
})(window.Scratch);