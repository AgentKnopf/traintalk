# Fix: History Replay Duplication and Misattribution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs triggered on reconnect-with-claim: (1) history renders twice, each with its own separator; (2) the first copy misattributes the user's own messages as incoming.

**Bug report:** `docs/BUG-history-replay.md`

**Root cause:** On reconnect, branch 1 (`!myName`) fires first with the temp random name and calls `replayHistory()`. Then branch 2 (claim succeeded) fires and calls `replayHistory()` again with the correct name — giving double separators and double history. The first copy uses the wrong `myName` for the `isMe` comparison.

**Fix approach (option 3 from the bug report):** Replay once in branch 1 as today (keeping the claim-failure path working). When the claim succeeds in branch 2, instead of re-replaying, **re-attribute the already-rendered history** — find every `.msg` bubble whose sender matches the final claimed name and add the `.mine` class (and remove `.mine` from any that now don't match, for correctness). This fixes both bugs without needing a server change or a timeout.

**Also:** Store an `isMe` flag at write time in `storeMessage()` so future replays don't depend on `myName` being correct at read time. This fixes bug 2 at the source and makes the system more robust against any future rename flow.

**Tech Stack:** Vanilla browser JS only. No server changes, no new dependencies.

**Spec:** `docs/BUG-history-replay.md` (this plan implements its option 3 suggestion).

## Global Constraints

- All DOM insertion uses `textContent`, never `innerHTML`
- No inline styles — CSS classes only (CSP `style-src 'self'`)
- No server changes — `public/app.js` only
- Existing 17 server tests must remain passing
- The claim-failure path must continue to work: if the server rejects the claim silently, history is still shown (from the branch 1 replay), just under the fallback random name
- `replayHistory()` must be called exactly once per page load — never twice

---

### Task 1: Store `isMe` at write time and fix the double-replay

**Files:**
- Modify: `public/app.js`

**The two changes in this task are tightly coupled — they must land together in one commit.**

#### Change A: Store `isMe` in `storeMessage`

`storeMessage` currently stores `{ from, text, ts }`. Extend it to also store `isMe: boolean`, set at write time when `myName` is definitely correct (the message just arrived from the live server). This decouples replay attribution from whatever `myName` happens to be at replay time.

**Step 1: Update `storeMessage` signature and storage shape**

Change `storeMessage(from, text, ts)` to `storeMessage(from, text, ts, isMe)` and include `isMe` in the stored object:

Replace:
```js
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
with:
```js
function storeMessage(from, text, ts, isMe) {
  let history;
  try {
    history = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? '[]');
    if (!Array.isArray(history)) history = [];
  } catch { history = []; }
  history.push({ from, text, ts, isMe: !!isMe });
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
  try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* storage full — skip */ }
}
```

**Step 2: Update the `storeMessage` call site to pass `isMe`**

In the `msg` handler, change:
```js
  if (msg.type === 'msg') {
    storeMessage(msg.from, msg.text, msg.ts);
    addMessage(msg.from, msg.text, msg.from === myName);
  }
```
to:
```js
  if (msg.type === 'msg') {
    const isMe = msg.from === myName;
    storeMessage(msg.from, msg.text, msg.ts, isMe);
    addMessage(msg.from, msg.text, isMe);
  }
```

**Step 3: Update `replayHistory` to use stored `isMe`**

Change the replay loop from:
```js
  for (const entry of history) {
    if (typeof entry.from === 'string' && typeof entry.text === 'string') {
      addMessage(entry.from, entry.text, entry.from === myName);
    }
  }
```
to:
```js
  for (const entry of history) {
    if (typeof entry.from === 'string' && typeof entry.text === 'string') {
      addMessage(entry.from, entry.text, !!entry.isMe);
    }
  }
```

Note: old entries in sessionStorage won't have `isMe` — `!!undefined` is `false`, so they'll render as incoming. This is acceptable for existing history; new entries will be correct.

#### Change B: Fix the double-replay — re-attribute instead of re-replay

**Step 4: Remove `replayHistory()` from branch 2**

In branch 2 (claim succeeded, `public/app.js` lines 88–98), replace the `replayHistory()` call with a `reattributeHistory(msg.name)` call that re-styles already-rendered bubbles:

Change:
```js
  if (msg.type === 'joined' && myName && msg.token) {
    // Claim succeeded — server confirmed our name with a fresh token
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
to:
```js
  if (msg.type === 'joined' && myName && msg.token) {
    // Claim succeeded — server confirmed our name with a fresh token
    pendingClaim = false;
    myName = msg.name;
    myNameEl.textContent = msg.name;
    updateRoomSize(msg.roomSize);
    reattributeHistory(msg.name);
    addSystem(`You rejoined as ${msg.name}`);
    sessionStorage.setItem('trainchat-name', JSON.stringify({ name: msg.name, token: msg.token }));
    return;
  }
```

**Step 5: Add `reattributeHistory` function**

Add this function immediately after `replayHistory`:

```js
function reattributeHistory(confirmedName) {
  const bubbles = messagesEl.querySelectorAll('.msg');
  for (const bubble of bubbles) {
    const senderEl = bubble.querySelector('.sender');
    if (!senderEl) continue;
    if (senderEl.textContent === confirmedName) {
      bubble.classList.add('mine');
    } else {
      bubble.classList.remove('mine');
    }
  }
}
```

This walks every `.msg` div already in the DOM and corrects the `.mine` class based on the final confirmed name. It is idempotent and safe to call even if no history was replayed (no `.msg` elements → no iterations).

- [ ] **Step 6: Manual smoke test**

Start the server:
```bash
node src/server.js
```

Open `http://localhost:3000` in two tabs. Send several messages from both sides. Refresh one tab. Verify:
- Only ONE `— earlier messages —` separator appears
- Your own past messages render on the right (`.mine` styling) with correct colour
- Messages from the other participant render on the left (incoming styling)
- "You rejoined as [name]" appears once, after the history block
- A fresh tab (no sessionStorage) still shows "You joined as [name]" correctly

- [ ] **Step 7: Run tests**

```bash
node --test test/**/*.test.js
```
Expected: 17 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add public/app.js
git commit -m "fix: replay history once and re-attribute on claim success instead of double-replay"
```

---

### Task 2: Extract replay decision into a pure function for unit-testability

The bug report (`docs/BUG-history-replay.md` line 118–119) notes there is no way to unit-test the replay logic without a DOM. Extract the attribution decision into a pure function so it can be tested with `node --test` without jsdom.

**Files:**
- Modify: `public/app.js`
- Modify: `test/server.test.js` — add pure-function tests for the new helper

**Interfaces:**
- Produces: `buildHistoryAttribution(history, confirmedName)` — pure function, no DOM access
  - `history`: array of `{ from: string, text: string, ts: number, isMe?: boolean }`
  - `confirmedName`: string (the name to treat as "mine") or `null`
  - Returns: array of `{ from: string, text: string, isMe: boolean }` — ready to pass to `addMessage`

- [ ] **Step 1: Add `buildHistoryAttribution` pure function**

In `public/app.js`, add this function immediately before `replayHistory`:

```js
export function buildHistoryAttribution(history, confirmedName) {
  return history
    .filter(e => typeof e.from === 'string' && typeof e.text === 'string')
    .map(e => ({
      from: e.from,
      text: e.text,
      isMe: confirmedName !== null ? e.from === confirmedName : !!e.isMe,
    }));
}
```

Logic: if `confirmedName` is provided (claim succeeded — we know the final name), derive `isMe` from name comparison. If `confirmedName` is null (claim failed or first join — `myName` is already the correct name at replay time), fall back to the stored `isMe` flag.

- [ ] **Step 2: Update `replayHistory` to use `buildHistoryAttribution`**

Change `replayHistory()` to delegate the attribution decision:

Replace:
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
      addMessage(entry.from, entry.text, !!entry.isMe);
    }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
```
with:
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

  for (const entry of buildHistoryAttribution(history, null)) {
    addMessage(entry.from, entry.text, entry.isMe);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
```

Note: `replayHistory` passes `null` as `confirmedName` — at call time, `myName` is already set to the correct name (branch 1 sets it before calling replay), so the stored `isMe` is used directly.

- [ ] **Step 3: Write tests for `buildHistoryAttribution`**

`buildHistoryAttribution` is exported from `public/app.js`. Add tests to `test/server.test.js` (the existing test file) — or create `test/client.test.js` if you prefer to keep them separate.

Add these tests:

```js
import { buildHistoryAttribution } from '../public/app.js';

test('buildHistoryAttribution: uses stored isMe when confirmedName is null', () => {
  const history = [
    { from: 'Jolly Raven', text: 'hi', ts: 1, isMe: true },
    { from: 'Calm Fox', text: 'hey', ts: 2, isMe: false },
  ];
  const result = buildHistoryAttribution(history, null);
  assert.equal(result[0].isMe, true);
  assert.equal(result[1].isMe, false);
});

test('buildHistoryAttribution: derives isMe from confirmedName when provided', () => {
  const history = [
    { from: 'Jolly Raven', text: 'hi', ts: 1, isMe: false }, // wrong stored value
    { from: 'Calm Fox', text: 'hey', ts: 2, isMe: true },    // wrong stored value
  ];
  const result = buildHistoryAttribution(history, 'Jolly Raven');
  assert.equal(result[0].isMe, true);  // name matches — correctly mine
  assert.equal(result[1].isMe, false); // name doesn't match — correctly not mine
});

test('buildHistoryAttribution: filters out entries missing from or text', () => {
  const history = [
    { from: 'Jolly Raven', text: 'valid', ts: 1, isMe: true },
    { from: null, text: 'missing from', ts: 2, isMe: false },
    { from: 'Calm Fox', text: null, ts: 3, isMe: false },
    { text: 'no from key', ts: 4 },
  ];
  const result = buildHistoryAttribution(history, null);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'valid');
});

test('buildHistoryAttribution: returns empty array for empty history', () => {
  const result = buildHistoryAttribution([], null);
  assert.deepEqual(result, []);
});

test('buildHistoryAttribution: old entries without isMe field default to false when confirmedName is null', () => {
  const history = [{ from: 'Jolly Raven', text: 'old entry', ts: 1 }];
  const result = buildHistoryAttribution(history, null);
  assert.equal(result[0].isMe, false);
});
```

- [ ] **Step 4: Run tests — expect new tests to PASS**

```bash
node --test test/**/*.test.js
```
Expected: 22 pass (17 existing + 5 new), 0 fail.

Note: `buildHistoryAttribution` uses `export` so it can be imported by the test. Since `public/app.js` runs in a browser context (references `document`, `sessionStorage`, etc.), the import will fail at module evaluation time unless the DOM references are inside functions. They already are — the top-level `document.getElementById` calls execute immediately. To work around this, the test file should mock the global DOM elements before importing, OR the tests can be placed in a separate file that imports only the pure function.

If the import fails due to `document is not defined`, restructure as follows: move `buildHistoryAttribution` into a new file `public/history.js` with no DOM dependencies, import it from both `public/app.js` and the test file. This is the cleaner path and worth doing if the direct import fails.

- [ ] **Step 5: Commit**

```bash
git add public/app.js test/server.test.js   # or test/client.test.js + public/history.js
git commit -m "refactor: extract buildHistoryAttribution as pure testable function"
```
