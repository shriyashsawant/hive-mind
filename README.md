# Hive Mind — private review preview

Hive Mind is a mobile-first, room-based word-matching game. This review build includes a small local server so separate browser tabs can share a room, roster, round clock, and scores. Answers stay on the server and are omitted from every player's room view until the reveal.

## Open the preview

1. Install Node.js 20 or newer if it is not already installed.
2. From this folder, run `node server.js`.
3. Open `http://127.0.0.1:4173` in a browser.
4. Create a room in one tab. Open a second tab at the same address to join with the four-letter code.

No packages, accounts, installs, or external services are used by the game itself.

## Preview limits

The server binds to `127.0.0.1`, so this preview is private to the computer running it. Other people on the internet or other devices cannot join this build. The room database lives in the operating system's temporary-data folder at `hive-mind-private-preview/rooms.json`; it survives a server restart on this computer, but it is not cloud storage. For that reason, this is a real multi-tab local preview and not a remote multiplayer launch.

## Included

- 2–12 players, four-letter room codes, case-insensitive unique nicknames
- 56 shuffled prompts, with eight distinct prompts per game
- Server-owned 30-second deadlines, early reveal when every player locks in, and live roster updates
- Private pre-reveal answers, answer editing, answer normalization, grouped reveals, per-round gains, final scores, shared wins, late joining, reload recovery, and host-disconnect notice
- Host-controlled next-round and replay actions

All room data stays on the local preview server. Stop it with `Ctrl+C`.
