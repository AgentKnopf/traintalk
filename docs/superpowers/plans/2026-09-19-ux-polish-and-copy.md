# UX Polish and Copy Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the name-flicker on reconnect (temp name briefly shown before claim resolves) and update the "How TrainChat works" copy to accurately reflect current behaviour — sessionStorage persistence, IPv6 room assignment, and no server-side logging.

**Architecture:** Two independent single-file changes. Task 1 adds a `pendingClaim` boolean flag to `app.js` to suppress the temporary-name announcement when a claim is in flight. Task 2 rewrites the five `<li>` bullets in `index.html` to be accurate.

**Tech Stack:** Vanilla browser JS, HTML. No server changes, no new dependencies.

**Spec:** This file.

## Global Constraints

- All DOM insertion must use `textContent`, never `innerHTML`
- No inline styles — CSS classes only (CSP `style-src 'self'`)
- No server changes — client files only (`public/app.js`, `public/index.html`)
- Existing 17 tests must remain passing
- The `<a>` tag in the last `<li>` of the info section must be preserved exactly as-is

---

### Task 1: Suppress temp-name announcement during claim

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- No new interfaces — self-contained within `app.js`
- Consumes existing: `sessionStorage` key `trainchat-name` (read on `open`), both `joined` branches in the message handler

**Current behaviour (broken):**
1. Page loads → WebSocket opens → server assigns random temp name → sends `joined`
2. Client shows "You joined as Hidden Ocelot" (branch 1, `!myName`)
3. Claim response arrives → "You rejoined as Jolly Raven" (branch 2)

**Target behaviour:**
1. Page loads → WebSocket opens → client sends claim immediately (has saved name+token)
2. Server assigns temp name → sends `joined` → client silently sets up the UI (no announcement)
3. Claim response arrives → "You rejoined as Jolly Raven" ✓

**If claim fails** (token expired or name taken): the silent branch 1 already set `myName` to the new random name and enabled the UI — user just has a new name, visible in the header. No announcement is fine; the header shows the current name at all times.

- [ ] **Step 1: Add `pendingClaim` flag**

In `public/app.js`, after `let myName = null;` (line 8), add:

```js
let pendingClaim = false;
```

- [ ] **Step 2: Set `pendingClaim = true` when sending a claim on `open`**

Update the `open` listener from:
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
to:
```js
ws.addEventListener('open', () => {
  addSystem('Connected — waiting for room info…');
  try {
    const saved = JSON.parse(sessionStorage.getItem('trainchat-name') ?? 'null');
    if (saved?.name && saved?.token) {
      pendingClaim = true;
      ws.send(JSON.stringify({ type: 'claim', name: saved.name, token: saved.token }));
    }
  } catch { /* corrupt sessionStorage — ignore */ }
});
```

- [ ] **Step 3: Suppress announcement in branch 1 when `pendingClaim` is true**

Update branch 1 of the `joined` handler from:
```js
  if (msg.type === 'joined' && !myName) {
    myName = msg.name;
    myNameEl.textContent = msg.name;
    updateRoomSize(msg.roomSize);
    setEnabled(true);
    replayHistory();
    addSystem(`You joined as ${msg.name}`);
    if (msg.token) {
      sessionStorage.setItem('trainchat-name', JSON.stringify({ name: msg.name, token: msg.token }));
    }
    return;
  }
```
to:
```js
  if (msg.type === 'joined' && !myName) {
    myName = msg.name;
    myNameEl.textContent = msg.name;
    updateRoomSize(msg.roomSize);
    setEnabled(true);
    if (!pendingClaim) {
      replayHistory();
      addSystem(`You joined as ${msg.name}`);
      if (msg.token) {
        sessionStorage.setItem('trainchat-name', JSON.stringify({ name: msg.name, token: msg.token }));
      }
    }
    return;
  }
```

Note: when `pendingClaim` is true we skip `replayHistory()` here too — replay will happen in branch 2 once the claim resolves with the correct name.

- [ ] **Step 4: Clear `pendingClaim` in branch 2**

Update branch 2 of the `joined` handler from:
```js
  if (msg.type === 'joined' && myName && msg.token) {
    myName = msg.name;
    myNameEl.textContent = msg.name;
    updateRoomSize(msg.roomSize);
    replayHistory();
    addSystem(`You rejoined as ${msg.name}`);
    sessionStorage.setItem('trainchat-name', JSON.stringify({ name: msg.name, token: msg.token }));
    return;
  }
```
to:
```js
  if (msg.type === 'joined' && myName && msg.token) {
    pendingClaim = false;
    myName = msg.name;
    myNameEl.textContent = msg.name;
    updateRoomSize(msg.roomSize);
    replayHistory();
    addSystem(`You rejoined as ${msg.name}`);
    sessionStorage.setItem('trainchat-name', JSON.stringify({ name: msg.name, token: msg.token }));
    return;
  }
```

- [ ] **Step 5: Manual smoke test**

Start the server:
```bash
node src/server.js
```

Open `http://localhost:3000`. Note your name (e.g. "Jolly Raven"). Refresh. Verify:
- The system log shows only: "Connected — waiting for room info…" then "You rejoined as Jolly Raven"
- "You joined as [random name]" does NOT appear
- Your name in the header is correct immediately after reconnect
- Opening a fresh tab (no sessionStorage) shows "You joined as [name]" as normal

- [ ] **Step 6: Run tests**

```bash
node --test test/**/*.test.js
```
Expected: 17 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add public/app.js
git commit -m "fix: suppress temp-name announcement when claim is in flight on reconnect"
```

---

### Task 2: Update "How TrainChat works" copy

**Files:**
- Modify: `public/index.html`

**What's currently wrong:**
- "Nothing is stored" — false since message history PR; last 300 messages are stored in sessionStorage
- "Closing this tab ends your session permanently" — misleading; sessionStorage is also cleared on tab close, but "session" in the server sense ends on disconnect regardless
- '"Same network" means same public IP' — partially wrong; IPv6 users are grouped by /64 prefix (first 4 groups), not full address, so devices sharing a WiFi access point land in the same room despite different interface identifiers
- No mention of the random name or that it persists across refresh within the tab
- No mention that the server does not log IPs or names

**Target bullets (replace the 5 existing `<li>` items, keep the `<a>` `<li>` last):**

```html
      <li>Your messages reach everyone on the same WiFi — grouped by network prefix, not device</li>
      <li>You get a random name; it stays the same if you refresh within this tab</li>
      <li>The last 300 messages are kept in this tab only — closing the tab clears them</li>
      <li>The server assigns rooms by IP but logs nothing — no IPs, names, or messages are stored server-side</li>
      <li>Anyone on this network can read and send messages, including automated scripts</li>
```

- [ ] **Step 1: Replace the five `<li>` items**

In `public/index.html`, replace:
```html
      <li>Your messages reach everyone on the same WiFi network</li>
      <li>"Same network" means same public IP — includes hotel/carrier NAT</li>
      <li>Nothing is stored — messages exist only in connected browser tabs</li>
      <li>Anyone on this network can connect, including via scripts</li>
      <li>Closing this tab ends your session permanently</li>
```
with:
```html
      <li>Your messages reach everyone on the same WiFi — grouped by network prefix, not device</li>
      <li>You get a random name; it stays the same if you refresh within this tab</li>
      <li>The last 300 messages are kept in this tab only — closing the tab clears them</li>
      <li>The server assigns rooms by IP but logs nothing — no IPs, names, or messages are stored server-side</li>
      <li>Anyone on this network can read and send messages, including automated scripts</li>
```

The `<a>` `<li>` (View source on GitHub) must remain untouched as the last item.

- [ ] **Step 2: Verify HTML is well-formed**

Read the modified `index.html` and confirm:
- All 6 `<li>` items are present (5 new + 1 existing `<a>`)
- No stray tags or unclosed elements introduced
- The `<a>` tag attributes (`href`, `target`, `rel`) are unchanged

- [ ] **Step 3: Run tests**

```bash
node --test test/**/*.test.js
```
Expected: 17 pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "docs: update How TrainChat works to reflect sessionStorage, IPv6 grouping, and no server logging"
```
