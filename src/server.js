import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { assignName } from './names.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const ALLOWED_ORIGINS = new Set([
  'https://traintalk.fly.dev',
  'https://traintalk.app',
  'http://localhost:3000',
]);

// Normalise an IP to a room key.
// IPv6: truncate to /64 prefix (first 4 groups) so devices on the same WiFi
// share a room despite IPv6 privacy addressing assigning each device a unique
// interface identifier. IPv4 and IPv4-mapped addresses use the full address.
function roomKey(ip) {
  // Strip IPv4-mapped prefix (::ffff:1.2.3.4 → 1.2.3.4)
  const addr = ip.replace(/^::ffff:/i, '');
  // Pure IPv4 — use as-is
  if (addr.includes('.')) return addr;
  // IPv6 — keep only the first 4 groups (64-bit network prefix)
  const groups = addr.split(':');
  return groups.slice(0, 4).join(':');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self' wss://traintalk.fly.dev wss://traintalk.app",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

// Token bucket: 5 tokens max, refill 1 token every 200ms (= 5 msg/sec)
function makeRateLimiter() {
  let tokens = 5;
  const interval = setInterval(() => {
    if (tokens < 5) tokens++;
  }, 200);
  // Don't keep the process alive just for this timer
  interval.unref();
  return {
    consume() {
      if (tokens <= 0) return false;
      tokens--;
      return true;
    },
    destroy() {
      clearInterval(interval);
    },
  };
}

export function createServer() {
  // rooms: Map<roomId, Set<WebSocket>>
  const rooms = new Map();
  // identityMap: Map<WebSocket, { name, roomId }>
  const identityMap = new Map();
  // connectionCount: Map<roomId, number> — enforces max 300 connections per room
  const connectionCount = new Map();
  // nameTokens: Map<name, token> — proves ownership for claim validation.
  // Entry created on join, deleted on cleanup.
  const nameTokens = new Map();

  const httpServer = createHttpServer((req, res) => {
    // Path traversal guard: reject any path containing '..'
    if (req.url.includes('..')) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    const filePath = join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
    try {
      const body = readFileSync(filePath);
      const ext = extname(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Security-Policy': CSP,
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  // Timeout guards against slow-header and slow-body attacks
  httpServer.headersTimeout = 10000;
  httpServer.requestTimeout = 10000;

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 1024, // hard cap at WebSocket frame level — not post-parse
    verifyClient(info, cb) {
      const origin = info.origin;
      // Non-browser clients send no Origin header — accepted (CSRF prevention only)
      if (!origin) {
        cb(true);
        return;
      }
      if (ALLOWED_ORIGINS.has(origin)) {
        cb(true);
      } else {
        cb(false, 403, 'Forbidden');
      }
    },
  });

  /** Returns a Set of all names currently active in a room. */
  function getRoomNames(roomId) {
    const room = rooms.get(roomId);
    if (!room) return new Set();
    const names = new Set();
    for (const ws of room) {
      const entry = identityMap.get(ws);
      if (entry) names.add(entry.name);
    }
    return names;
  }

  /** Broadcast an envelope to all peers in a room, optionally excluding one. */
  function broadcast(roomId, envelope, exclude = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    const data = JSON.stringify(envelope);
    for (const ws of room) {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  /**
   * Clean up a disconnected socket:
   * - Remove from identity map
   * - Remove from room; delete empty rooms
   * - Broadcast departure to remaining peers
   * - Decrement per-IP connection counter
   * Note: nameTokens entry is NOT deleted on disconnect so the token can be used for claim()
   */
  function cleanup(ws) {
    const entry = identityMap.get(ws);
    if (!entry) return; // already cleaned up (idempotent)
    const { name, roomId, ip } = entry;
    identityMap.delete(ws);
    // NOTE: do NOT delete nameTokens[name] — it's needed for claim validation

    const room = rooms.get(roomId);
    if (room) {
      room.delete(ws);
      if (room.size === 0) {
        rooms.delete(roomId); // empty room — remove immediately
      } else {
        broadcast(roomId, { type: 'left', name, roomSize: room.size });
      }
    }

    const count = (connectionCount.get(roomId) ?? 1) - 1;
    if (count <= 0) connectionCount.delete(roomId);
    else connectionCount.set(roomId, count);
  }

  wss.on('connection', (ws, req) => {
    // Fly.io sets Fly-Client-IP to the real client IP at their edge.
    // Fall back to socket.remoteAddress for local/direct deployments.
    const flyIp = req.headers['fly-client-ip'];
    const ip = flyIp ?? req.socket.remoteAddress ?? 'unknown';
    const room = roomKey(ip);

    // Enforce max 300 connections per room (a full train car on shared WiFi)
    const count = connectionCount.get(room) ?? 0;
    if (count >= 300) {
      ws.close(1008, 'Too many connections from your network');
      return;
    }

    const rateLimiter = makeRateLimiter();

    // Use /64 subnet as room ID — everyone on the same WiFi shares a room.
    const roomId = room;

    // Register close/error handlers BEFORE adding to any map,
    // so a race between connection and immediate close never leaks the socket.
    // Note: ws never emits a 'terminate' event — ws#terminate() triggers 'close',
    // so the close handler covers that path too.
    // so we never leak a socket reference if the handlers aren't set up.
    function onClose() {
      rateLimiter.destroy();
      cleanup(ws);
    }
    ws.on('close', onClose);
    ws.on('error', onClose);

    // Now it's safe to register in maps
    connectionCount.set(roomId, count + 1);

    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const roomSet = rooms.get(roomId);

    const name = assignName(getRoomNames(roomId));
    identityMap.set(ws, { name, roomId, ip });
    const token = randomBytes(16).toString('hex');
    nameTokens.set(name, token);
    roomSet.add(ws);

    // Notify existing peers that someone joined
    broadcast(roomId, { type: 'joined', name, roomSize: roomSet.size }, ws);

    // Send join confirmation to the new peer (their own name + token + current room size)
    ws.send(JSON.stringify({ type: 'joined', name, token, roomSize: roomSet.size }));

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        // Malformed JSON — terminate immediately
        ws.terminate();
        return;
      }

      if (msg.type === 'claim') {
        const { name: claimedName, token: claimedToken } = msg;
        // Validate format — must match Adjective Animal pattern
        if (typeof claimedName !== 'string' || !/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(claimedName)) return;
        if (typeof claimedToken !== 'string' || claimedToken.length !== 32) return;
        // Token must match what was issued for this name
        if (nameTokens.get(claimedName) !== claimedToken) return;
        // Name must be free (original owner must have disconnected)
        if (getRoomNames(roomId).has(claimedName)) return;

        const entry = identityMap.get(ws);
        const oldName = entry.name;

        // Delete old token, issue new one for claimed name
        nameTokens.delete(oldName);
        const newToken = randomBytes(16).toString('hex');
        nameTokens.set(claimedName, newToken);

        // Update identity
        identityMap.set(ws, { ...entry, name: claimedName });

        // Broadcast rename to peers
        const roomSet = rooms.get(roomId);
        broadcast(roomId, { type: 'renamed', from: oldName, to: claimedName }, ws);

        // Confirm to claimer with new token
        ws.send(JSON.stringify({
          type: 'joined',
          name: claimedName,
          token: newToken,
          roomSize: roomSet?.size ?? 1,
        }));
        return;
      }

      // Unknown types dropped silently (no logging of content)
      if (msg.type !== 'msg') return;

      if (typeof msg.text !== 'string') return;
      const text = msg.text.trim();

      // Enforce text length limit (1–500 chars after trim)
      if (text.length < 1 || text.length > 500) return;

      // Rate limit: 5 msg/sec per connection
      if (!rateLimiter.consume()) return;

      // Broadcast to all peers — server always sets `from`, clients cannot spoof it
      broadcast(roomId, {
        type: 'msg',
        from: identityMap.get(ws)?.name ?? name,
        text,
        ts: Date.now(),
      });
    });
  });

  return {
    httpServer,
    wss,
    close() {
      return new Promise((resolve) => {
        // Terminate all open connections so wss.close() doesn't hang waiting for them
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => httpServer.close(resolve));
      });
    },
  };
}

// Only start listening when run directly (not when imported for testing)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = process.env.PORT ?? 3000;
  const { httpServer } = createServer();
  httpServer.listen(PORT, () => {
    console.log(`TrainTalk running on http://localhost:${PORT}`);
  });
}
