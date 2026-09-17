# Запуск на боевом сервере через Claude Code

Сервер уже с установленным Claude Code. Порядок: клон → setup → doctor → смоук → голос → персонаж → Postiz.

## 1. Клонировать и открыть проект

```bash
sudo mkdir -p /opt/autopostwb && sudo chown "$USER":"$USER" /opt/autopostwb
git clone https://github.com/islammdistarul-netizen/autopostwb.git /opt/autopostwb
cd /opt/autopostwb && git checkout claude/eloquent-lamport-pxecqs
claude
```

## 2. Первый промпт в Claude Code на сервере

Скопируйте целиком:

```
Прочитай CLAUDE.md, README.md, docs/PLAN.md и docs/AVATAR.md. Это готовый контент-завод; код собран и проверен, но на этом сервере ещё ничего не установлено.

Сделай по порядку, после каждого шага показывай результат и останавливайся при FAIL:
1. Сначала `free -h` и `docker stats --no-stream` — покажи, сколько памяти занимает Coolify (ожидаем 12 GB всего после апгрейда). Затем `sudo bash scripts/setup-server.sh` — системные зависимости, python-пакеты, rhubarb, piper, rembg, шрифты, swap, npm install. Настройки в config/app.config.json оставь по умолчанию (video.concurrency=2); ужимай до concurrency=1 только если свободной памяти меньше 3 GB.
2. `cp .env.example .env` и спроси меня значения: CF_BRAND_HANDLE, YANDEX_API_KEY, YANDEX_FOLDER_ID (если есть), PEXELS_API_KEY (если есть). POSTIZ_API_KEY — позже.
3. `npm run doctor` — разбери каждый FAIL и исправь. Если Remotion не может скачать chrome-headless-shell (403 remotion.media), поставь его через `npx playwright install chromium-headless-shell` и пропиши CF_BROWSER_EXECUTABLE в .env.
4. `npm run sprites:placeholder`; фоны через `scripts/fetch-broll.sh` (если есть PEXELS_API_KEY), иначе попроси меня положить 2–3 вертикальных mp4 в assets/b-roll; музыку — `scripts/normalize-music.sh`.
5. `CF_SCRIPT_PROVIDER=template npm run produce` — смоук без LLM. Покажи, где лежат final_reel.mp4 и слайды.
6. Если YANDEX_API_KEY задан: поставь voice.defaultPreset = "yandex_alena" в config/app.config.json и повтори produce; проверь, что captions.json совпадает с речью.
7. `npm run intel` по ключевым словам из config/app.config.json → покажи топ-5 кандидатов из storage/raw/topics.json.
8. `npm run produce` уже через claude -p (CF_SCRIPT_PROVIDER=claude).

Правила: не трогай CLAUDE.md без моего согласия; ничего не публикуй (publish только с --dry-run), пока я не скажу; все изменения кода — коммить в ветку claude/eloquent-lamport-pxecqs.
```

## 2a. Сервер с Coolify (после апгрейда: 6 vCPU / 12 GB / 160 GB)

Coolify держит Docker, Traefik (80/443), свою БД и Redis — обычно 1.5–2.5 GB. Из этого следует:

**Память.** Бюджет: Coolify ~2 GB + Postiz ~2 GB (с Temporal) + завод ~2 GB в пике = ~6 GB из 12 — запас есть, настройки по умолчанию (`video.concurrency: 2`, swap 4G, `MemoryMax=4G` в сервисе). Проверить фактическое распределение перед первым рендером:

```bash
free -h && docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}'
```
Ужимать (`concurrency: 1`, `SWAP_GB=8`) только если свободной памяти меньше 3 GB.

**Postiz — через Coolify, а не через наш compose.** В Coolify: Projects → New Resource → Services → **Postiz** (есть в каталоге), указать домен (A-запись на 205.172.56.136 сделать заранее) — HTTPS выдаст Traefik сам. `deploy/postiz/docker-compose.yml` и Caddy на этом сервере **не использовать** (порты 80/443 заняты Traefik). Переменные провайдеров (YouTube/Telegram/VK ключи) задаются в Environment Variables сервиса в Coolify. После запуска: зарегистрировать владельца → Settings → Public API → ключ в `.env`, и в `config/postiz.config.json` поставить `"host": "https://postiz.ваш-домен"` (не `localhost:5000` — порт наружу Coolify не пробрасывает).

**Регион US** — прокси для Instagram/TikTok не нужен, `POSTIZ_HTTPS_PROXY` пустой. Для YouTube-разведки на датацентровом IP держите наготове `YTDLP_COOKIES`.

## 3. Что понадобится по ходу

| Когда | Что |
|---|---|
| шаг 2 | ключ Yandex SpeechKit (Yandex Cloud → сервисный аккаунт → роль `ai.speechkit-tts.user` → API-ключ; folder id из консоли) |
| шаг 4 | 2–3 вертикальных фоновых видео и 2–3 трека без авторских прав, или ключ Pexels |
| после шага 8 | референс персонажа (см. docs/AVATAR.md) и ключ OpenAI или Gemini для генерации поз |
| этап Postiz | домен с A-записью на сервер, `deploy/postiz/.env`, ключ Public API, id каналов |

## 4. threads-carousel-claude-skill (отдельно, интерактивно)

Это интерактивный скилл с браузерным экспортом (Next.js + html-to-image), не часть headless-конвейера. Ставится как скилл Claude Code:

```bash
git clone https://github.com/itchernetski/threads-carousel-claude-skill.git ~/.claude/skills/threads-carousel
cd ~/.claude/skills/threads-carousel/template && npm install
```

Использование: в Claude Code сказать «сделай карусель из этого текста» → превью на `:3333` (через SSH-туннель `ssh -L 3333:localhost:3333 user@server`) → Export All → PNG. Автоматический конвейер каруселей остаётся на Satori (`npm run carousel`); удачные типы слайдов оттуда переносятся в `src/modules/carousel/templates/` по мере надобности.
