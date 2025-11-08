# Collaborative Canvas — Technical Architecture

## Overview

A real-time collaborative drawing application built with TypeScript, Canvas API, and WebSocket. Features include smooth path rendering, client-side prediction, authoritative server state, and global undo/redo.

---

## 1. Data Model

### 1.1 Immutable Operations

All modifications to the canvas are represented as immutable operations (ops) with monotonically increasing sequence numbers assigned by the server.

**StrokeOp**
```typescript
{
  type: 'stroke',
  id: string,           // Unique stroke ID
  seq: number,          // Server-assigned sequence number
  userId: string,       // Author client ID
  tool: 'brush' | 'eraser',
  color: string,        // Hex color
  width: number,        // Stroke width in pixels
  points: Point[],      // Array of {x, y, t?}
  startTs: number,      // Timestamp when started
  endTs: number,        // Timestamp when finished
  isUndone?: boolean    // Tombstone flag
}
```

**UndoOp**
```typescript
{
  type: 'undo',
  id: string,
  seq: number,
  userId: string,
  targetSeq: number,    // Sequence number being undone
  timestamp: number
}
```

**RedoOp**
```typescript
{
  type: 'redo',
  id: string,
  seq: number,
  userId: string,
  targetSeq: number,    // Sequence number being redone
  timestamp: number
}
```

###  1.2 Tombstones

Undo/redo uses **tombstones** instead of mutation:
- Ops remain in the log permanently
- `tombstones: Set<seq>` tracks undone operations
- Redo removes from tombstones if conditions met
- Rendering skips tombstoned strokes

---

## 2. Client Architecture

### 2.1 Dual-Canvas Rendering

Two canvas layers for performance and prediction clarity:

**Main Canvas** — Committed, authoritative strokes
- Contains all `stroke:commit` ops from server
- Repainted only on undo/redo or late join
- Uses dirty-rect optimization where possible

**Scratch Canvas** — In-progress prediction
- Local user's current stroke (immediate feedback)
- Remote users' streaming points (prediction)
- Cleared on `stroke:commit` and replayed to Main

### 2.2 Smoothing Pipeline

1. **Capture**: Pointer events at native rate (pointerdown/move/up)
2. **Resample**: Distance-based (e.g., 1-3px spacing) to stabilize bandwidth
3. **Smooth**: Quadratic or cubic Bezier interpolation
   - Quadratic: 5 steps per 3-point window
   - Cubic (Catmull-Rom): 8 steps per 4-point window, tension=0.5
4. **Render**: Canvas 2D API with `lineCap/lineJoin: 'round'`

### 2.3 Eraser Implementation

Eraser is **just another stroke** with `globalCompositeOperation = 'destination-out'`.
- No special handling required
- Ordering via sequence numbers naturally resolves overlaps
- Avoids read-modify-write conflicts

### 2.4 History & Reconciliation

- Maintain local `appliedSeq` cursor
- On `stroke:commit` from server:
  - If local prediction exists for same `tempId`, discard prediction
  - Apply authoritative op to Main canvas
  - Increment `appliedSeq`
- On `undo:commit` or `redo:commit`:
  - Rebuild Main from last snapshot + tail replay, skipping tombstones

---

## 3. WebSocket Protocol

### 3.1 Message Types

#### Client → Server

**join**
```json
{
  "type": "join",
  "roomId": "alpha",
  "username": "Alice"
}
```

**stroke:start**
```json
{
  "type": "stroke:start",
  "tempId": "temp_123",
  "tool": "brush",
  "color": "#FF0000",
  "width": 5,
  "points": [{x: 10, y: 20}]
}
```

**stroke:points** (batched, 16-33ms or N points)
```json
{
  "type": "stroke:points",
  "tempId": "temp_123",
  "points": [{x: 11, y: 21}, {x: 12, y: 22}, ...]
}
```

**stroke:end**
```json
{
  "type": "stroke:end",
  "tempId": "temp_123",
  "points": [{x: 50, y: 60}]  // Final points for redundancy
}
```

**undo:request** / **redo:request**
```json
{
  "type": "undo:request",
  "requestId": "undo_456"
}
```

**cursor** (throttled ~30Hz)
```json
{
  "type": "cursor",
  "x": 100,
  "y": 200
}
```

**ping** (for latency measurement)
```json
{
  "type": "ping",
  "timestamp": 1699564800000
}
```

#### Server → Client

**welcome**
```json
{
  "type": "welcome",
  "clientId": "client_abc123",
  "timestamp": 1699564800000
}
```

**joined** (with snapshot)
```json
{
  "type": "joined",
  "roomId": "alpha",
  "clientId": "client_abc123",
  "username": "Alice",
  "color": "#FF6B6B",
  "roster": [
    {"clientId": "client_xyz", "username": "Bob", "color": "#4ECDC4"}
  ],
  "snapshot": {
    "data": "base64_png_or_json",
    "seq": 42
  },
  "currentSeq": 45
}
```

**state:tail** (ops after snapshot)
```json
{
  "type": "state:tail",
  "ops": [
    {/*StrokeOp seq=43*/},
    {/*StrokeOp seq=44*/},
    {/*UndoOp seq=45*/}
  ]
}
```

**stroke:commit** (authoritative)
```json
{
  "type": "stroke:commit",
  "op": {
    "type": "stroke",
    "id": "stroke_789",
    "seq": 46,
    "userId": "client_abc123",
    "tool": "brush",
    "color": "#FF0000",
    "width": 5,
    "points": [{x: 10, y: 20}, ...],
    "startTs": 1699564800000,
    "endTs": 1699564801000
  },
  "timestamp": 1699564801000
}
```

**undo:commit** / **redo:commit**
```json
{
  "type": "undo:commit",
  "op": {
    "type": "undo",
    "id": "undo_46",
    "seq": 47,
    "userId": "client_abc123",
    "targetSeq": 43,
    "timestamp": 1699564802000
  },
  "timestamp": 1699564802000
}
```

**user:joined** / **user:left**
```json
{
  "type": "user:joined",
  "clientId": "client_def456",
  "username": "Charlie",
  "color": "#45B7D1",
  "timestamp": 1699564803000
}
```

**cursor** (from remote user)
```json
{
  "type": "cursor",
  "clientId": "client_xyz",
  "x": 150,
  "y": 250,
  "timestamp": 1699564804000
}
```

**pong** (response to ping)
```json
{
  "type": "pong",
  "timestamp": 1699564800000,   // Client's original timestamp
  "serverTime": 1699564800050
}
```

### 3.2 Ordering Guarantees

- **Server is the arbiter**: All ops get a monotonic `seq` per room
- **Clients render by `seq`**: Ensures deterministic final state
- **In-progress streaming is non-authoritative**: Only for prediction; `stroke:commit` is truth

### 3.3 Reconnect & Late Join

**On Join:**
1. Server sends `snapshot` (PNG or serialized ops) at `seqAtSnapshot`
2. Server sends `state:tail` with ops where `seq > seqAtSnapshot`
3. Client renders snapshot, then replays tail

**On Reconnect:**
1. Client declares `lastSeqSeen`
2. Server sends ops where `seq > lastSeqSeen` (catch-up)

---

## 4. Server Architecture

### 4.1 Room State

Each room maintains:
```typescript
{
  id: string,
  members: Map<clientId, Member>,
  opLog: Op[],                 // All ops ordered by seq
  tombstones: Set<seq>,        // Undone operation seqs
  snapshot: {                  // Periodic snapshots
    data: string,              // PNG or JSON
    seq: number,
    timestamp: number
  },
  pendingStrokes: Map<tempId, PendingStroke>  // Incomplete strokes
}
```

### 4.2 Stroke Lifecycle

1. **stroke:start** → Create `PendingStroke` in room
2. **stroke:points** → Append points to pending stroke
3. **stroke:end** → Commit:
   - Assign `seq = nextSeq++`
   - Create `StrokeOp` with all points
   - Append to `opLog`
   - Broadcast `stroke:commit` to ALL (including sender for reconciliation)

### 4.3 Global Undo/Redo Semantics

**Undo:**
1. Find largest `seq` in `opLog` where `type='stroke'` and `seq ∉ tombstones`
2. Add to `tombstones`
3. Create `UndoOp` with new `seq`, append to `opLog`
4. Broadcast `undo:commit` to ALL

**Redo:**
1. Find most recent `seq ∈ tombstones` where `type='stroke'`
2. Check: no non-undo/redo ops after it (redo only works if at tail)
3. Remove from `tombstones`
4. Create `RedoOp` with new `seq`, append to `opLog`
5. Broadcast `redo:commit` to ALL

**Invariant:** Single shared timeline; any user can undo any op.

### 4.4 Snapshot Generation

- Triggered every **200 ops** or **15 seconds** of activity
- Render all `op ∈ opLog` where `type='stroke'` and `op.seq ∉ tombstones`
- Export as PNG (using node-canvas or headless browser)
- Store `{data, seq, timestamp}`
- Allows pruning old ops before `snapshot.seq` (optional)

### 4.5 Performance Limits

- **Presence throttle**: 20-30Hz max cursor updates
- **Point batching**: Batch `stroke:points` every 16-33ms or N points
- **Back-pressure**: Rate-limit clients sending >X ops/sec
- **Max points per stroke**: E.g., 10,000 points
- **Max strokes per minute**: E.g., 100 strokes

---

## 5. Conflict Resolution

### 5.1 Immutability + Total Ordering

- All ops are immutable
- Server assigns total ordering via `seq`
- Eraser is a stroke → no special conflict logic
- Clients render deterministically by `seq`

### 5.2 Example Conflict

**Scenario:** Alice and Bob draw overlapping strokes simultaneously.

1. Alice: `stroke:start` (tempId=A1)
2. Bob: `stroke:start` (tempId=B1)
3. Alice: `stroke:end` → Server assigns `seq=10`
4. Bob: `stroke:end` → Server assigns `seq=11`
5. Both clients receive:
   - `stroke:commit` seq=10 (Alice's)
   - `stroke:commit` seq=11 (Bob's)
6. Final render: Bob's stroke appears on top (higher seq)

**Outcome:** Deterministic, no ambiguity.

---

## 6. Data Flow Diagram

```
User Draws
    ↓
[Client] Pointer Events → Resample → Smooth → Render to Scratch
    ↓
[Client] Send stroke:start / stroke:points (throttled ~20Hz) / stroke:end
    ↓
[Server] Buffer points in PendingStroke
    ↓
[Server] On stroke:end → Commit:
         - Assign seq
         - Append to opLog
         - Broadcast stroke:commit to ALL
    ↓
[Other Clients] Receive stroke:commit → Render to Main Canvas
```

```
User Presses Ctrl+Z
    ↓
[Client] Send undo:request
    ↓
[Server] Global Undo:
         - Find last non-undone stroke
         - Add to tombstones
         - Create UndoOp with seq
         - Broadcast undo:commit to ALL
    ↓
[All Clients] Receive undo:commit:
              - Add targetSeq to local tombstones
              - Rebuild Main from snapshot + tail (skipping tombstones)
```

---

## 7. Performance Optimizations

### 7.1 Point Resampling

- Input: Raw pointer events (irregular timing/spacing)
- Output: Evenly spaced points (~1-3px apart)
- **Benefit:** Stable bandwidth, smoother curves, fewer render artifacts

### 7.2 Message Batching

- Batch `stroke:points` every 16-33ms or N points (whichever first)
- Reduce WebSocket message overhead
- **Benefit:** ~50% reduction in message count

### 7.3 Dirty-Rect Painting

- Compute bounding box per stroke
- Only repaint affected region
- **Benefit:** 2-5x faster for partial updates (not yet fully implemented)

### 7.4 Dual-Canvas Separation

- Main canvas: Stable, infrequently repainted
- Scratch canvas: Cleared and redrawn each frame
- **Benefit:** Avoid full repaint on every pointer move

### 7.5 Incremental Snapshots

- Keep mini-snapshots every N ops (e.g., every 50)
- Bound worst-case replay time for undo/redo
- **Benefit:** Undo/redo remains fast even with 1000+ ops

---

## 8. Testing Strategy

### 8.1 Functional Tests

- **Multi-user drawing**: Two browsers draw simultaneously; verify strokes appear correctly
- **Global undo**: User A draws, User B undos → verify A's stroke disappears for both
- **Eraser vs brush**: Verify deterministic layering based on `seq`
- **Late join**: User C joins mid-session → receives snapshot + tail, sees full canvas

### 8.2 Resilience Tests

- **Mid-stroke disconnect**: Kill client during stroke → incomplete stroke ignored
- **Reconnect**: Disconnect and rejoin → client catches up via tail
- **Server restart**: Verify state persistence (if implemented)

### 8.3 Performance Tests

- **10 concurrent users**: CPU < 60%, frame rate > 30fps
- **Long strokes**: 5000+ points → verify batching prevents freezes
- **Rapid undo/redo**: Spam Ctrl+Z/Y → verify responsiveness

---

## 9. Known Limitations & Future Work

### Current Limitations

- **Snapshots**: Currently JSON serialization; production needs PNG rendering (node-canvas)
- **Persistence**: No database; room state lost on server restart
- **Mobile touch**: Pointer events work, but pinch-to-zoom not fully optimized
- **Latency indicator**: Ping/pong implemented but not displayed in UI yet
- **Dirty-rect**: Bounding box calculated but full repaint still used

### Future Enhancements

- **Vector export**: Export canvas as SVG
- **Layers**: Multiple drawing layers with blend modes
- **Text tool**: Add text annotations
- **Image import**: Paste/drag images onto canvas
- **Permissions**: Room owners, read-only mode
- **Analytics**: Track usage, strokes per session, etc.

---

## 10. Deployment

### Development

```bash
# Terminal 1: Start WebSocket server
npm run server

# Terminal 2: Start Vite dev server
npm run dev
```

### Production

**Single-Instance Deploy (Render/Fly.io/Heroku):**
1. Set `PORT` env variable
2. Run `npm run server` (WebSocket)
3. Serve `dist/` (Vite build) via static file server or same process
4. Configure WebSocket timeouts (e.g., 60s)

**Multi-Instance (Horizontal Scaling):**
- Use Redis pub/sub for room fan-out
- Implement sticky sessions at load balancer (not required if using pub/sub)
- Share opLog via Redis or database

---

## 11. File Structure

```
collabrative-canvas/
├── client/
│   ├── canvas.ts          # Core drawing engine (dual-canvas, smoothing)
│   ├── websocket.ts       # WebSocket client connector
│   ├── main.ts            # App entry + UI wiring
│   ├── index.html         # UI layout
│   └── styles.css         # Styling
├── server/
│   ├── server.ts          # WebSocket server + message routing
│   ├── room.ts            # Room state management
│   └── drawing-state.ts   # Op log, tombstones, undo/redo logic
├── package.json
├── tsconfig.json
├── vite.config.ts
├── README.md              # User-facing quick start
└── ARCHITECTURE.md        # This document
```

---

## 12. Protocol Examples

### Example: Drawing a stroke

**Client → Server:**
```
stroke:start {tempId: "A1", tool: "brush", color: "#F00", width: 3, points: [{x:10,y:20}]}
stroke:points {tempId: "A1", points: [{x:11,y:21}, {x:12,y:22}]}
stroke:points {tempId: "A1", points: [{x:13,y:23}, {x:14,y:24}]}
stroke:end {tempId: "A1", points: [{x:15,y:25}]}
```

**Server → All Clients:**
```
stroke:commit {
  op: {
    type: "stroke", id: "stroke_789", seq: 42,
    userId: "client_abc", tool: "brush", color: "#F00", width: 3,
    points: [{x:10,y:20}, ..., {x:15,y:25}],
    startTs: T1, endTs: T2
  }
}
```

### Example: Global undo

**Client A → Server:**
```
undo:request {requestId: "undo_1"}
```

**Server → All Clients:**
```
undo:commit {
  op: {
    type: "undo", id: "undo_43", seq: 43,
    userId: "client_abc", targetSeq: 42, timestamp: T3
  }
}
```

**All clients:**
- Add `42` to `tombstones`
- Rebuild Main canvas from last snapshot, skipping seq=42

---

## 13. Measurement & Monitoring

### Client Metrics

- **FPS**: Rendered in status bar (green ≥55, yellow 30-54, red <30)
- **Latency** (planned): ping/pong RTT displayed
- **Strokes rendered**: Dev console logs

### Server Metrics

- **Active rooms**: `rooms.size`
- **Total clients**: `clientToRoom.size`
- **Ops per room**: `opLog.length`
- **Snapshot age**: `Date.now() - snapshot.timestamp`

### Logging

- Join/leave events
- Stroke commits with seq
- Undo/redo with target seq
- Errors (parse failures, unknown message types)

---

## 14. Security Considerations

*Not implemented yet; production checklist:*

- **Rate limiting**: Per-client message rate, ops per minute
- **Input validation**: Points within canvas bounds, color/width in valid ranges
- **Room authentication**: Optional passwords or tokens
- **XSS prevention**: Sanitize usernames
- **WebSocket origin check**: Validate `Origin` header

---

## 15. References & Inspiration

- **Excalidraw**: Collaborative whiteboard (reference for UX)
- **Figma**: Real-time collaboration architecture
- **Operational Transformation**: Classic conflict resolution (we use simpler seq-based approach)
- **CRDTs**: Conflict-free replicated data types (future exploration)

---

**Document Version:** 1.0  
**Last Updated:** November 9, 2025  
**Authors:** AI Assistant (Claude) + User
