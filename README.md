# Hive Mind

A party game for 2–12 players. Everyone gets the same prompt and 30 seconds to answer. Your answer scores one point for every player who said the same thing, including you. Unique answers score zero. After 8 rounds, the most in-sync player wins.

Players join from any phone or laptop with a four-letter room code. No accounts or installs.

## Play online (Vercel)

The live version runs as Vercel Functions with room state in Upstash Redis.

1. Import this repository into Vercel, or run `vercel` in this folder.
2. Add **Upstash for Redis** from the Vercel Marketplace and connect it to the project. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. Deploy with `vercel --prod`.

Players' screens check the room about once a second. Rooms expire after 6 hours of inactivity.

## Run it on your own computer

```
node server.js
```

Then open `http://127.0.0.1:4173`. Open a second browser window, such as a private window, to join as another player.

## How it stays fair

- Answers stay on the server until the reveal. No player's device receives another player's answer early.
- Each browser keeps a secret player key. Other players only see random public IDs, so nobody can act as the host or as another player.
- Requests are validated, rate limited and served with strict security headers.

## Files

- `index.html` – the game screens
- `api/` and `lib/` – the online game server for Vercel
- `server.js` – a single-file server for playing locally
