# Message History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the last 300 chat messages in `sessionStorage` so they survive page refreshes and reconnects within the same browser tab.

**Architecture:** On every incoming `msg` event, push `{ from, text, ts }` to a `sessionStorage` array (key `trainchat-messages`), slicing to the last 300 entries. On reconnect, replay the stored messages into the DOM after the `joined` confirmation lands (when `myName` is known), preceded by a `"--- earlier messages ---"` separator.

**Tech Stack:** Vanilla browser JS, `sessionStorage` — no new dependencies, no server changes.

**Spec:** This file (no separate spec — bounded single-file change).

## Global Constraints

- All DOM insertion must use `textContent`, never `innerHTML`
- CSP `style-src 'self'` — no inline styles; use CSS classes only
- `sessionStorage` key: `trainchat-messages`, value: JSON array of `{ from: string, text: string, ts: number }`
- Hard cap: 300 messages (slice to last 300 on every write)
- Only `msg`-type events are stored — system events (`joined`, `left`, `renamed`) are not
- Replay must happen **after** `myName` is confirmed (inside the `joined` handler), not on `open`
- Replay in **both** `joined` branches: initial join (branch 1, `!myName`) and claim-succeeded (branch 2, `myName && msg.token`)
- No server changes — client only
- Existing tests must remain passing

---

### Task 1: Add message history persistence and replay to the client

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- No new interfaces — self-contained within `app.js`

- [ ] **Step 1: Add `storeMessage` helper**

At the top of `public/app.js`, after the `let myName = null;` line, add:

```js
const HISTORY_KEY = 'trainchat-messages';
const HISTORY_MAX = 300;

function storeMessage(from, text, ts) {
  let history;
  try {
    history = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? '[]');
    if (!Array.isArray(history)) history = [];
  } catch { history = []; }
  history.push({ from, text, ts });
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
  try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* storage full — skip */ }
}
```

- [ ] **Step 2: Add `replayHistory` helper**

Immediately after `storeMessage`, add:

```js
function replayHistory() {
  let history;
  try {
    history = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? '[]');
    if (!Array.isArray(history) || history.length === 0) return;
  } catch { return; }

  const sep = document.createElement('div');
  sep.className = 'system-msg';
  sep.textContent = '— earlier messages —';
  messagesEl.appendChild(sep);

  for (const entry of history) {
    if (typeof entry.from === 'string' && typeof entry.text === 'string') {
      addMessage(entry.from, entry.text, entry.from === myName);
    }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
```

- [ ] **Step 3: Call `replayHistory()` in the initial-join branch**

In the `joined` handler, branch 1 (`!myName`), add `replayHistory()` after `setEnabled(true)`:

Change:
```js
  if (msg.type === 'joined' && !myName) {
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
```

To:
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

- [ ] **Step 4: Call `replayHistory()` in the claim-succeeded branch**

In branch 2 (`myName && msg.token`), add `replayHistory()` after `updateRoomSize`:

Change:
```js
  if (msg.type === 'joined' && myName && msg.token) {
    myName = msg.name;
    myNameEl.textContent = msg.name;
    updateRoomSize(msg.roomSize);
    addSystem(`You rejoined as ${msg.name}`);
    sessionStorage.setItem('trainchat-name', JSON.stringify({ name: msg.name, token: msg.token }));
    return;
  }
```

To:
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

- [ ] **Step 5: Call `storeMessage` on every incoming `msg` event**

In the `msg` handler branch, change:
```js
  if (msg.type === 'msg') {
    addMessage(msg.from, msg.text, msg.from === myName);
  }
```

To:
```js
  if (msg.type === 'msg') {
    storeMessage(msg.from, msg.text, msg.ts);
    addMessage(msg.from, msg.text, msg.from === myName);
  }
```

- [ ] **Step 6: Add CSS class for the separator**

Open `public/style.css`. Find the `.system-msg` rule and verify the separator will render acceptably using the same class. If `.system-msg` already exists, no change needed — the separator reuses it. If it does not exist, add:

```css
.system-msg {
  text-align: center;
  color: #888;
  font-size: 0.8em;
  padding: 4px 0;
}
```

- [ ] **Step 7: Manual smoke test**

Start the server:
```bash
node src/server.js
```

Open `http://localhost:3000` in a browser tab. Send 3–5 messages. Refresh the page. Verify:
- The `"— earlier messages —"` separator appears
- Your previous messages appear above it with correct "mine" styling
- A "You joined as [name]" or "You rejoined as [name]" system message appears below the separator
- New messages continue to appear below

Open a second tab, send messages from both tabs, refresh tab 1. Verify only tab 1's history appears (sessionStorage is per-tab).

- [ ] **Step 8: Run existing tests**

```bash
node --test test/**/*.test.js
```

Expected: 17 pass, 0 fail. (No test changes needed — this is pure client-side DOM/storage code with no server interaction.)

- [ ] **Step 9: Commit**

```bash
git add public/app.js public/style.css
git commit -m "feat: persist last 300 messages in sessionStorage for refresh survival"
```
