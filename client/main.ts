/**
 * M1/M2: Main Entry Point
 * 
 * Wire up the canvas engine with UI controls, keyboard shortcuts,
 * FPS monitoring, and WebSocket networking.
 */

import { CanvasEngine, StrokeStyle, Stroke } from './canvas';
import { WebSocketClient, throttle } from './websocket';

class App {
  private engine: CanvasEngine;
  private canvas: HTMLCanvasElement;
  private fpsCounter: HTMLElement;
  private statusText: HTMLElement;
  private wsClient: WebSocketClient | null = null;
  private isNetworkEnabled = false;
  private remoteStrokes = new Map<string, Stroke>(); // Track remote strokes by strokeId
  private remoteCursors = new Map<string, { x: number; y: number; color: string; username: string }>(); // Track remote cursors
  private userInfo = new Map<string, { username: string; color: string }>(); // Track user info
  
  // FPS tracking
  private lastFrameTime = 0;
  private frameCount = 0;
  private fps = 0;

  constructor() {
    this.canvas = document.getElementById('canvas') as HTMLCanvasElement;
    this.fpsCounter = document.getElementById('fps-counter') as HTMLElement;
    this.statusText = document.getElementById('status-text') as HTMLElement;

    if (!this.canvas) {
      throw new Error('Canvas element not found');
    }

    // Initialize canvas engine
    this.engine = new CanvasEngine(this.canvas);

    // Setup network callbacks (M2)
    this.engine.onStrokeStart = (stroke) => {
      if (this.wsClient && this.isNetworkEnabled) {
        this.wsClient.send({
          type: 'stroke_start',
          strokeId: stroke.id,
          points: [stroke.points[0]],
          style: stroke.style
        });
      }
    };

    this.engine.onStrokePoint = throttle((strokeId, points) => {
      if (this.wsClient && this.isNetworkEnabled) {
        this.wsClient.send({
          type: 'stroke_point',
          strokeId,
          points
        });
      }
    }, 50); // Throttle to ~20Hz

    this.engine.onStrokeEnd = (stroke) => {
      if (this.wsClient && this.isNetworkEnabled) {
        this.wsClient.send({
          type: 'stroke_end',
          strokeId: stroke.id,
          points: stroke.points.slice(-5) // Send last few points for redundancy
        });
      }
    };

    // Setup UI
    this.setupToolButtons();
    this.setupColorPicker();
    this.setupStrokeWidth();
    this.setupSmoothingMode();
    this.setupActions();
    this.setupKeyboardShortcuts();
    this.setupPersistence();

    // Setup networking (M2)
    this.setupNetworking();

    // Setup cursor tracking (M3)
    this.setupCursorTracking();

    // Start FPS monitor
    this.startFPSMonitor();

    // Handle window resize
    window.addEventListener('resize', this.handleResize);

    this.updateStatus('Ready to draw!');
  }

  private setupNetworking() {
    // Get room ID from URL or generate one
    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room') || 'default';
    const username = urlParams.get('username') || '';

    // Try to connect to WebSocket server
    const wsUrl = `ws://localhost:8080`;
    this.wsClient = new WebSocketClient(wsUrl, roomId, username);

    this.wsClient.connect()
      .then(() => {
        this.isNetworkEnabled = true;
        this.updateStatus(`Connected to room: ${roomId}`);
        this.setupNetworkHandlers();
      })
      .catch((error) => {
        console.warn('Failed to connect to server, running in offline mode:', error);
        this.updateStatus('Offline mode (server not available)');
      });
  }

  private setupNetworkHandlers() {
    if (!this.wsClient) return;

    // Handle room join confirmation
    this.wsClient.on('joined', (message) => {
      console.log('Joined room:', message);
      this.updateStatus(`Joined as ${message.username} (${message.color})`);
      
      // Clear existing user info (fresh start on join)
      this.userInfo.clear();
      this.remoteCursors.clear();
      
      // Store user info for roster (exclude self)
      if (message.roster) {
        const myClientId = this.wsClient?.getClientId();
        message.roster.forEach((user: any) => {
          // Only add other users, not ourselves
          if (myClientId && user.clientId !== myClientId) {
            this.userInfo.set(user.clientId, {
              username: user.username,
              color: user.color
            });
          }
        });
      }
      
      this.updateRoster();
    });

    // Handle user joined
    this.wsClient.on('user_joined', (message) => {
      this.updateStatus(`${message.username} joined`);
      this.userInfo.set(message.clientId, {
        username: message.username,
        color: message.color
      });
      this.updateRoster();
    });

    // Handle user left
    this.wsClient.on('user_left', (message) => {
      this.updateStatus('User left');
      this.userInfo.delete(message.clientId);
      this.remoteCursors.delete(message.clientId);
      this.renderCursors();
      this.updateRoster();
    });

    // Handle remote stroke events
    this.wsClient.on('stroke_start', (message) => {
      this.handleRemoteStrokeStart(message);
    });

    this.wsClient.on('stroke_point', (message) => {
      this.handleRemoteStrokePoint(message);
    });

    this.wsClient.on('stroke_end', (message) => {
      this.handleRemoteStrokeEnd(message);
    });

    // Handle cursor updates
    this.wsClient.on('cursor', (message) => {
      this.handleRemoteCursor(message);
    });
  }

  private setupCursorTracking() {
    // Track cursor movement and broadcast throttled updates
    const throttledCursorUpdate = throttle((e: MouseEvent) => {
      if (this.wsClient && this.isNetworkEnabled) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        this.wsClient.send({
          type: 'cursor',
          x,
          y
        });
      }
    }, 33); // ~30Hz

    this.canvas.addEventListener('mousemove', throttledCursorUpdate);
  }

  private handleRemoteCursor(message: any) {
    const { clientId, x, y } = message;
    
    // Get or create cursor info
    let cursorInfo = this.remoteCursors.get(clientId);
    if (!cursorInfo) {
      const userInfo = this.userInfo.get(clientId);
      cursorInfo = {
        x,
        y,
        color: userInfo?.color || '#999',
        username: userInfo?.username || 'Unknown'
      };
      this.remoteCursors.set(clientId, cursorInfo);
    } else {
      cursorInfo.x = x;
      cursorInfo.y = y;
    }

    // Trigger cursor render
    this.renderCursors();
  }

  private renderCursors() {
    // Remove old cursor overlays
    const oldCursors = document.querySelectorAll('.remote-cursor');
    oldCursors.forEach(c => c.remove());

    // Render each remote cursor
    for (const [clientId, cursor] of this.remoteCursors) {
      const cursorEl = document.createElement('div');
      cursorEl.className = 'remote-cursor';
      cursorEl.style.cssText = `
        position: absolute;
        left: ${cursor.x}px;
        top: ${cursor.y}px;
        pointer-events: none;
        z-index: 1000;
        transform: translate(-50%, -50%);
      `;

      // Cursor dot
      const dot = document.createElement('div');
      dot.style.cssText = `
        width: 12px;
        height: 12px;
        background: ${cursor.color};
        border: 2px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      `;

      // Username label
      const label = document.createElement('div');
      label.style.cssText = `
        position: absolute;
        top: 16px;
        left: 8px;
        background: ${cursor.color};
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      `;
      label.textContent = cursor.username;

      cursorEl.appendChild(dot);
      cursorEl.appendChild(label);
      
      const canvasContainer = this.canvas.parentElement;
      if (canvasContainer) {
        canvasContainer.appendChild(cursorEl);
      }
    }
  }

  private handleRemoteStrokeStart(message: any) {
    const stroke: Stroke = {
      id: message.strokeId,
      points: message.points || [],
      style: message.style,
      finished: false
    };
    this.remoteStrokes.set(message.strokeId, stroke);
    this.engine.render(this.remoteStrokes);
  }

  private handleRemoteStrokePoint(message: any) {
    const stroke = this.remoteStrokes.get(message.strokeId);
    if (stroke && message.points) {
      stroke.points.push(...message.points);
      this.engine.render(this.remoteStrokes);
    }
  }

  private handleRemoteStrokeEnd(message: any) {
    const stroke = this.remoteStrokes.get(message.strokeId);
    if (stroke) {
      if (message.points) {
        stroke.points.push(...message.points);
      }
      stroke.finished = true;
      // Add to engine's permanent stroke list
      this.engine.addRemoteStroke(stroke);
      this.remoteStrokes.delete(message.strokeId);
      this.engine.render(this.remoteStrokes);
    }
  }

  private updateRoster() {
    const rosterPanel = document.getElementById('roster-panel');
    const rosterList = document.getElementById('roster-list');
    
    if (!rosterPanel || !rosterList) return;

    // Show roster if we have remote users
    if (this.userInfo.size > 0) {
      rosterPanel.style.display = 'block';
    } else {
      rosterPanel.style.display = 'none';
      return;
    }

    // Clear and rebuild roster
    rosterList.innerHTML = '';

    for (const [clientId, user] of this.userInfo) {
      const item = document.createElement('div');
      item.className = 'roster-item';
      
      const colorDot = document.createElement('div');
      colorDot.className = 'roster-color';
      colorDot.style.background = user.color;
      
      const name = document.createElement('div');
      name.className = 'roster-name';
      name.textContent = user.username;
      
      item.appendChild(colorDot);
      item.appendChild(name);
      rosterList.appendChild(item);
    }
  }

  private setupToolButtons() {
    const brushBtn = document.getElementById('tool-brush') as HTMLButtonElement;
    const eraserBtn = document.getElementById('tool-eraser') as HTMLButtonElement;

    brushBtn?.addEventListener('click', () => {
      this.setTool('brush');
      brushBtn.classList.add('active');
      eraserBtn?.classList.remove('active');
      this.canvas.classList.remove('eraser-cursor');
      this.updateStatus('Brush tool selected');
    });

    eraserBtn?.addEventListener('click', () => {
      this.setTool('eraser');
      eraserBtn.classList.add('active');
      brushBtn?.classList.remove('active');
      this.canvas.classList.add('eraser-cursor');
      this.updateStatus('Eraser tool selected');
    });
  }

  private setupColorPicker() {
    const colorPicker = document.getElementById('color-picker') as HTMLInputElement;
    const colorPresets = document.querySelectorAll('.color-preset');

    colorPicker?.addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      this.engine.setStyle({ color });
      this.updateStatus(`Color: ${color}`);
    });

    colorPresets.forEach((preset) => {
      preset.addEventListener('click', () => {
        const color = preset.getAttribute('data-color')!;
        this.engine.setStyle({ color });
        if (colorPicker) colorPicker.value = color;
        this.updateStatus(`Color: ${color}`);
      });
    });
  }

  private setupStrokeWidth() {
    const strokeWidth = document.getElementById('stroke-width') as HTMLInputElement;
    const widthValue = document.getElementById('width-value') as HTMLElement;

    strokeWidth?.addEventListener('input', (e) => {
      const width = parseInt((e.target as HTMLInputElement).value);
      this.engine.setStyle({ width });
      if (widthValue) widthValue.textContent = width.toString();
      this.updateStatus(`Stroke width: ${width}px`);
    });
  }

  private setupSmoothingMode() {
    const smoothingMode = document.getElementById('smoothing-mode') as HTMLSelectElement;

    smoothingMode?.addEventListener('change', (e) => {
      const smoothing = (e.target as HTMLSelectElement).value as StrokeStyle['smoothing'];
      this.engine.setStyle({ smoothing });
      this.updateStatus(`Smoothing: ${smoothing}`);
    });
  }

  private setupActions() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    const clearBtn = document.getElementById('clear-btn');

    undoBtn?.addEventListener('click', () => {
      this.engine.undo();
      this.updateStatus('Undo');
    });

    redoBtn?.addEventListener('click', () => {
      this.engine.redo();
      this.updateStatus('Redo');
    });

    clearBtn?.addEventListener('click', () => {
      if (confirm('Clear the entire canvas?')) {
        this.engine.clear();
        this.updateStatus('Canvas cleared');
      }
    });
  }

  private setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + Z: Undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.engine.undo();
        this.updateStatus('Undo');
      }

      // Ctrl/Cmd + Y or Ctrl/Cmd + Shift + Z: Redo
      if (
        ((e.ctrlKey || e.metaKey) && e.key === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z')
      ) {
        e.preventDefault();
        this.engine.redo();
        this.updateStatus('Redo');
      }

      // B: Brush tool
      if (e.key === 'b' || e.key === 'B') {
        const brushBtn = document.getElementById('tool-brush') as HTMLButtonElement;
        brushBtn?.click();
      }

      // E: Eraser tool
      if (e.key === 'e' || e.key === 'E') {
        const eraserBtn = document.getElementById('tool-eraser') as HTMLButtonElement;
        eraserBtn?.click();
      }

      // [: Decrease stroke width
      if (e.key === '[') {
        const strokeWidth = document.getElementById('stroke-width') as HTMLInputElement;
        if (strokeWidth) {
          const newWidth = Math.max(1, parseInt(strokeWidth.value) - 1);
          strokeWidth.value = newWidth.toString();
          strokeWidth.dispatchEvent(new Event('input'));
        }
      }

      // ]: Increase stroke width
      if (e.key === ']') {
        const strokeWidth = document.getElementById('stroke-width') as HTMLInputElement;
        if (strokeWidth) {
          const newWidth = Math.min(50, parseInt(strokeWidth.value) + 1);
          strokeWidth.value = newWidth.toString();
          strokeWidth.dispatchEvent(new Event('input'));
        }
      }
    });
  }

  private setupPersistence() {
    const saveBtn = document.getElementById('save-btn');
    const loadBtn = document.getElementById('load-btn');

    saveBtn?.addEventListener('click', () => {
      const data = this.engine.serialize();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = `canvas_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
      a.click();
      
      URL.revokeObjectURL(url);
      this.updateStatus('Canvas saved');
    });

    loadBtn?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json';
      
      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
          const json = event.target?.result as string;
          this.engine.load(json);
          this.updateStatus('Canvas loaded');
        };
        reader.readAsText(file);
      };
      
      input.click();
    });
  }

  private setTool(tool: 'brush' | 'eraser') {
    this.engine.setStyle({ tool });
  }

  private handleResize = () => {
    // Force canvas redraw on resize
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    
    this.engine.render(this.remoteStrokes);
  };

  private startFPSMonitor() {
    const updateFPS = (timestamp: number) => {
      if (this.lastFrameTime === 0) {
        this.lastFrameTime = timestamp;
      }

      const delta = timestamp - this.lastFrameTime;
      this.frameCount++;

      // Update FPS every 500ms
      if (delta >= 500) {
        this.fps = Math.round((this.frameCount * 1000) / delta);
        this.frameCount = 0;
        this.lastFrameTime = timestamp;
        
        if (this.fpsCounter) {
          this.fpsCounter.textContent = `FPS: ${this.fps}`;
          
          // Color code FPS
          if (this.fps >= 55) {
            this.fpsCounter.style.color = '#4CAF50'; // Green
          } else if (this.fps >= 30) {
            this.fpsCounter.style.color = '#FFC107'; // Yellow
          } else {
            this.fpsCounter.style.color = '#f44336'; // Red
          }
        }
      }

      requestAnimationFrame(updateFPS);
    };

    requestAnimationFrame(updateFPS);
  }

  private updateStatus(message: string) {
    if (this.statusText) {
      this.statusText.textContent = message;
    }
  }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new App());
} else {
  new App();
}
