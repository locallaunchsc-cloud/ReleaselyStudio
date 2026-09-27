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

The whole app is one file: `index.html`. It loads three small libraries from public CDNs:

- `webm-muxer` and `mp4-muxer` (jsDelivr): package the encoded video and audio into a file
- `JSZip` (cdnjs): bundles the teaser clips into one download

## Setting up donations

Open `index.html`, search for `DONATE_CONFIG`, and paste links or wallet addresses between the empty quotes. Anything left empty stays hidden, and the whole section is hidden until at least one option is filled in.

## Deploying

Hosted on Cloudflare Pages, connected to this repo. Every push to `main` redeploys the site automatically.

Build settings: no framework, no build command, output directory is the repo root.

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
