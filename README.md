# Collaborative Canvas

A real-time collaborative drawing application with smooth path rendering, WebSocket networking, and presence features.

## Features Implemented

### M1 — Single-User Canvas Engine
- **Drawing Tools**: Brush and eraser with adjustable stroke width (1-50px)
- **Color Picker**: Hex color picker + 8 color presets
- **Smooth Paths**: Pointer capture → distance-based resampling → quadratic/cubic Bezier smoothing
- **Local Undo/Redo**: Full operation stack with Ctrl+Z/Ctrl+Y support
- **Persistence**: Save/load canvas state as JSON
- **Keyboard Shortcuts**:
  - `B` — Brush tool
  - `E` — Eraser tool
  - `[` / `]` — Decrease/increase stroke width
  - `Ctrl+Z` — Undo
  - `Ctrl+Y` or `Ctrl+Shift+Z` — Redo
- **FPS Monitor**: Real-time performance indicator (color-coded: green 55+, yellow 30-54, red <30)

### M2 — Real-Time Networking
- **WebSocket Server**: Room-based architecture with auto-reconnect
- **Streaming Strokes**: Points broadcast as you draw (~20Hz throttled)
- **Client-Side Prediction**: Instant local rendering + smooth remote stroke updates
- **Room Support**: URL param `?room=roomname` to join specific rooms
- **Graceful Degradation**: Works offline if server unavailable

### M3 — Presence & Cursors
- **Remote Cursors**: See collaborators' mouse positions in real-time (30Hz throttled)
- **User Colors**: Auto-assigned distinct colors per user
- **Online Roster**: Live panel showing all connected users with colors
- **Username Labels**: Cursor tooltips display usernames

## Quick Start

### Installation

```bash
npm install
```

### Running the Application

You need **two terminals**:

**Terminal 1 — WebSocket Server:**
```bash
npm run server
```
Server runs on `ws://localhost:8080`

**Terminal 2 — Vite Dev Server:**
```bash
npm run dev
```
Client runs on `http://localhost:5173/`

### Using Multiple Clients

Open multiple browser tabs/windows:
- Same room: `http://localhost:5173/?room=myroom&username=Alice`
- Different users: Change the `username` parameter
- Default room: Just `http://localhost:5173/` (uses "default" room)

## Roadmap & Architecture

### Completed (M1-M3)
- Single-user canvas engine with smooth drawing
- Real-time WebSocket networking
- Presence features (cursors, roster)
- Local undo/redo

### In Progress (M4-M5) — Enhanced Architecture
- **Immutable Op Log**: All operations (strokes, undo, redo) are immutable with server-assigned sequence numbers
- **Global Undo/Redo**: Any user can undo any operation; server maintains authoritative timeline with tombstones
- **Snapshot + Tail Sync**: Late joiners receive canvas snapshot + incremental ops for fast synchronization
- **Dual-Canvas Rendering**: Separation of committed (Main) and predicted (Scratch) rendering layers
- **Batched Messaging**: Point streaming batched every 16-33ms to reduce network overhead

### Planned (M6)
- Latency indicator (ping/pong RTT)
- Enhanced mobile touch support (pinch-to-zoom, pan)
- Deployment configuration
- Demo hosting

## Technical Documentation

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for comprehensive technical details:
- Data model (immutable ops, tombstones)
- WebSocket protocol schemas
- Client/server architecture
- Conflict resolution strategy
- Performance optimizations
- Deployment guide

## Tech Stack

- **Frontend**: TypeScript, Vite, Canvas API
- **Backend**: Node.js, WebSocket (`ws` library)
- **Dev Tools**: TSX for hot-reload, TypeScript strict mode

## Project Structure

```
collabrative-canvas/
├── client/
│   ├── canvas.ts       # Core drawing engine (strokes, smoothing, rendering)
│   ├── websocket.ts    # WebSocket client connector with reconnect
│   ├── main.ts         # App entry point + UI wiring
│   ├── index.html      # UI layout (toolbar, canvas, roster)
│   └── styles.css      # Styling
├── server/
│   ├── server.ts       # WebSocket server + message routing
│   ├── room.ts         # Room state management + member tracking
│   └── drawing-state.ts # Immutable op log, tombstones, undo/redo
├── package.json
├── tsconfig.json
├── vite.config.ts
├── README.md           # Quick start guide (this file)
└── ARCHITECTURE.md     # Technical architecture documentation
```

## Canvas Engine Architecture

### Stroke Pipeline
1. **Pointer Capture**: `pointerdown` → `pointermove` → `pointerup`
2. **Resampling**: Distance-based (3px spacing) for even point distribution
3. **Smoothing**: 
   - `none`: Raw resampled points
   - `quadratic`: Quadratic Bezier interpolation (5 steps per segment)
   - `cubic`: Catmull-Rom spline (8 steps, tension=0.5)
4. **Rendering**: Canvas 2D API with `lineCap: 'round'`, `lineJoin: 'round'`

### Network Protocol

**Client → Server:**
- `join` — Join room with username
- `stroke_start` — New stroke initiated (includes style, first point)
- `stroke_point` — Incremental points (throttled ~20Hz)
- `stroke_end` — Stroke finished (last points for redundancy)
- `cursor` — Mouse position (throttled ~30Hz)

**Server → Client:**
- `welcome` — Connection established (assigns clientId)
- `joined` — Room join confirmation (includes roster)
- `user_joined` / `user_left` — Roster updates
- `stroke_start` / `stroke_point` / `stroke_end` — Remote drawing events
- `cursor` — Remote cursor positions

## Testing Collaboration

1. Start server: `npm run server`
2. Start client: `npm run dev`
3. Open `http://localhost:5173/?room=test&username=Alice`
4. Open another tab: `http://localhost:5173/?room=test&username=Bob`
5. Draw in either tab — strokes appear in both!
6. Move mouse — cursors show in both tabs

## Development Notes

- **FPS**: Targets 60fps; monitor bottom-right status bar
- **Canvas Scaling**: Handles devicePixelRatio for crisp rendering on HiDPI displays
- **Eraser Tool**: Uses `globalCompositeOperation = 'destination-out'`
- **Touch Support**: `touch-action: none` prevents browser gestures (full touch events M6)

## Known Issues / Future Work

- [ ] Global undo/redo not yet implemented (local only)
- [ ] No persistence to database (save/load is local file only)
- [ ] Touch gestures not fully optimized for mobile
- [ ] No conflict resolution for concurrent edits (M5)
- [ ] Cursor positions offset if canvas resized after joining

## License

MIT

---

**Current Status**: M1 (Complete) | M2 (Complete) | M3 (Complete) | M4 (In Progress) | M5 (Planned) | M6 (Planned)

**Architecture**: See [ARCHITECTURE.md](./ARCHITECTURE.md) for complete technical documentation including protocol specs, data flow diagrams, and performance optimizations.
