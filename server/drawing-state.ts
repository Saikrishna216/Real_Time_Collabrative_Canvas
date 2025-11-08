/**
 * Drawing State Management
 * 
 * Server-side authoritative state with immutable ops,
 * tombstones, and snapshot generation.
 */

export interface Point {
  x: number;
  y: number;
  t?: number; // timestamp
}

export interface StrokeStyle {
  color: string;
  width: number;
  tool: 'brush' | 'eraser';
}

export interface StrokeOp {
  type: 'stroke';
  id: string;
  seq: number;
  userId: string;
  tool: 'brush' | 'eraser';
  color: string;
  width: number;
  points: Point[];
  startTs: number;
  endTs: number;
  isUndone?: boolean;
}

export interface UndoOp {
  type: 'undo';
  id: string;
  seq: number;
  userId: string;
  targetSeq: number; // The seq being undone
  timestamp: number;
}

export interface RedoOp {
  type: 'redo';
  id: string;
  seq: number;
  userId: string;
  targetSeq: number; // The seq being redone
  timestamp: number;
}

export type Op = StrokeOp | UndoOp | RedoOp;

export interface Snapshot {
  data: string; // Base64 PNG or serialized canvas state
  seq: number;
  timestamp: number;
}

export class DrawingState {
  private opLog: Op[] = [];
  private tombstones = new Set<number>(); // seq numbers of undone ops
  private nextSeq = 1;
  private snapshot: Snapshot | null = null;
  private snapshotInterval = 200; // Create snapshot every N ops
  private lastSnapshotOps = 0;

  /**
   * Add a stroke operation
   */
  addStroke(
    id: string,
    userId: string,
    tool: 'brush' | 'eraser',
    color: string,
    width: number,
    points: Point[],
    startTs: number,
    endTs: number
  ): StrokeOp {
    const seq = this.nextSeq++;
    const op: StrokeOp = {
      type: 'stroke',
      id,
      seq,
      userId,
      tool,
      color,
      width,
      points,
      startTs,
      endTs
    };

    this.opLog.push(op);
    this.checkSnapshot();
    return op;
  }

  /**
   * Perform global undo: undo the last non-undone operation
   */
  undo(userId: string): UndoOp | null {
    // Find the last non-undone op
    let targetSeq: number | null = null;
    for (let i = this.opLog.length - 1; i >= 0; i--) {
      const op = this.opLog[i];
      if (op.type === 'stroke' && !this.tombstones.has(op.seq)) {
        targetSeq = op.seq;
        break;
      }
    }

    if (targetSeq === null) {
      return null; // Nothing to undo
    }

    // Add to tombstones
    this.tombstones.add(targetSeq);

    // Create undo op
    const seq = this.nextSeq++;
    const undoOp: UndoOp = {
      type: 'undo',
      id: `undo_${seq}`,
      seq,
      userId,
      targetSeq,
      timestamp: Date.now()
    };

    this.opLog.push(undoOp);
    this.checkSnapshot();
    return undoOp;
  }

  /**
   * Perform global redo: redo the last undone op if at tail
   */
  redo(userId: string): RedoOp | null {
    // Find the most recent tombstoned op
    let targetSeq: number | null = null;
    let targetIdx = -1;

    for (let i = this.opLog.length - 1; i >= 0; i--) {
      const op = this.opLog[i];
      if (op.type === 'stroke' && this.tombstones.has(op.seq)) {
        targetSeq = op.seq;
        targetIdx = i;
        break;
      }
    }

    if (targetSeq === null) {
      return null; // Nothing to redo
    }

    // Check if there are any non-undo/redo ops after the target
    for (let i = targetIdx + 1; i < this.opLog.length; i++) {
      const op = this.opLog[i];
      if (op.type === 'stroke') {
        return null; // Can't redo if new strokes were added
      }
    }

    // Remove from tombstones
    this.tombstones.delete(targetSeq);

    // Create redo op
    const seq = this.nextSeq++;
    const redoOp: RedoOp = {
      type: 'redo',
      id: `redo_${seq}`,
      seq,
      userId,
      targetSeq,
      timestamp: Date.now()
    };

    this.opLog.push(redoOp);
    this.checkSnapshot();
    return redoOp;
  }

  /**
   * Get all ops after a given sequence number
   */
  getOpsSince(seq: number): Op[] {
    return this.opLog.filter(op => op.seq > seq);
  }

  /**
   * Get all non-undone ops
   */
  getActiveOps(): StrokeOp[] {
    return this.opLog.filter(
      op => op.type === 'stroke' && !this.tombstones.has(op.seq)
    ) as StrokeOp[];
  }

  /**
   * Get current sequence number
   */
  getCurrentSeq(): number {
    return this.nextSeq - 1;
  }

  /**
   * Get snapshot and tail for new joins
   */
  getSnapshotAndTail(): { snapshot: Snapshot | null; tail: Op[] } {
    if (this.snapshot) {
      return {
        snapshot: this.snapshot,
        tail: this.opLog.filter(op => op.seq > this.snapshot!.seq)
      };
    }
    return {
      snapshot: null,
      tail: this.opLog
    };
  }

  /**
   * Create a snapshot (placeholder - would use node-canvas in production)
   */
  private checkSnapshot() {
    const opsSinceSnapshot = this.opLog.length - this.lastSnapshotOps;
    
    if (opsSinceSnapshot >= this.snapshotInterval) {
      this.createSnapshot();
    }
  }

  private createSnapshot() {
    // In production, this would render all active ops to a canvas
    // and export as PNG. For now, we'll store a serialized version.
    const activeOps = this.getActiveOps();
    
    this.snapshot = {
      data: JSON.stringify(activeOps), // Simplified - would be PNG in production
      seq: this.getCurrentSeq(),
      timestamp: Date.now()
    };

    this.lastSnapshotOps = this.opLog.length;
    
    console.log(`[Snapshot] Created at seq=${this.snapshot.seq}, ${activeOps.length} active ops`);
  }

  /**
   * Get tombstones set
   */
  getTombstones(): Set<number> {
    return new Set(this.tombstones);
  }

  /**
   * Serialize state
   */
  serialize(): string {
    return JSON.stringify({
      opLog: this.opLog,
      tombstones: Array.from(this.tombstones),
      nextSeq: this.nextSeq,
      snapshot: this.snapshot
    });
  }

  /**
   * Load state
   */
  load(data: string) {
    try {
      const state = JSON.parse(data);
      this.opLog = state.opLog || [];
      this.tombstones = new Set(state.tombstones || []);
      this.nextSeq = state.nextSeq || 1;
      this.snapshot = state.snapshot || null;
      this.lastSnapshotOps = this.opLog.length;
    } catch (error) {
      console.error('Failed to load drawing state:', error);
    }
  }
}
