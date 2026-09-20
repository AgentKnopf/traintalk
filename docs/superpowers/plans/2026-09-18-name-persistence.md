# Name Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a user's assigned name across page refreshes using `sessionStorage` and a server-side claim token, so a refresh restores the same name instead of assigning a new one.

**Architecture:** On first join, the server generates a random 16-byte hex token paired to the assigned name and returns it in the `joined` message. The client stores `{ name, token }` in `sessionStorage`. On reconnect, the client sends a `claim` message with both values. The server validates the token, checks the name is still free, swaps the identity, then broadcasts a `renamed` event to peers so every client's UI reflects the final name.

**Tech Stack:** Node.js (ES modules), `ws` library, vanilla browser JS, `crypto.randomBytes` (built-in Node)

**Spec:** `docs/superpowers/plans/2026-09-18-name-persistence.md` (this file)

## Global Constraints

- No new npm dependencies — use Node.js built-ins only (`node:crypto`)
- All DOM insertion must use `textContent`, never `innerHTML`
- Name format is always `Adjective Animal` — two capitalised words, matching `/^[A-Z][a-z]+ [A-Z][a-z]+$/`
- `sessionStorage` key: `trainchat-name` (string JSON: `{ name, token }`)
- Token: 16 bytes hex (32 hex chars), generated with `crypto.randomBytes(16).toString('hex')`
- Existing 12 tests must remain passing after changes
- `maxPayload` on the WebSocket server is 1024 bytes — claim message must stay within that
- Branch name: `feat/name-persistence`

---

### Task 1: Add token generation and storage to the server

**Files:**
- Modify: `src/server.js`

**Interfaces:**
- Produces: `nameTokens: Map<name, string>` — module-scoped inside `createServer()`, maps active name → token. Consumed by Task 2.
- Produces: `joined` message shape updated to `{ type, name, token, roomSize }` — consumed by Task 3.

- [ ] **Step 1: Import `randomBytes` from `node:crypto`**

Add to the top of `src/server.js`:
```js
import { randomBytes } from 'node:crypto';
```

- [ ] **Step 2: Add `nameTokens` map inside `createServer()`**

After the existing `connectionCount` map declaration (line ~73), add:
```js
// nameTokens: Map<name, token> — proves ownership for claim validation.
// Entry created on join, deleted on cleanup.
const nameTokens = new Map();
```

- [ ] **Step 3: Generate token on connect and store it**

In `wss.on('connection', ...)`, after `identityMap.set(ws, { name, roomId, ip })` (line ~211), add:
```js
const token = randomBytes(16).toString('hex');
nameTokens.set(name, token);
```

- [ ] **Step 4: Send token in the `joined` confirmation to the new peer**

Update the `ws.send(...)` call (line ~218) from:
```js
ws.send(JSON.stringify({ type: 'joined', name, roomSize: roomSet.size }));
```
to:
```js
ws.send(JSON.stringify({ type: 'joined', name, token, roomSize: roomSet.size }));
```
Note: the broadcast to existing peers does NOT include the token (it's private to the joining client).

- [ ] **Step 5: Delete token in `cleanup()`**

In the `cleanup(ws)` function, after `identityMap.delete(ws)` (line ~155), add:
```js
nameTokens.delete(name);
```

- [ ] **Step 6: Write failing tests for token presence**

Add to `test/server.test.js`:
```js
test('joined confirmation includes a token', async () => {
  const ws = await connect();
  const msg = await nextMessage(ws);
  assert.equal(msg.type, 'joined');
  assert.ok(typeof msg.token === 'string');
  assert.match(msg.token, /^[0-9a-f]{32}$/);
  await closeAndWait(ws);
});

test('joined broadcast to existing peers does not include token', async () => {
  const ws1 = await connect();
  await nextMessage(ws1); // consume ws1's own join

  const ws2 = await connect();
  await nextMessage(ws2); // ws2's own join (has token)

  // ws1 receives the peer-joined broadcast — must NOT have token
  const peerJoin = await nextMessage(ws1);
  assert.equal(peerJoin.type, 'joined');
  assert.equal(peerJoin.token, undefined);

  await closeAndWait(ws1);
  await closeAndWait(ws2);
});
```

- [ ] **Step 7: Run tests — expect the two new tests to PASS, all others to remain green**

```bash
node --test test/**/*.test.js
```
Expected: 14 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: generate and send join token for name claim authentication"
```

---

### Task 2: Handle `claim` message on the server

**Files:**
- Modify: `src/server.js`

**Interfaces:**
- Consumes: `nameTokens: Map<name, token>` from Task 1
- Consumes: `getRoomNames(roomId)` — existing helper
- Consumes: `broadcast(roomId, envelope, exclude)` — existing helper
- Produces: new message type `renamed` — `{ type: 'renamed', from: string, to: string }` — broadcast to room peers (not the claimer). Consumed by Task 3 (client).
- Produces: updated `joined` confirmation to claimer with final name and token

**Name validation regex:** `/^[A-Z][a-z]+ [A-Z][a-z]+$/`

- [ ] **Step 1: Write failing tests for claim handling**

Add to `test/server.test.js`:
```js
test('valid claim restores name and server broadcasts renamed', async () => {
  // Connect and capture token
  const ws1 = await connect();
  const join1 = await nextMessage(ws1);
  const originalName = join1.name;
  const token = join1.token;

  // Connect a second peer to observe broadcasts
  const ws2 = await connect();
  await nextMessage(ws2); // ws2's own join
  // ws2 receives ws1's original join broadcast — consume it
  // (already consumed above since ws2 connected after ws1)

  // Simulate ws1 reconnect: new connection claiming original name
  const ws3 = await connect();
  const tempJoin = await nextMessage(ws3); // temp name assigned
  const tempName = tempJoin.name;

  // ws2 sees ws3 join under tempName
  const tempJoinBroadcast = await nextMessage(ws2);
  assert.equal(tempJoinBroadcast.name, tempName);

  // ws3 sends claim
  ws3.send(JSON.stringify({ type: 'claim', name: originalName, token }));

  // ws3 gets updated joined with original name
  const claimResult = await nextMessage(ws3);
  assert.equal(claimResult.type, 'joined');
  assert.equal(claimResult.name, originalName);
  assert.ok(typeof claimResult.token === 'string');

  // ws2 sees renamed broadcast
  const renamed = await nextMessage(ws2);
  assert.equal(renamed.type, 'renamed');
  assert.equal(renamed.from, tempName);
  assert.equal(renamed.to, originalName);

  await closeAndWait(ws1);
  await closeAndWait(ws2);
  await closeAndWait(ws3);
});

test('claim with wrong token is rejected silently', async () => {
  const ws1 = await connect();
  const join1 = await nextMessage(ws1);
  const originalName = join1.name;

  const ws2 = await connect();
  const tempJoin = await nextMessage(ws2);
  const tempName = tempJoin.name;

  // Send claim with wrong token
  ws2.send(JSON.stringify({ type: 'claim', name: originalName, token: 'deadbeef'.repeat(4) }));

  // No renamed broadcast — send a probe msg to confirm ws2 still has tempName
  const ws3 = await connect();
  await nextMessage(ws3);

  const received = nextMessage(ws3);
  ws2.send(JSON.stringify({ type: 'msg', text: 'probe' }));
  const probe = await received;
  assert.equal(probe.from, tempName); // still the temp name

  await closeAndWait(ws1);
  await closeAndWait(ws2);
  await closeAndWait(ws3);
});

test('claim for a name already taken by another connection is rejected', async () => {
  const ws1 = await connect();
  const join1 = await nextMessage(ws1);
  const name1 = join1.name;
  const token1 = join1.token;

  // ws2 connects, claims ws1's name — but ws1 is still connected so name is taken
  const ws2 = await connect();
  const tempJoin = await nextMessage(ws2);
  const tempName = tempJoin.name;

  ws2.send(JSON.stringify({ type: 'claim', name: name1, token: token1 }));

  // ws2 should still have tempName (claim rejected)
  const ws3 = await connect();
  await nextMessage(ws3);

  const received = nextMessage(ws3);
  ws2.send(JSON.stringify({ type: 'msg', text: 'probe' }));
  const probe = await received;
  assert.equal(probe.from, tempName);

  await closeAndWait(ws1);
  await closeAndWait(ws2);
  await closeAndWait(ws3);
});
```

- [ ] **Step 2: Run tests — expect the 3 new tests to FAIL (claim not implemented yet)**

```bash
node --test test/**/*.test.js
```
Expected: 14 pass, 3 fail.

- [ ] **Step 3: Implement claim handling in the message handler**

In `src/server.js`, in the `ws.on('message', ...)` handler, replace:
```js
// Unknown types dropped silently (no logging of content)
if (msg.type !== 'msg') return;
```
with:
```js
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
```

- [ ] **Step 4: Run tests — all 17 should pass**

```bash
node --test test/**/*.test.js
```
Expected: 17 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: handle claim message with token validation and renamed broadcast"
```

---

### Task 3: Update the client to persist and restore name

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `joined` message now includes `token` field (from Task 1)
- Consumes: new `renamed` message `{ type: 'renamed', from: string, to: string }` (from Task 2)
- `sessionStorage` key: `trainchat-name`, value: JSON string `{ name: string, token: string }`

- [ ] **Step 1: On `open`, send a claim if sessionStorage has one**

In `public/app.js`, update the `open` listener from:
```js
ws.addEventListener('open', () => {
  addSystem('Connected — waiting for room info…');
});
```
to:
```js
ws.addEventListener('open', () => {
  addSystem('Connected — waiting for room info…');
  try {
    const saved = JSON.parse(sessionStorage.getItem('trainchat-name') ?? 'null');
    if (saved?.name && saved?.token) {
      ws.send(JSON.stringify({ type: 'claim', name: saved.name, token: saved.token }));
    }
  } catch { /* corrupt sessionStorage — ignore */ }
});
```

- [ ] **Step 2: Store name+token on first `joined`, and update on subsequent `joined`**

Update the first `joined` branch in the `message` listener. Currently:
```js
if (msg.type === 'joined' && !myName) {
  // Our own join confirmation
  myName = msg.name;
  myNameEl.textContent = msg.name;
  updateRoomSize(msg.roomSize);
  setEnabled(true);
  addSystem(`You joined as ${msg.name}`);
  return;
}
```

Replace with:
```js
if (msg.type === 'joined' && !myName) {
  // Own join confirmation (initial or after claim)
  myName = msg.name;
  myNameEl.textContent = msg.name;
  updateRoomSize(msg.roomSize);
  setEnabled(true);
  addSystem(`You joined as ${msg.name}`);
  if (msg.token) {
    sessionStorage.setItem('trainchat-name', JSON.stringify({ name: msg.name, token: msg.token }));
  }
  return;
}

if (msg.type === 'joined' && myName && msg.token) {
  // Claim succeeded — server confirmed our name with a fresh token
  myName = msg.name;
  myNameEl.textContent = msg.name;
  updateRoomSize(msg.roomSize);
  sessionStorage.setItem('trainchat-name', JSON.stringify({ name: msg.name, token: msg.token }));
  return;
}
```

- [ ] **Step 3: Handle `renamed` message from server**

After the `left` handler block, add:
```js
if (msg.type === 'renamed') {
  addSystem(`${msg.from} is now ${msg.to}`);
  return;
}
```

- [ ] **Step 4: Manual smoke test**

Start the server locally:
```bash
node src/server.js
```
Open `http://localhost:3000` in a browser. Note your assigned name shown in the UI. Refresh the page. Verify:
- Your name is the same after refresh
- The chat shows "You joined as [same name]" (not a different one)
- Opening a second tab gets a different name (sessionStorage is per-tab)

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat: persist and restore name across refreshes via sessionStorage and claim"
```

---

### Task 4: Remove the temporary debug connection log

**Files:**
- Modify: `src/server.js`

The `console.log` added during IPv6 debugging (line ~178) is now confirmed working and leaks room key information on every connection. Remove it before shipping.

- [ ] **Step 1: Remove the log line**

In `src/server.js`, delete:
```js
console.log(`[connect] ip=${ip} room=${room} fly-client-ip=${flyIp ?? 'none'} remoteAddress=${req.socket.remoteAddress}`);
```

- [ ] **Step 2: Run all tests to confirm nothing broke**

```bash
node --test test/**/*.test.js
```
Expected: 17 pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "chore: remove debug connection log"
```
