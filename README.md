# TrainTalk

Zero-install ephemeral chat for people on the same WiFi network. Open the URL, get a random identity, start chatting. No accounts, no history, no data stored.

## How it works

- Open `traintalk.app` in any browser — no install, no account
- You're automatically in a room with everyone on the same network
- Messages exist only in connected browser tabs — close the tab and they're gone
- Your identity is a random name like "Crimson Penguin" — assigned fresh each session

## Privacy & Security

- **Nothing is stored** — the server relays messages in memory only, never to disk
- **No tracking** — no cookies, no analytics, no third-party scripts
- **Open source** — this entire server is here to read and audit
- **Public by design** — anyone on your network can connect, including via scripts. Don't share anything you wouldn't say out loud on a train.
- **CGNAT note** — "same network" means same public IP. On mobile carriers or hotel WiFi, this may include people beyond your immediate physical location.

## Self-hosting

```bash
git clone https://github.com/agent-knopf/traintalk
cd traintalk
npm install
npm start
```

Requires Node.js LTS. For production, set up TLS (Let's Encrypt) — `wss://` is required for browser WebSocket.

## Development

```bash
git clone https://github.com/AgentKnopf/traintalk
cd traintalk
npm install
npm run dev      # starts server with --watch (auto-restarts on changes)
```

Open http://localhost:3000 in two tabs to test locally.

## Running Tests

```bash
npm test
```

## Architecture

Single Node.js file. No database. No framework.

- WebSocket relay (in-memory, never persisted)
- Room assignment by TCP-layer IP (`socket.remoteAddress`)
- Server-assigned anonymous identities bound to connection
- All message envelopes reconstructed server-side via `JSON.stringify`

See [docs/design-spec.md](docs/design-spec.md) for the full security design.

## License

MIT
