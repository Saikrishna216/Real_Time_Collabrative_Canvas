/**
 * Room Management
 * 
 * Each room has its own drawing state, member list, and op log.
 */

import { WebSocket } from 'ws';
import { DrawingState, Op, StrokeOp, Point } from './drawing-state';

export interface Member {
  id: string;
  ws: WebSocket;
  username: string;
  color: string;
  joinedAt: number;
  lastSeen: number;
  cursor?: { x: number; y: number };
}

export interface PendingStroke {
  tempId: string;
  userId: string;
  tool: 'brush' | 'eraser';
  color: string;
  width: number;
  points: Point[];
  startTs: number;
}

export class Room {
  public id: string;
  private members = new Map<string, Member>();
  private drawingState = new DrawingState();
  private pendingStrokes = new Map<string, PendingStroke>(); // tempId -> pending stroke

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Add a member to the room
   */
  addMember(id: string, ws: WebSocket, username: string, color: string): Member {
    const member: Member = {
      id,
      ws,
      username,
      color,
      joinedAt: Date.now(),
      lastSeen: Date.now()
    };

    this.members.set(id, member);
    return member;
  }

  /**
   * Remove a member from the room
   */
  removeMember(id: string): boolean {
    return this.members.delete(id);
  }

  /**
   * Get a member
   */
  getMember(id: string): Member | undefined {
    return this.members.get(id);
  }

  /**
   * Get all members
   */
  getMembers(): Member[] {
    return Array.from(this.members.values());
  }

  /**
   * Get member count
   */
  getMemberCount(): number {
    return this.members.size;
  }

  /**
   * Update member cursor
   */
  updateCursor(id: string, x: number, y: number) {
    const member = this.members.get(id);
    if (member) {
      member.cursor = { x, y };
      member.lastSeen = Date.now();
    }
  }

  /**
   * Start a new stroke (streaming)
   */
  startStroke(
    tempId: string,
    userId: string,
    tool: 'brush' | 'eraser',
    color: string,
    width: number,
    points: Point[]
  ) {
    this.pendingStrokes.set(tempId, {
      tempId,
      userId,
      tool,
      color,
      width,
      points: [...points],
      startTs: Date.now()
    });
  }

  /**
   * Add points to a pending stroke
   */
  addStrokePoints(tempId: string, points: Point[]) {
    const stroke = this.pendingStrokes.get(tempId);
    if (stroke) {
      stroke.points.push(...points);
    }
  }

  /**
   * Commit a stroke (finalize)
   */
  commitStroke(tempId: string): StrokeOp | null {
    const pending = this.pendingStrokes.get(tempId);
    if (!pending) {
      return null;
    }

    const op = this.drawingState.addStroke(
      `stroke_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      pending.userId,
      pending.tool,
      pending.color,
      pending.width,
      pending.points,
      pending.startTs,
      Date.now()
    );

    this.pendingStrokes.delete(tempId);
    return op;
  }

  /**
   * Perform global undo
   */
  undo(userId: string) {
    return this.drawingState.undo(userId);
  }

  /**
   * Perform global redo
   */
  redo(userId: string) {
    return this.drawingState.redo(userId);
  }

  /**
   * Get snapshot and tail for new joins
   */
  getSnapshotAndTail() {
    return this.drawingState.getSnapshotAndTail();
  }

  /**
   * Get ops since a sequence number
   */
  getOpsSince(seq: number): Op[] {
    return this.drawingState.getOpsSince(seq);
  }

  /**
   * Get current sequence number
   */
  getCurrentSeq(): number {
    return this.drawingState.getCurrentSeq();
  }

  /**
   * Broadcast message to all members except sender
   */
  broadcast(message: any, excludeId?: string) {
    const payload = JSON.stringify(message);
    
    for (const member of this.members.values()) {
      if (member.id === excludeId) continue;
      
      if (member.ws.readyState === WebSocket.OPEN) {
        member.ws.send(payload);
      }
    }
  }

  /**
   * Broadcast message to all members
   */
  broadcastToAll(message: any) {
    this.broadcast(message);
  }

  /**
   * Send message to specific member
   */
  sendTo(memberId: string, message: any) {
    const member = this.members.get(memberId);
    if (member && member.ws.readyState === WebSocket.OPEN) {
      member.ws.send(JSON.stringify(message));
    }
  }
}
