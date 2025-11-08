/**
 * M1: Core Canvas Engine
 * 
 * Stroke model, rendering loop, pointer capture with resampling,
 * quadratic/cubic smoothing, and local undo/redo stack.
 */

export interface Point {
  x: number;
  y: number;
  pressure?: number;
  timestamp?: number;
}

export interface StrokeStyle {
  color: string;
  width: number;
  tool: 'brush' | 'eraser';
  smoothing: 'none' | 'quadratic' | 'cubic';
}

export interface Stroke {
  id: string;
  points: Point[];
  style: StrokeStyle;
  finished: boolean;
}

export interface Operation {
  type: 'stroke' | 'undo' | 'redo';
  stroke?: Stroke;
  timestamp: number;
}

/**
 * Resample points to achieve even spacing
 */
export function resamplePoints(points: Point[], spacing: number = 5): Point[] {
  if (points.length < 2) return points;

  const resampled: Point[] = [points[0]];
  let accumulated = 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dist = Math.sqrt(
      Math.pow(curr.x - prev.x, 2) + Math.pow(curr.y - prev.y, 2)
    );

    accumulated += dist;

    while (accumulated >= spacing) {
      const ratio = (accumulated - spacing) / dist;
      const interpX = curr.x - ratio * (curr.x - prev.x);
      const interpY = curr.y - ratio * (curr.y - prev.y);
      
      resampled.push({
        x: interpX,
        y: interpY,
        pressure: curr.pressure,
        timestamp: curr.timestamp
      });
      
      accumulated -= spacing;
    }
  }

  // Always include the last point
  const last = points[points.length - 1];
  if (resampled[resampled.length - 1] !== last) {
    resampled.push(last);
  }

  return resampled;
}

/**
 * Smooth points using quadratic Bezier interpolation
 */
export function smoothQuadratic(points: Point[]): Point[] {
  if (points.length < 3) return points;

  const smoothed: Point[] = [points[0]];

  for (let i = 0; i < points.length - 2; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const p2 = points[i + 2];

    // Control point is the middle point
    const cp = p1;

    // Generate points along the quadratic curve
    const steps = 5;
    for (let t = 0; t <= steps; t++) {
      const ratio = t / steps;
      const oneMinusT = 1 - ratio;
      
      const x = oneMinusT * oneMinusT * p0.x + 
                2 * oneMinusT * ratio * cp.x + 
                ratio * ratio * p2.x;
      const y = oneMinusT * oneMinusT * p0.y + 
                2 * oneMinusT * ratio * cp.y + 
                ratio * ratio * p2.y;

      if (t > 0) { // Skip first point (already added)
        smoothed.push({ x, y, pressure: p1.pressure });
      }
    }
  }

  smoothed.push(points[points.length - 1]);
  return smoothed;
}

/**
 * Smooth points using cubic Bezier (Catmull-Rom spline)
 */
export function smoothCubic(points: Point[]): Point[] {
  if (points.length < 4) return smoothQuadratic(points);

  const smoothed: Point[] = [points[0]];
  const tension = 0.5; // 0 = tight curves, 1 = loose curves

  for (let i = 0; i < points.length - 3; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const p2 = points[i + 2];
    const p3 = points[i + 3];

    // Catmull-Rom control points
    const cp1x = p1.x + (p2.x - p0.x) / 6 * tension;
    const cp1y = p1.y + (p2.y - p0.y) / 6 * tension;
    const cp2x = p2.x - (p3.x - p1.x) / 6 * tension;
    const cp2y = p2.y - (p3.y - p1.y) / 6 * tension;

    const steps = 8;
    for (let t = 0; t <= steps; t++) {
      const ratio = t / steps;
      const oneMinusT = 1 - ratio;
      const oneMinusT2 = oneMinusT * oneMinusT;
      const oneMinusT3 = oneMinusT2 * oneMinusT;
      const ratio2 = ratio * ratio;
      const ratio3 = ratio2 * ratio;

      const x = oneMinusT3 * p1.x +
                3 * oneMinusT2 * ratio * cp1x +
                3 * oneMinusT * ratio2 * cp2x +
                ratio3 * p2.x;
      const y = oneMinusT3 * p1.y +
                3 * oneMinusT2 * ratio * cp1y +
                3 * oneMinusT * ratio2 * cp2y +
                ratio3 * p2.y;

      if (t > 0) {
        smoothed.push({ x, y, pressure: p1.pressure });
      }
    }
  }

  smoothed.push(points[points.length - 1]);
  return smoothed;
}

export class CanvasEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private strokes: Stroke[] = [];
  private currentStroke: Stroke | null = null;
  private operationStack: Operation[] = [];
  private undoneStack: Operation[] = [];
  private currentStyle: StrokeStyle = {
    color: '#000000',
    width: 2,
    tool: 'brush',
    smoothing: 'quadratic'
  };

  // Pointer tracking
  private isDrawing = false;
  private lastPoint: Point | null = null;
  private rawPoints: Point[] = [];

  // Event callbacks for networking (M2)
  public onStrokeStart?: (stroke: Stroke) => void;
  public onStrokePoint?: (strokeId: string, points: Point[]) => void;
  public onStrokeEnd?: (stroke: Stroke) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;

    this.setupCanvas();
    this.setupPointerEvents();
  }

  private setupCanvas() {
    // Set canvas size to match display size
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    
    this.ctx.scale(dpr, dpr);
    
    // Set default canvas styles
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
  }

  private setupPointerEvents() {
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerUp);
  }

  private handlePointerDown = (e: PointerEvent) => {
    this.isDrawing = true;
    this.rawPoints = [];
    
    const point = this.getPointerPoint(e);
    this.lastPoint = point;
    this.rawPoints.push(point);

    // Create new stroke
    this.currentStroke = {
      id: `stroke_${Date.now()}_${Math.random()}`,
      points: [point],
      style: { ...this.currentStyle },
      finished: false
    };

    this.canvas.setPointerCapture(e.pointerId);

    // Notify network (M2)
    if (this.onStrokeStart) {
      this.onStrokeStart(this.currentStroke);
    }
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (!this.isDrawing || !this.currentStroke) return;

    const point = this.getPointerPoint(e);
    this.rawPoints.push(point);

    // Resample and smooth for rendering
    const resampled = resamplePoints(this.rawPoints, 3);
    let smoothed = resampled;

    if (this.currentStyle.smoothing === 'quadratic') {
      smoothed = smoothQuadratic(resampled);
    } else if (this.currentStyle.smoothing === 'cubic') {
      smoothed = smoothCubic(resampled);
    }

    // Get new points since last update
    const previousLength = this.currentStroke.points.length;
    this.currentStroke.points = smoothed;
    const newPoints = smoothed.slice(previousLength);

    // Notify network of new points (M2)
    if (newPoints.length > 0 && this.onStrokePoint) {
      this.onStrokePoint(this.currentStroke.id, newPoints);
    }
    
    // Render incrementally
    this.render();
  };

  private handlePointerUp = (e: PointerEvent) => {
    if (!this.isDrawing || !this.currentStroke) return;

    const point = this.getPointerPoint(e);
    this.rawPoints.push(point);

    // Final smoothing
    const resampled = resamplePoints(this.rawPoints, 3);
    let smoothed = resampled;

    if (this.currentStyle.smoothing === 'quadratic') {
      smoothed = smoothQuadratic(resampled);
    } else if (this.currentStyle.smoothing === 'cubic') {
      smoothed = smoothCubic(resampled);
    }

    this.currentStroke.points = smoothed;
    this.currentStroke.finished = true;

    // Notify network (M2)
    if (this.onStrokeEnd) {
      this.onStrokeEnd(this.currentStroke);
    }

    // Add to strokes and operation stack
    this.strokes.push(this.currentStroke);
    this.operationStack.push({
      type: 'stroke',
      stroke: this.currentStroke,
      timestamp: Date.now()
    });
    this.undoneStack = []; // Clear redo stack

    this.currentStroke = null;
    this.isDrawing = false;
    this.lastPoint = null;
    this.rawPoints = [];

    this.render();
  };

  private getPointerPoint(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure || 0.5,
      timestamp: Date.now()
    };
  }

  /**
   * Render all strokes to canvas
   */
  render(remoteStrokes?: Map<string, Stroke>) {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    
    // Clear canvas
    this.ctx.clearRect(0, 0, rect.width, rect.height);

    // Render all finished strokes
    for (const stroke of this.strokes) {
      this.renderStroke(stroke);
    }

    // Render remote strokes (M2)
    if (remoteStrokes) {
      for (const stroke of remoteStrokes.values()) {
        this.renderStroke(stroke);
      }
    }

    // Render current stroke
    if (this.currentStroke) {
      this.renderStroke(this.currentStroke);
    }
  }

  private renderStroke(stroke: Stroke) {
    if (stroke.points.length < 2) return;

    const { color, width, tool } = stroke.style;

    this.ctx.save();

    // Set compositing mode for eraser
    if (tool === 'eraser') {
      this.ctx.globalCompositeOperation = 'destination-out';
    } else {
      this.ctx.globalCompositeOperation = 'source-over';
    }

    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = width;

    this.ctx.beginPath();
    this.ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

    for (let i = 1; i < stroke.points.length; i++) {
      const point = stroke.points[i];
      this.ctx.lineTo(point.x, point.y);
    }

    this.ctx.stroke();
    this.ctx.restore();
  }

  /**
   * Undo last operation
   */
  undo() {
    if (this.operationStack.length === 0) return;

    const op = this.operationStack.pop()!;
    this.undoneStack.push(op);

    // Rebuild strokes from operation stack
    this.strokes = [];
    for (const operation of this.operationStack) {
      if (operation.type === 'stroke' && operation.stroke) {
        this.strokes.push(operation.stroke);
      }
    }

    this.render();
  }

  /**
   * Redo last undone operation
   */
  redo() {
    if (this.undoneStack.length === 0) return;

    const op = this.undoneStack.pop()!;
    this.operationStack.push(op);

    if (op.type === 'stroke' && op.stroke) {
      this.strokes.push(op.stroke);
    }

    this.render();
  }

  /**
   * Set current drawing style
   */
  setStyle(style: Partial<StrokeStyle>) {
    this.currentStyle = { ...this.currentStyle, ...style };
  }

  /**
   * Add an external stroke (from network)
   */
  addRemoteStroke(stroke: Stroke) {
    this.strokes.push(stroke);
    this.operationStack.push({
      type: 'stroke',
      stroke,
      timestamp: Date.now()
    });
  }

  /**
   * Get current style
   */
  getStyle(): StrokeStyle {
    return { ...this.currentStyle };
  }

  /**
   * Clear canvas
   */
  clear() {
    this.strokes = [];
    this.operationStack = [];
    this.undoneStack = [];
    this.render();
  }

  /**
   * Serialize canvas state
   */
  serialize(): string {
    return JSON.stringify({
      strokes: this.strokes,
      operations: this.operationStack
    });
  }

  /**
   * Load canvas state from JSON
   */
  load(json: string) {
    try {
      const data = JSON.parse(json);
      this.strokes = data.strokes || [];
      this.operationStack = data.operations || [];
      this.undoneStack = [];
      this.render();
    } catch (error) {
      console.error('Failed to load canvas state:', error);
    }
  }

  /**
   * Cleanup
   */
  destroy() {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
  }
}
