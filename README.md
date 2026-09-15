# autopostwb — автономный контент-завод

Разведка конкурентов → сценарий → русская нейро-озвучка → вертикальный рилс с 2D-аватаром → карусель 4:5 → публикация через self-hosted Postiz. Всё как код, без ручных шагов после настройки.

```
intel  ──▶ storage/raw/topics.json          (yt-dlp + автосубтитры/faster-whisper + скоринг)
produce ─▶ storage/staged/manifest.json     (claude -p → ProductionPayload, zod-валидация)
        ─▶ voice.wav + captions.json         (edge-tts, пословные тайминги)
        ─▶ mouth-cues.json                   (rhubarb -r phonetic)
        ─▶ storage/artifacts/final_reel.mp4  (Remotion 1080x1920 30fps H.264)
        ─▶ storage/artifacts/carousel/*.png  (Satori + Resvg 1080x1350)
publish ─▶ Postiz public API                 (рилс + карусель, по слотам расписания)
```

Правила и границы модулей — в [`CLAUDE.md`](CLAUDE.md). Разбор инструментов, найденные недочёты и план внедрения — в [`docs/PLAN.md`](docs/PLAN.md).

## Быстрый старт на сервере (Ubuntu 22.04/24.04)

```bash
git clone <repo> /opt/autopostwb && cd /opt/autopostwb
sudo bash scripts/setup-server.sh        # ffmpeg, python-пакеты, rhubarb, шрифты, npm install
cp .env.example .env                     # POSTIZ_API_KEY, CF_BRAND_HANDLE ...
npm run sprites:placeholder              # временный аватар, пока нет арта
# положить фоны в assets/b-roll (scripts/fetch-broll.sh) и музыку в assets/music (scripts/normalize-music.sh)
npm run doctor                           # всё зелёное? тогда:
CF_SCRIPT_PROVIDER=template npm run produce -- --skip-render   # смоук без LLM и без рендера
npm run intel && npm run produce && npm run publish -- --dry-run
```

Postiz поднимается отдельно: `deploy/postiz/docker-compose.yml` (+ реверс-прокси с HTTPS). Автозапуск завода — `deploy/autopostwb.timer`.

## Команды

| Команда | Что делает |
|---|---|
| `npm run doctor [-- --postiz]` | проверка бинарников, python-пакетов, шрифтов (кириллица), спрайтов, ассетов, ключа и каналов Postiz |
| `npm run intel [-- --reuse-scrape] [--no-transcribe]` | парсинг конкурентов → `storage/raw/topics.json` |
| `npm run produce [-- --topic <id>] [--skip-render] [--skip-carousel] [--reuse-audio]` | шаги 2–5 для одной темы |
| `npm run carousel` | перерендер слайдов из текущего манифеста |
| `npm run publish [-- --dry-run] [--mode draft\|schedule\|now]` | шаг 6 |
| `npm run run:full [-- --dry-run]` | intel + produce + publish под lock-файлом |
| `npm run studio` | Remotion Studio для правки композиции (публичная папка = `storage/staged/public`) |
| `npm run typecheck` | строгая проверка контрактов |

Любая команда принимает `--json` — результат печатается в stdout, логи всегда в stderr (для headless-режима).

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `POSTIZ_API_KEY` | ключ Postiz → Settings → Public API |
| `CF_SCRIPT_PROVIDER` | `claude` (по умолчанию, headless `claude -p`) или `template` (детерминированный смоук без LLM) |
| `CF_CLAUDE_MODEL` | переопределить модель для `claude -p --model` |
| `CF_BRAND_HANDLE` | подпись в футере слайдов |
| `CF_BROWSER_EXECUTABLE` | путь к `chrome-headless-shell`, если сервер не может скачать его с remotion.media |
| `CF_GL_RENDERER` | `angle` (по умолчанию) или `swangle` |
| `YTDLP_COOKIES`, `YTDLP_EXTRA_ARGS` | куки/прокси для yt-dlp, если YouTube просит «подтвердите, что вы не бот» |
| `CF_DEBUG=1` / `CF_QUIET=1` | подробные логи / только ошибки |

## Структура

```
config/      app.config.json (ниша, скоринг, голос, рендер, ретеншн), postiz.config.json (хост, каналы, слоты)
src/types    manifest.ts (ProductionPayload + zod), avatar.ts, postiz.ts
src/modules  intelligence/ synthesis/ scripting/ video/ carousel/ distribution/
src/pipeline orchestrator.ts (шаги + lock + архив ранов), cli.ts, doctor.ts
scripts/     setup-server.sh, tts.py, transcribe.py, make-placeholder-sprites.ts, fetch-broll.sh, normalize-music.sh
deploy/      systemd service+timer, run-cycle.sh, postiz/docker-compose.yml
assets/      characters/ (спрайты по character.json), fonts/ (Inter, Unbounded), b-roll/, music/
storage/     raw/ staged/ artifacts/ (+ artifacts/runs/<runId>/ архив) cache/
```
