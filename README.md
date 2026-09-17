# autopostwb — автономный контент-завод

Разведка конкурентов → сценарий → русская нейро-озвучка (edge / Yandex / Piper / ElevenLabs) → вертикальный рилс с 2D-спрайтовым аватаром → карусель 4:5 → публикация через self-hosted Postiz. Всё как код, без ручных шагов после настройки.

```
intel   ──▶ storage/raw/topics.json          (yt-dlp + автосубтитры YouTube / faster-whisper + скоринг)
produce ─▶ storage/staged/manifest.json     (claude -p → ProductionPayload, zod-валидация, позы по character.json)
        ─▶ voice.wav + captions.json         (провайдер по пресету; тайминги из движка или Whisper-выравнивание)
        ─▶ mouth-cues.json                   (rhubarb -r phonetic)
        ─▶ storage/artifacts/final_reel.mp4  (Remotion 1080x1920 30fps H.264, спрайты + виземы + моргание)
        ─▶ storage/artifacts/carousel/*.png  (Satori + Resvg 1080x1350)
publish ─▶ Postiz public API                 (рилс + карусель, по слотам расписания)
```

- Правила и границы модулей — [`CLAUDE.md`](CLAUDE.md)
- Разбор инструментов, критика исходного исследования, план внедрения — [`docs/PLAN.md`](docs/PLAN.md)
- Персонаж: режимы, спецификация арта, генерация недостающих поз — [`docs/AVATAR.md`](docs/AVATAR.md)

## Быстрый старт на сервере (Ubuntu 22.04/24.04)

```bash
git clone <repo> /opt/autopostwb && cd /opt/autopostwb
sudo bash scripts/setup-server.sh        # ffmpeg, python-пакеты, rhubarb, piper, rembg, шрифты, swap, npm install
cp .env.example .env                     # POSTIZ_API_KEY, YANDEX_*, CF_BRAND_HANDLE ...
npx skills add remotion-dev/skills       # официальные навыки Remotion для Claude Code (опционально)
npm run sprites:placeholder              # временный аватар, пока нет арта
# фоны в assets/b-roll (scripts/fetch-broll.sh), музыка в assets/music (scripts/normalize-music.sh)
npm run doctor                           # всё зелёное? тогда:
CF_SCRIPT_PROVIDER=template npm run produce -- --skip-render   # смоук без LLM и без рендера
npm run intel && npm run produce && npm run publish -- --dry-run
```

Postiz поднимается отдельно: `deploy/postiz/docker-compose.yml` (+ реверс-прокси с HTTPS). Автозапуск завода — `deploy/autopostwb.timer`.

## Команды

| Команда | Что делает |
|---|---|
| `npm run doctor [-- --postiz]` | бинарники, python-пакеты, шрифты (кириллица), персонаж и очередь запросов на спрайты, активный голосовой провайдер, ключ и каналы Postiz |
| `npm run intel [-- --reuse-scrape] [--no-transcribe]` | парсинг конкурентов → `storage/raw/topics.json` |
| `npm run produce [-- --topic <id>] [--character <id>] [--skip-render] [--skip-carousel] [--reuse-audio]` | шаги 2–5 для одной темы |
| `npm run carousel` | перерендер слайдов из текущего манифеста |
| `npm run publish [-- --dry-run] [--mode draft\|schedule\|now]` | шаг 6 |
| `npm run run:full [-- --dry-run]` | intel + produce + publish под lock-файлом |
| `npm run sprites:prepare -- <id> art.png --pose <pose> [--mood <mood>]` | интейк арта: rembg → trim → fit → превью с направляющими |
| `npm run sprites:prepare -- <id> --approve --pose <pose>` | утвердить кандидата и зарегистрировать в `character.json` |
| `npm run sprites:generate -- <id> --pose <pose> [--mood <mood>] [--approve]` | сгенерировать позу по референсу (OpenAI gpt-image-1 или Gemini) |
| `npm run sprites:generate -- <id> --from-requests` | обработать всё, что запросили сценарии |
| `npm run studio` | Remotion Studio для правки композиции |
| `npm run typecheck` | строгая проверка контрактов |

Любая команда принимает `--json` — результат в stdout, логи всегда в stderr.

## Голос

`config/app.config.json` → `voice.defaultPreset`: `male`/`female` (edge, бесплатно), `yandex_alena`/`yandex_filipp` (SpeechKit, ~1 ₽/ролик), `piper_irina` (офлайн, MIT), `eleven` (ElevenLabs). Провайдеры без пословных таймингов получают субтитры через выравнивание Whisper по тексту сценария (`voice.alignModel`, по умолчанию `small`).

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `POSTIZ_API_KEY` | ключ Postiz → Settings → Public API |
| `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` | SpeechKit (сервисный аккаунт с ролью `ai.speechkit-tts.user`) |
| `ELEVENLABS_API_KEY` | ElevenLabs |
| `OPENAI_API_KEY` / `GEMINI_API_KEY`, `CF_SPRITE_BACKEND` | генерация спрайтов (`openai` \| `gemini`) |
| `CF_SCRIPT_PROVIDER` | `claude` (headless `claude -p`) или `template` (смоук без LLM) |
| `CF_CLAUDE_MODEL`, `CF_CLAUDE_MAX_BUDGET_USD` | модель и потолок расходов на один вызов сценариста |
| `CF_BRAND_HANDLE` | подпись в футере слайдов |
| `CF_BROWSER_EXECUTABLE`, `CF_GL_RENDERER` | системный `chrome-headless-shell`, если remotion.media закрыт; `angle`/`swangle` |
| `YTDLP_COOKIES`, `YTDLP_EXTRA_ARGS` | куки/прокси для yt-dlp |
| `CF_DEBUG=1` / `CF_QUIET=1` | подробные логи / только ошибки |

## Структура

```
config/      app.config.json (ниша, скоринг, голос+пресеты, рендер, ретеншн), postiz.config.json (хост, каналы, слоты, channelSettings)
src/types    manifest.ts (ProductionPayload + zod), avatar.ts (character.json v2, resolveSprites, isBlinking), postiz.ts
src/modules  intelligence/ scripting/ synthesis/{providers,align} avatar/ video/ carousel/ distribution/
src/pipeline orchestrator.ts (шаги + lock + архив + валидация по персонажу), cli.ts, doctor.ts
scripts/     setup-server.sh, tts.py, transcribe.py, make-placeholder-sprites.ts, prepare-sprites.ts, generate-sprite.ts, fetch-broll.sh, normalize-music.sh
deploy/      systemd service+timer, run-cycle.sh, postiz/docker-compose.yml (+ профиль temporal)
assets/      characters/<id>/ (character.json, reference.png, bodies/ frames/ faces/ mouths/), fonts/, voices/, b-roll/, music/
storage/     raw/ staged/ artifacts/ (+ runs/<runId>/) cache/ (topic-history, publish-log, sprite-requests, sprite-candidates)
```
