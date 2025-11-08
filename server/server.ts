/**
 * Authoritative WebSocket Server
 * 
 * Implements immutable op log, global undo/redo, snapshot+tail sync,
 * and proper stroke lifecycle with sequence numbers.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { Room } from './room';
import { Point } from './drawing-state';

export interface Message {
  type: string;
  [key: string]: any;
}

export class CollaborativeServer {
  private wss: WebSocketServer;
  private rooms = new Map<string, Room>(); // roomId -> Room
  private clientToRoom = new Map<string, string>(); // clientId -> roomId

  constructor(port: number = 8080) {
    const server = createServer();
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', this.handleConnection);

    server.listen(port, () => {
      console.log(`✓ WebSocket server running on ws://localhost:${port}`);
    });
  }

  private handleConnection = (ws: WebSocket) => {
    const clientId = this.generateClientId();
    console.log(`[${clientId}] Client connected`);

    // Setup message handler
    ws.on('message', (data: Buffer) => {
      try {
        const message: Message = JSON.parse(data.toString());
        this.handleMessage(clientId, ws, message);
      } catch (error) {
        console.error(`[${clientId}] Failed to parse message:`, error);
        this.sendError(ws, 'Invalid message format');
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      this.handleDisconnect(clientId);
    });

    ws.on('error', (error) => {
      console.error(`[${clientId}] WebSocket error:`, error);
    });

    // Send welcome message
    this.send(ws, {
      type: 'welcome',
      clientId,
      timestamp: Date.now()
    });
  };

  private handleMessage(clientId: string, ws: WebSocket, message: Message) {
    switch (message.type) {
      case 'join':
        this.handleJoin(clientId, ws, message);
        break;

      case 'leave':
        this.handleLeave(clientId);
        break;

      case 'stroke_start':
        this.handleStrokeStart(clientId, message);
        break;

      case 'stroke_point':
        this.handleStrokePoints(clientId, message);
        break;

      case 'stroke_end':
        this.handleStrokeEnd(clientId, message);
        break;

      case 'cursor':
        this.handleCursor(clientId, message);
        break;

      case 'undo':
        this.handleUndoRequest(clientId);
        break;

      case 'redo':
        this.handleRedoRequest(clientId);
        break;

      case 'ping':
        this.handlePing(clientId, ws, message);
        break;

      default:
        console.warn(`[${clientId}] Unknown message type: ${message.type}`);
    }
  }

  private handleJoin(clientId: string, ws: WebSocket, message: Message) {
    const { roomId, username } = message;

    if (!roomId) {
      this.sendError(ws, 'Room ID is required');
      return;
    }

    // Get or create room
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
      console.log(`[Room ${roomId}] Created`);
    }

    // Assign color to user
    const color = this.generateUserColor();

    // Add member to room
    const member = room.addMember(
      clientId,
      ws,
      username || `User ${clientId.slice(0, 4)}`,
      color
    );

    this.clientToRoom.set(clientId, roomId);

    console.log(`[${clientId}] Joined room "${roomId}" as "${member.username}"`);

    // Get snapshot and tail for this client
    const { snapshot, tail } = room.getSnapshotAndTail();

    // Send join confirmation with snapshot
    this.send(ws, {
      type: 'joined',
      roomId,
      clientId,
      username: member.username,
      color: member.color,
      roster: room.getMembers().map(m => ({
        clientId: m.id,
        username: m.username,
        color: m.color
      })),
      snapshot: snapshot ? {
        data: snapshot.data,
        seq: snapshot.seq
      } : null,
      currentSeq: room.getCurrentSeq()
    });

    // Send tail ops if any
    if (tail.length > 0) {
      this.send(ws, {
        type: 'state:tail',
        ops: tail
      });
    }

    // Notify other clients in the room
    room.broadcast({
      type: 'user_joined',
      clientId,
      username: member.username,
      color: member.color,
      timestamp: Date.now()
    }, clientId);
  }

  private handleLeave(clientId: string) {
    const roomId = this.clientToRoom.get(clientId);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    room.removeMember(clientId);
    this.clientToRoom.delete(clientId);

    console.log(`[${clientId}] Left room "${roomId}"`);

    // Notify others
    room.broadcast({
      type: 'user_left',
      clientId,
      timestamp: Date.now()
    });

    // Clean up empty rooms
    if (room.getMemberCount() === 0) {
      this.rooms.delete(roomId);
      console.log(`[Room ${roomId}] Deleted (empty)`);
    }
  }

  private handleDisconnect(clientId: string) {
    const roomId = this.clientToRoom.get(clientId);
    if (roomId) {
      console.log(`[${clientId}] Disconnected from room "${roomId}"`);
      this.handleLeave(clientId);
    } else {
      console.log(`[${clientId}] Disconnected (not in any room)`);
    }
  }

  private handleStrokeStart(clientId: string, message: Message) {
    const roomId = this.clientToRoom.get(clientId);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    // Extract stroke info (support both old and new protocol)
    const tempId = message.tempId || message.strokeId;
    const tool = message.tool || message.style?.tool || 'brush';
    const color = message.color || message.style?.color || '#000000';
    const width = message.width || message.style?.width || 2;
    const points = message.points || [];

    // Start buffering stroke in room
    room.startStroke(
      tempId,
      clientId,
      tool,
      color,
      width,
      points
    );

    // Broadcast to other clients (keep old protocol for now)
    room.broadcast({
      type: 'stroke_start',
      clientId,
      strokeId: tempId,
      points: points,
      style: { tool, color, width },
      timestamp: Date.now()
    }, clientId);
  }

  private handleStrokePoints(clientId: string, message: Message) {
    const roomId = this.clientToRoom.get(clientId);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    // Add points to pending stroke buffer
    const tempId = message.tempId || message.strokeId;
    room.addStrokePoints(clientId, message.points);

    // Broadcast to other clients (keep old protocol for now)
    room.broadcast({
      type: 'stroke_point',
      clientId,
      strokeId: tempId,
      points: message.points,
      timestamp: Date.now()
    }, clientId);
  }

  private handleStrokeEnd(clientId: string, message: Message) {
    const roomId = this.clientToRoom.get(clientId);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    // If there are additional points, add them
    if (message.points && message.points.length > 0) {
      room.addStrokePoints(clientId, message.points);
    }

    // Commit stroke and get server-assigned sequence number
    const op = room.commitStroke(clientId);

    // Broadcast to all clients (keep old protocol for now)
    const tempId = message.tempId || message.strokeId;
    room.broadcast({
      type: 'stroke_end',
      clientId,
      strokeId: tempId,
      points: message.points || [],
      seq: op?.seq,
      timestamp: Date.now()
    });
  }

  private handleCursor(clientId: string, message: Message) {
    const roomId = this.clientToRoom.get(clientId);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    // Update cursor and broadcast to other clients
    room.updateCursor(clientId, message.x, message.y);
    
    room.broadcast({
      type: 'cursor',
      clientId,
      x: message.x,
      y: message.y,
      timestamp: Date.now()
    }, clientId);
  }

  private handleUndoRequest(clientId: string) {
    const roomId = this.clientToRoom.get(clientId);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    // Perform undo and get operation
    const op = room.undo(clientId);

    if (op) {
      // Broadcast undo:commit to all clients
      room.broadcast({
        type: 'undo:commit',
        seq: op.seq,
        targetSeq: op.targetSeq,
        timestamp: Date.now()
      });
    }
  }

  private handleRedoRequest(clientId: string) {
    const roomId = this.clientToRoom.get(clientId);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    // Perform redo and get operation
    const op = room.redo(clientId);

    if (op) {
      // Broadcast redo:commit to all clients
      room.broadcast({
        type: 'redo:commit',
        seq: op.seq,
        targetSeq: op.targetSeq,
        timestamp: Date.now()
      });
    }
  }

  private handlePing(clientId: string, ws: WebSocket, message: Message) {
    this.send(ws, {
      type: 'pong',
      timestamp: Date.now()
    });
  }

  private send(ws: WebSocket, message: Message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, error: string) {
    this.send(ws, {
      type: 'error',
      error,
      timestamp: Date.now()
    });
  }

  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private generateUserColor(): string {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
      '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
      '#F8B195', '#F67280', '#C06C84', '#6C5B7B',
      '#355C7D', '#2A9D8F', '#E76F51', '#F4A261'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }
}

// Start server
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
new CollaborativeServer(PORT);
