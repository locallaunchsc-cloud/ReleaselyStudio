# Releasely Studio

Turn an album's MP3s into one full-length YouTube video, with smooth fades, matched volume, chapter timestamps, and vertical teaser clips for TikTok, Reels and Shorts.

Everything runs in the visitor's browser. Songs are never uploaded to a server, and hosting costs stay near zero no matter how many people use it.

## Features

- **Album video:** drop in 15–20 MP3s, reorder them, rename songs, and export one 1080p video showing the cover art, album title and tracklist, with the current song highlighted.
- **Fades:** 0–3 second crossfade (songs overlap) or fade out / fade in between tracks, with a "Hear it" preview for each transition.
- **Match volume:** measures every song in LUFS (the loudness scale YouTube uses) and brings each one to -14 LUFS, with a peak limiter so boosted songs never clip.
- **YouTube timestamps:** chapter list ready to paste into the video description, adjusted for the fades.
- **Smart analysis:** detects each song's BPM and key.
- **Hook finder:** picks each song's catchiest section. Users can nudge it and preview it.
- **Teaser clips:** 15 or 30 second vertical (1080×1920) clips of each hook with an editable caption, downloaded together as a zip.
- **Donations:** optional support section for Cash App, PayPal, Buy Me a Coffee, card payments and crypto wallets.
- **Formats:** MP4 (H.264 + AAC) where the browser supports it, otherwise WebM (VP9 + Opus). YouTube accepts both.

## Browser support

Needs a desktop browser with WebCodecs: Chrome or Edge recommended. Phones and Safari can't build the video yet.

## Project structure

```
public/            the website (served as static files)
  index.html       the whole app
  favicon.svg/.ico, apple-touch-icon.png, og.png, robots.txt
src/worker.js      tiny API for the usage counter (/api/count, /api/stats)
wrangler.jsonc     Cloudflare config: Worker name, site folder, D1 database
```

The app loads three small libraries from public CDNs: `webm-muxer` and `mp4-muxer` (jsDelivr) to package video files, and `JSZip` (cdnjs) to bundle teaser clips.

## Usage counter

When someone finishes an album video or a teaser pack, the page sends a single "+1" to `/api/count`. No songs, names or personal info are sent. Totals live in a Cloudflare D1 database called `releasely` and can be checked at `/api/stats`. The site shows the totals under the headline once they pass 10.

## Analytics

Cloudflare Web Analytics: paste the site token into `CF_ANALYTICS_TOKEN` in `public/index.html`.

## Setting up donations

Open `public/index.html`, search for `DONATE_CONFIG`, and paste links or wallet addresses between the empty quotes. Anything left empty stays hidden, and the whole section is hidden until at least one option is filled in.

## Deploying

Hosted as a Cloudflare Worker (static assets + a small API), connected to this repo. Every push to `main` redeploys automatically.

Build settings: no build command; deploy command `npx wrangler deploy`.

## Updating the site

From PowerShell, in the project folder:

```
git add .
git commit -m "describe the change"
git push
```

Cloudflare picks up the push and the live site updates in about a minute.

## Roadmap

- Producer mode: batch single-beat videos with BPM and key in the titles
- Animated, audio-reactive visuals
- Full YouTube description generator (credits, links, hashtags)
- Saved projects
- Multiple languages
- Releasely Pro: accounts, payments, cloud AI features, direct YouTube upload

## License

All rights reserved. © Releasely Studio
