# Deploying Babylon FPS (Vercel + co-op relay)

Vercel hosts the game (static files, global CDN). Vercel **cannot** run the
co-op WebSocket relay (no long-lived connections), so the relay runs on a free
WebSocket-friendly host. This guide uses Render; Railway and Fly.io work the
same way (`node server/relay.mjs`, `PORT` env).

```
 friends' browsers ──https──▶ Vercel  (game: HTML, JS, ~9 MB of models)
        │
        └──────wss──────────▶ Render  (relay: server/relay.mjs at /ws)
```

## 0. Make sure the optimized assets exist and are committed

The game loads only the optimized copies (`*.opt.glb`, `grass2.opt.jpg`, …).
The heavy originals (≈330 MB) stay on your machine; `.gitignore` and
`.vercelignore` already keep them out.

```bash
npm run optimize-assets      # (re)creates *.opt.* files next to the originals
npm run build-house-kit      # only if you changed public/models/house/source
git add -A
git commit -m "Deployable build"
git push                     # to GitHub / GitLab / Bitbucket
```

`git add -A` stages about 8 MB under `public/`. If you see a 100+ MB file
staged, the ignore rules aren't being picked up; don't push it.

## 1. Deploy the relay (Render, free)

1. Sign in at https://render.com → **New → Blueprint** → pick your repo.
   Render reads `render.yaml` (service `babylon-fps-relay`, root `server/`).
2. Leave `ALLOWED_ORIGINS` empty for now → **Apply**.
3. When it's live, note its URL, e.g. `https://babylon-fps-relay.onrender.com`.
   Opening it in a browser should show `Babylon FPS co-op relay`.
4. Your relay address for the game is that URL with `wss://` and `/ws`:
   `wss://babylon-fps-relay.onrender.com/ws`

## 2. Deploy the game (Vercel)

**Dashboard:** https://vercel.com/new → import the repo. Vercel detects Vite
(`vercel.json` pins build `npm run build`, output `dist`). Before deploying,
open **Environment Variables** and add:

| Name | Value |
|---|---|
| `RELAY_URL` | `wss://babylon-fps-relay.onrender.com/ws` |

→ **Deploy**. You get e.g. `https://babylon-fps.vercel.app`.

**CLI instead:**

```bash
npm i -g vercel
vercel                                   # link / create the project (preview)
vercel env add RELAY_URL production      # paste the wss://…/ws address
vercel --prod
```

`RELAY_URL` (or `VITE_RELAY_URL`) is baked in at build time: after changing it, redeploy.

## 3. Lock the relay to your site

On Render → the relay service → **Environment** → set
`ALLOWED_ORIGINS` = `https://babylon-fps.vercel.app` (comma-separate several,
e.g. a custom domain too) → save (it restarts). Other websites now get 403.

## 4. Play

Send friends: `https://babylon-fps.vercel.app/?room=friday`. Everyone types a
name and clicks **Join co-op**; the same room = the same horde. The first
player in a room hosts the monsters.

## Notes

- **Cold starts:** Render's free tier sleeps after ~15 min idle. The first
  player to join may wait up to a minute (the lobby says so); after that it's
  instant. Paid tiers / Railway / Fly.io don't sleep.
- **Caching:** `vercel.json` makes the hashed JS/CSS immutable and caches
  models/textures for a day (served stale while revalidating for 30 days).
  If you replace a model with the same file name, players may see the old one
  for up to a day; rename it to force an update.
- **Asset licences:** Kenney kits are CC0, the MD2 monsters ship with three.js
  examples. The Sketchfab models (dragon, autorickshaw, trees, WRL house) have
  their own licences, usually requiring attribution. Check them before
  making the site public.
- **Local co-op** still works without any of this: `npm run coop`.
