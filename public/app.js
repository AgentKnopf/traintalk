// All DOM insertion uses textContent — never innerHTML
import { buildHistoryAttribution } from './history.js';

const messagesEl = document.getElementById('messages');
const myNameEl   = document.getElementById('my-name');
const roomSizeEl = document.getElementById('room-size');
const input      = document.getElementById('msg-input');
const sendBtn    = document.getElementById('send-btn');

let myName = null;
let pendingClaim = false;

const HISTORY_KEY = 'traintalk-messages';
const HISTORY_MAX = 300;

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


const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}`);

ws.addEventListener('open', () => {
  addSystem('Connected — waiting for room info…');
  try {
    const saved = JSON.parse(sessionStorage.getItem('traintalk-name') ?? 'null');
    if (saved?.name && saved?.token) {
      pendingClaim = true;
      ws.send(JSON.stringify({ type: 'claim', name: saved.name, token: saved.token }));
    }
  } catch { /* corrupt sessionStorage — ignore */ }
});

ws.addEventListener('close', () => {
  setEnabled(false);
  addSystem('Disconnected. Refresh to reconnect.');
});

ws.addEventListener('error', () => {
  addSystem('Connection error.');
});

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  if (msg.type === 'joined' && !myName) {
    // Own join confirmation (initial or after claim)
    myName = msg.name;
    myNameEl.textContent = msg.name;
    updateRoomSize(msg.roomSize);
    setEnabled(true);
    replayHistory();
    if (!pendingClaim) {
      addSystem(`You joined as ${msg.name}`);
      if (msg.token) {
        sessionStorage.setItem('traintalk-name', JSON.stringify({ name: msg.name, token: msg.token }));
      }
    }
    return;
  }

  if (msg.type === 'joined' && myName && msg.token) {
    // Claim succeeded — server confirmed our name with a fresh token
    pendingClaim = false;
    myName = msg.name;
    myNameEl.textContent = msg.name;
    updateRoomSize(msg.roomSize);
    reattributeHistory(msg.name);
    addSystem(`You rejoined as ${msg.name}`);
    sessionStorage.setItem('traintalk-name', JSON.stringify({ name: msg.name, token: msg.token }));
    return;
  }

  if (msg.type === 'joined') {
    // Peer joined the room
    updateRoomSize(msg.roomSize);
    addSystem(`${msg.name} joined`);
    return;
  }

  if (msg.type === 'left') {
    updateRoomSize(msg.roomSize);
    addSystem(`${msg.name} left`);
    return;
  }

  if (msg.type === 'renamed') {
    addSystem(`${msg.from} is now ${msg.to}`);
    return;
  }

  if (msg.type === 'msg') {
    const isMe = msg.from === myName;
    storeMessage(msg.from, msg.text, msg.ts, isMe);
    addMessage(msg.from, msg.text, isMe);
  }
});

function addMessage(from, text, isMe) {
  const div = document.createElement('div');
  div.className = isMe ? 'msg mine' : 'msg';

  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.textContent = from; // textContent — safe

  const body = document.createElement('div');
  body.className = 'text';
  body.textContent = text; // textContent — safe

  div.appendChild(sender);
  div.appendChild(body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.textContent = text; // textContent — safe
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateRoomSize(n) {
  roomSizeEl.textContent = n === 1 ? 'Just you here' : `${n} people here`;
}

function setEnabled(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
  if (enabled) input.focus();
}

function sendMessage() {
  const text = input.value.trim();
  if (!text || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'msg', text }));
  input.value = '';
}

sendBtn.addEventListener('click', sendMessage);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// --- Theme ---------------------------------------------------------------
// The initial theme is resolved by the inline script in <head> so the first
// paint is already correct. This only handles switching afterwards.

const THEME_KEY = 'traintalk-theme';
const themeBtn  = document.getElementById('theme-btn');
const iconMoon  = document.getElementById('icon-moon');
const iconSun   = document.getElementById('icon-sun');
const lightQuery = matchMedia('(prefers-color-scheme: light)');

function storedTheme() {
  let t;
  try { t = sessionStorage.getItem(THEME_KEY); } catch { return null; }
  return t === 'light' || t === 'dark' ? t : null;
}

// `hidden` is an HTMLElement IDL property — assigning el.hidden on an SVG
// element sets a meaningless JS expando and never touches the DOM. SVG icons
// have to be toggled via the attribute itself.
function setHidden(el, hide) {
  if (hide) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = theme;
  // Show the icon for the mode the button switches *to*: a sun while we're
  // dark (tap for light), a moon while we're light (tap for dark).
  setHidden(iconSun, !dark);
  setHidden(iconMoon, dark);
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}

applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { sessionStorage.setItem(THEME_KEY, next); } catch { /* storage blocked — theme still applies for this page */ }
});

// Follow the OS only while the user hasn't made an explicit choice.
lightQuery.addEventListener('change', (e) => {
  if (!storedTheme()) applyTheme(e.matches ? 'light' : 'dark');
});

// --- Info dialog ---------------------------------------------------------

const infoDialog = document.getElementById('info-dialog');
document.getElementById('info-btn').addEventListener('click', () => infoDialog.showModal());
document.getElementById('info-close').addEventListener('click', () => infoDialog.close());

// Click outside the sheet closes it. The dialog element itself fills the
// backdrop area, so a click landing on it (not on #info-body) is an outside click.
infoDialog.addEventListener('click', (e) => {
  if (e.target === infoDialog) infoDialog.close();
});
