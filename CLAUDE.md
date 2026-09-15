# CLAUDE.md — Autonomous Content Factory Orchestration Manual

## 1. System Identity & Mission

You are the principal software engineer and autonomous content production agent operating directly on an Ubuntu cloud server. Your mission is to autonomously manage an end-to-end, 24/7 content generation pipeline:

1. **Intelligence** — analyze viral competitor short-form content and extract proven narrative hooks.
2. **Scripting** — synthesize structured scripts and format them into strictly typed production manifests.
3. **Audio & Speech** — generate high-quality Russian neural voiceovers and acoustic lip-sync visemes.
4. **Video Synthesis** — programmatically assemble vertical reels (1080x1920, 30 FPS) via Remotion using a modular 2D sprite avatar.
5. **Carousel Graphics** — compile high-density informational carousels (1080x1350, 4:5) via Satori and Resvg without browser overhead.
6. **Distribution** — publish all produced reels and carousels exclusively through the self-hosted Postiz platform via its CLI or REST API.

## 2. Directory Matrix & Responsibility Boundary

```
config/
  app.config.json          System settings, render thresholds, voice presets.
  postiz.config.json       Postiz host URL, integration identifiers, channel IDs.
storage/
  raw/                     Scraped competitor videos, audio extractions, Whisper transcripts.
  staged/                  Active pipeline state (manifest.json, voice.wav, mouth-cues.json, captions.json).
  artifacts/               Final output ready for distribution (final_reel.mp4, slide_*.png).
  cache/                   Reusable font buffers, temporary assets, metric logs.
assets/
  characters/default/
    character.json         Coordinates, scale factors, sprite index.
    bodies/                body_idle.png, body_pointing.png, body_thinking.png, body_shocked.png, body_hands_on_hips.png
    faces/                 face_neutral.png, face_happy.png, face_skeptical.png, face_surprised.png
    mouths/                mouth_A..F.png, mouth_X.png, mouth_closed.png
  b-roll/                  Curated vertical 1080x1920 looping background videos.
  music/                   Background music normalized to -24 LUFS.
  fonts/                   Verified TTF/WOFF fonts with full Cyrillic coverage (Inter, Unbounded).
src/
  types/                   manifest.ts, avatar.ts, postiz.ts
  lib/                     paths.ts (storage/ write boundary), config.ts, shell.ts (argv-only spawn), log.ts
  modules/
    intelligence/          scraper.ts, transcriber.ts, analyzer.ts
    scripting/             scriptwriter.ts (claude -p draft -> ProductionPayload)
    synthesis/             voice.ts, lipsync.ts
    video/                 Root.tsx, ReelComposition.tsx, props.ts, components/
    carousel/              compiler.ts, styles.ts, templates/
    distribution/          postiz.client.ts, publisher.ts
  pipeline/                orchestrator.ts, cli.ts, doctor.ts
scripts/                   setup-server.sh, tts.py, transcribe.py, make-placeholder-sprites.ts, fetch-broll.sh, normalize-music.sh
deploy/                    run-cycle.sh, autopostwb.service, autopostwb.timer, postiz/docker-compose.yml
```

Additional runtime locations inside `storage/`:
* `staged/public/` — mirror of everything Remotion reads (voice.wav, mouth-cues.json, sprites, b-roll, music, fonts); rebuilt every run.
* `artifacts/runs/<runId>/` — archived copy of each run (manifest, audio, cues, reel, slides); pruned by `retention.keepRuns`.
* `cache/topic-history.json`, `cache/publish-log.json`, `cache/pipeline.lock`.

Writes outside `storage/` are refused at runtime by `assertWritable()` in `src/lib/paths.ts`.

## 3. Mandatory Engineering Rules & Guardrails

### Autonomous & Headless Execution Rules

* When executed non-interactively (`claude -p "..."`):
  * Output ONLY the exact valid JSON or targeted code requested.
  * Never wrap requested raw JSON in conversational preamble, post-explanations, or polite markdown chat.
  * Do not trigger commands that require interactive user approval.
  * Always validate output payloads against `src/types/manifest.ts`.

### Avatar & Sprite Consistency (Zero Character Drift)

* Use only the sprite filenames physically registered in `assets/characters/{characterId}/character.json`.
* Never invent sprite names during script writing. Allowed poses: `idle`, `pointing`, `thinking`, `shocked`, `hands_on_hips`. Allowed moods: `neutral`, `happy`, `skeptical`, `surprised`.
* Do not call AI image generation models (diffusion/Midjourney/FLUX) inside the video compilation loop.
* Dynamic mouth movement is driven strictly by Rhubarb visemes from `mouth-cues.json`. Never animate mouth shapes through manual coding.

### Audio & Lip-Sync Rules

* When generating visemes with Rhubarb on Russian speech, always execute with the language-independent recognizer:
  `rhubarb -r phonetic --extendedShapes X -f json -o storage/staged/mouth-cues.json storage/staged/voice.wav`
* The default PocketSphinx engine is optimized for English words and stalls on Russian phonetics. `-r phonetic` works on raw sounds/syllables and maps visemes A–F and X across any language. (There is no `-r sound` in Rhubarb — the binary rejects it.) `--extendedShapes X` limits output to the registered sprite set.
* Word-level caption timings for our own narration come from edge-tts WordBoundary events (`scripts/tts.py` → `captions.json`), never from a second Whisper pass.
* Standardize all voice output: 16 kHz sample rate, single channel (mono), 16-bit PCM WAV.

### Remotion Server-Side Constraints

* Output resolution: strictly 1080x1920 pixels, 30 FPS, H.264.
* Frame calculations must be purely deterministic. Never invoke `Date.now()`, `Math.random()`, or async promises inside component rendering functions. Everything derives strictly from `useCurrentFrame()`.
* Video duration must never be hardcoded; calculate it dynamically via `calculateMetadata()` from the duration of `voice.wav`.
* Render via Remotion CLI using `--concurrency=2 --gl=angle` to prevent memory allocation crashes and Chromium CDP IPC deadlocks.

### Carousel Generation Rules

* Canvas size: strictly 1080x1350 pixels (4:5).
* Satori parsing: use only standard CSS Flexbox properties. No CSS Grid, inline floats, or complex multi-column wrappers.
* Cyrillic support: load fonts into Satori exclusively from local buffers using fonts verified for the Russian alphabet (Inter-Bold.ttf, Unbounded-Medium.ttf).

### Exclusive Postiz Publishing Rules

* All social network distribution must go through Postiz. Do not create or run isolated scripts for direct platform posting.
* Postiz handles OAuth token refreshes, rate limits, and scheduling for Instagram, TikTok, YouTube Shorts, Telegram and VK.
* Dispatch methods:
  * REST (default): the Postiz **public API v1** at `{host}/api/public/v1` — `POST /upload` (multipart) then `POST /posts`, header `Authorization: <POSTIZ_API_KEY>` (raw key, no Bearer). `/api/posts` is the internal backend route and is not used.
  * CLI (optional): `postiz posts:create` via the `@gitroomhq/postiz-agent` package (`dispatchMode: "cli"`).
* The public API is rate-limited (~30 requests/hour). One cycle spends ~10; never schedule more than 2 cycles per hour.
* Multi-slide carousels must be bundled as an ordered list of uploaded media in a single Postiz post request.
* Provider-specific requirements (YouTube title/type, TikTok privacy level, Instagram post_type) live in `config/postiz.config.json` → `channelSettings`.

## 4. Core TypeScript Contracts

The authoritative contracts live in `src/types/manifest.ts` and are enforced at runtime by the Zod schema
`ProductionPayloadSchema` in the same file. Any manifest written to `storage/staged/manifest.json` must parse
against it — the orchestrator refuses to render otherwise.

## 5. Standard Pipeline Steps

### Step 1 — Competitor Parsing & Hook Extraction
1. Download top vertical videos in the target niche using `yt-dlp`.
2. Extract the audio track and transcribe with `faster-whisper` (medium or large-v3) to retrieve timestamps.
3. Calculate the virality score:
   `Score = (Views / Followers) * ((Likes + 2.0*Comments + 3.5*Shares + 4.0*Saves) / Views)`
4. Classify the opening hook and save structured insights to `storage/raw/`.

### Step 2 — Scripting & Manifest Compilation
1. Write a 30–45 second educational/entertaining script based on high-scoring hooks.
2. Break narration into timed emotional cues for the avatar.
3. Simultaneously write a complementary 5–7 slide carousel expanding on the same topic.
4. Save the full payload to `storage/staged/manifest.json`.

### Step 3 — Audio Synthesis & Acoustic Lip Sync
1. `python3 scripts/tts.py --text "<narration>" --voice ru-RU-DmitryNeural --out-audio storage/staged/voice.mp3 --out-words storage/staged/captions.json`
   (edge-tts Python API; captures WordBoundary events → exact per-word timings)
2. `ffmpeg -y -i storage/staged/voice.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 16000 -ac 1 -c:a pcm_s16le storage/staged/voice.wav`
3. `rhubarb -r phonetic --extendedShapes X -f json -o storage/staged/mouth-cues.json storage/staged/voice.wav`
4. Rewrite `manifest.json`: `script.captions` ← captions.json, `script.estimatedDuration` ← ffprobe(voice.wav), `videoConfig.timeline` ← recomputed from real timings.

### Step 4 — Video Compilation (Remotion)
1. Stage `storage/staged/public/` (voice.wav, mouth-cues.json, sprites, b-roll, music, fonts) — the orchestrator does this.
2. Pass `storage/staged/manifest.json` as props to `ReelComposition`; `calculateMetadata()` fetches the rest from the public dir.
3. `npx remotion render src/modules/video/Root.tsx ReelComposition storage/artifacts/final_reel.mp4 --props=storage/staged/manifest.json --concurrency=2 --gl=angle --public-dir=storage/staged/public`
   (`--browser-executable=$CF_BROWSER_EXECUTABLE` when remotion.media is unreachable; must be chrome-headless-shell, not new-headless Chrome)

### Step 5 — Carousel Generation (Satori + Resvg)
1. Read `carouselConfig` from `manifest.json`.
2. Render each slide to an SVG layout using Flexbox, then rasterize to PNG via Resvg.
3. Output: `storage/artifacts/carousel/slide_1.png`, `slide_2.png`, …

### Step 6 — Unified Distribution (Postiz)
1. Caption = `distribution.captionText` + legal footer when supplements are mentioned (ст. 25 ФЗ «О рекламе») + hashtags.
2. Schedule = `distribution.scheduledTimestamp` or the next free slot from `postiz.config.json` (`schedule.reelSlots` / `carouselSlots`, tz-aware).
3. Reel: upload `final_reel.mp4` → `POST /posts` to `channels.reel`.
4. Carousel: upload `slide_1..N.png` in order → one `POST /posts` with the ordered media list to `channels.carousel`.
5. Every dispatch is appended to `storage/cache/publish-log.json`. `--dry-run` builds and logs the payloads without calling Postiz; `--mode draft` parks posts for human approval.
   (CLI equivalent when `dispatchMode: "cli"`: `postiz posts:create -c "<caption>" -m "<paths>" -i "<channelIds>" -d "<iso>"`)

## 6. Verification Checklist

Before finishing any task or script modification, ensure:

- [ ] No direct platform posting logic exists outside of Postiz.
- [ ] Rhubarb is always invoked with `-r phonetic --extendedShapes X`.
- [ ] `npm run typecheck` passes and `npm run doctor` shows no FAIL.
- [ ] Font files for Satori explicitly support Russian glyphs.
- [ ] Remotion props and manifests strictly match `ProductionPayload`.
- [ ] All filesystem operations strictly respect the boundaries of `storage/` and `assets/`.

## 7. Repository Commands

```bash
npm run doctor      # verify system binaries, fonts, sprites and config
npm run intel       # Step 1: competitor parsing -> storage/raw/topics.json
npm run produce     # Steps 2-5: manifest -> voice -> visemes -> reel -> carousel
npm run publish     # Step 6: push artifacts to Postiz
npm run run:full    # intel + produce + publish
npm run typecheck   # strict TS contract check
```
