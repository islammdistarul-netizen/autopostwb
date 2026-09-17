import fs from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.ts';
import { loadAppConfig, loadPostizConfig } from '../lib/config.ts';
import { paths } from '../lib/paths.ts';
import { run, which } from '../lib/shell.ts';
import { CharacterDefinitionSchema, characterProblems, listCharacterSprites, registeredMoods, registeredPoses } from '../types/avatar.ts';
import { verifyCyrillicFonts } from '../modules/carousel/compiler.ts';
import { PostizClient } from '../modules/distribution/postiz.client.ts';
import { listSpriteRequests } from '../modules/avatar/sprites.ts';
import { getVoiceProvider } from '../modules/synthesis/providers/index.ts';
import { resolveVoicePreset } from '../lib/config.ts';

/**
 * Environment verification. Every check maps to a concrete fix, so a fresh
 * server can be brought to green by reading the output top to bottom.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  optional?: boolean;
}

async function binary(name: string, fix: string, optional = false): Promise<Check> {
  const found = await which(name);
  return { name: `bin:${name}`, ok: Boolean(found), detail: found ?? 'not found', fix, optional };
}

async function pyModule(mod: string, fix: string): Promise<Check> {
  const res = await run('python3', ['-c', `import ${mod}`], { allowFailure: true });
  return { name: `py:${mod}`, ok: res.code === 0, detail: res.code === 0 ? 'importable' : res.stderr.trim().split('\n').pop() ?? 'missing', fix };
}

async function rhubarbRecognizer(): Promise<Check> {
  const found = await which('rhubarb');
  if (!found) return { name: 'rhubarb:-r phonetic', ok: false, detail: 'rhubarb missing', fix: 'scripts/setup-server.sh' };
  const res = await run('rhubarb', ['--help'], { allowFailure: true });
  const text = res.stdout + res.stderr;
  const ok = /phonetic/.test(text);
  return { name: 'rhubarb:-r phonetic', ok, detail: ok ? 'phonetic recognizer available' : 'no phonetic recognizer in --help', fix: 'Install Rhubarb >= 1.10' };
}

function characterSprites(): Check[] {
  const checks: Check[] = [];
  if (!fs.existsSync(paths.characters)) return [{ name: 'characters', ok: false, detail: 'assets/characters missing', fix: 'git checkout assets/' }];
  for (const id of fs.readdirSync(paths.characters)) {
    const dir = path.join(paths.characters, id);
    const jsonPath = path.join(dir, 'character.json');
    if (!fs.existsSync(jsonPath)) continue;
    const parsed = CharacterDefinitionSchema.safeParse(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
    if (!parsed.success) {
      checks.push({ name: `character:${id}`, ok: false, detail: `${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message ?? 'invalid'}`, fix: 'Fix character.json' });
      continue;
    }
    const problems = characterProblems(parsed.data);
    const missing = listCharacterSprites(parsed.data).filter((rel) => !fs.existsSync(path.join(dir, rel)));
    const poses = registeredPoses(parsed.data).length;
    const moods = registeredMoods(parsed.data).length;
    checks.push({
      name: `character:${id}`,
      ok: missing.length === 0 && problems.length === 0,
      detail:
        problems.length
          ? problems.join('; ')
          : missing.length
            ? `missing ${missing.length} sprite(s): ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}`
            : `${parsed.data.mode}, ${poses} pose(s), ${moods} mood(s), all sprites present`,
      fix: 'npm run sprites:placeholder, or prepare/register the missing art (scripts/prepare-sprites.ts)',
    });
    const pending = listSpriteRequests(id);
    if (pending.length) {
      checks.push({
        name: `character:${id}:requests`,
        ok: false,
        optional: true,
        detail: `${pending.length} pose(s) requested by scripts: ${pending.map((r) => r.pose).slice(0, 5).join(', ')}`,
        fix: `npx tsx scripts/generate-sprite.ts ${id} --from-requests`,
      });
    }
  }
  return checks;
}

/**
 * Remotion needs chrome-headless-shell (old headless mode). It downloads one
 * from remotion.media on first render; on servers where that host is blocked,
 * CF_BROWSER_EXECUTABLE must point at a system headless_shell binary.
 */
function headlessBrowser(): Check {
  const custom = process.env.CF_BROWSER_EXECUTABLE;
  if (custom) {
    const ok = fs.existsSync(custom);
    return { name: 'browser:headless', ok, detail: ok ? `CF_BROWSER_EXECUTABLE=${custom}` : `${custom} does not exist`, fix: 'Point CF_BROWSER_EXECUTABLE at a chrome-headless-shell binary' };
  }
  // A failed download leaves an empty folder behind, so look for the actual binary.
  const cacheDir = path.join(paths.root, 'node_modules', '.remotion');
  const binary = findFile(cacheDir, /^(chrome-headless-shell|headless_shell)$/, 5);
  return {
    name: 'browser:headless',
    ok: Boolean(binary),
    detail: binary ? `remotion-managed: ${path.relative(paths.root, binary)}` : 'not downloaded yet',
    fix: 'npx remotion browser ensure  (or set CF_BROWSER_EXECUTABLE if remotion.media is blocked)',
    optional: true,
  };
}

function findFile(dir: string, name: RegExp, depth: number): string | null {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && name.test(entry.name)) return full;
    if (entry.isDirectory()) {
      const hit = findFile(full, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

function assetDir(name: string, dir: string, exts: string[], fix: string): Check {
  const list = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => exts.includes(path.extname(f).toLowerCase())) : [];
  return { name: `assets:${name}`, ok: list.length > 0, detail: `${list.length} file(s)`, fix };
}

export async function runDoctor(options: { postiz?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];

  // Config
  try {
    loadAppConfig();
    checks.push({ name: 'config:app', ok: true, detail: 'valid' });
  } catch (err) {
    checks.push({ name: 'config:app', ok: false, detail: (err as Error).message.split('\n')[0] ?? 'invalid', fix: 'Fix config/app.config.json' });
  }
  let postizChannels = 0;
  try {
    const pz = loadPostizConfig();
    postizChannels = pz.channels.reel.length + pz.channels.carousel.length;
    checks.push({ name: 'config:postiz', ok: true, detail: `${postizChannels} channel id(s) configured` });
  } catch (err) {
    checks.push({ name: 'config:postiz', ok: false, detail: (err as Error).message.split('\n')[0] ?? 'invalid', fix: 'Fix config/postiz.config.json' });
  }

  // Binaries
  checks.push(await binary('ffmpeg', 'apt install ffmpeg'));
  checks.push(await binary('ffprobe', 'apt install ffmpeg'));
  checks.push(await binary('yt-dlp', 'pipx install yt-dlp  (or scripts/setup-server.sh)'));
  checks.push(await binary('rhubarb', 'scripts/setup-server.sh'));
  checks.push(await rhubarbRecognizer());
  checks.push(await binary('python3', 'apt install python3'));
  checks.push(await pyModule('faster_whisper', 'pip3 install faster-whisper'));
  // Active voice provider (per default preset) must be runnable; the others are informational.
  try {
    const cfg = loadAppConfig();
    const preset = resolveVoicePreset(cfg);
    const providerId = preset.provider ?? cfg.voice.provider;
    try {
      await getVoiceProvider(providerId).assertReady();
      checks.push({ name: `voice:${providerId}`, ok: true, detail: `preset "${cfg.voice.defaultPreset}" -> ${preset.voice}` });
    } catch (err) {
      checks.push({ name: `voice:${providerId}`, ok: false, detail: (err as Error).message, fix: 'Install/configure the provider or switch voice.defaultPreset' });
    }
    if (providerId === 'yandex' || providerId === 'piper') {
      const ok = (await run('python3', ['-c', 'import faster_whisper'], { allowFailure: true })).code === 0;
      checks.push({ name: 'voice:align', ok, detail: ok ? `whisper "${cfg.voice.alignModel}" aligns captions` : 'faster-whisper needed for caption alignment', fix: 'pip3 install faster-whisper' });
    }
  } catch {
    // config failure already reported above
  }
  checks.push(await pyModule('rembg', 'pip3 install "rembg[cpu]"  (only for sprite intake)').then((c) => ({ ...c, optional: true })));
  checks.push(await binary('claude', 'npm i -g @anthropic-ai/claude-code  (or CF_SCRIPT_PROVIDER=template)', true));
  checks.push(await binary('docker', 'Postiz runs via docker compose', true));

  // Node deps
  checks.push({
    name: 'node:remotion',
    ok: fs.existsSync(path.join(paths.root, 'node_modules', 'remotion')),
    detail: fs.existsSync(path.join(paths.root, 'node_modules', 'remotion')) ? 'installed' : 'missing',
    fix: 'npm install',
  });
  checks.push(headlessBrowser());

  // Assets
  checks.push(...characterSprites());
  checks.push(assetDir('b-roll', paths.bRoll, ['.mp4', '.mov'], 'Add vertical 1080x1920 loops to assets/b-roll (scripts/fetch-broll.sh)'));
  checks.push(assetDir('music', paths.music, ['.mp3', '.wav', '.m4a'], 'Add -24 LUFS tracks to assets/music (scripts/normalize-music.sh)'));
  checks.push(assetDir('fonts', paths.fonts, ['.ttf', '.otf', '.woff'], 'scripts/setup-server.sh downloads Inter + Unbounded'));
  try {
    const problems = await verifyCyrillicFonts(loadAppConfig());
    checks.push({ name: 'fonts:cyrillic', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : 'all configured fonts shape Cyrillic', fix: 'Use Inter/Unbounded static TTFs' });
  } catch (err) {
    checks.push({ name: 'fonts:cyrillic', ok: false, detail: (err as Error).message.split('\n')[0] ?? 'error', fix: 'scripts/setup-server.sh' });
  }

  // Postiz
  const apiKeyEnv = (() => {
    try {
      return loadPostizConfig().apiKeyEnv;
    } catch {
      return 'POSTIZ_API_KEY';
    }
  })();
  checks.push({ name: `env:${apiKeyEnv}`, ok: Boolean(process.env[apiKeyEnv]), detail: process.env[apiKeyEnv] ? 'set' : 'unset', fix: 'export POSTIZ_API_KEY=... (see .env.example)', optional: !options.postiz });
  if (options.postiz && process.env[apiKeyEnv]) {
    try {
      const integrations = await new PostizClient(loadPostizConfig()).listIntegrations();
      checks.push({
        name: 'postiz:integrations',
        ok: integrations.length > 0,
        detail: integrations.map((i) => `${i.id}${i.name ? ` (${i.name})` : ''}`).join(', ') || 'no channels connected',
        fix: 'Connect channels in Postiz UI, then paste ids into config/postiz.config.json',
      });
    } catch (err) {
      checks.push({ name: 'postiz:integrations', ok: false, detail: (err as Error).message.slice(0, 200), fix: 'Is Postiz up? Check host/apiBasePath in config/postiz.config.json' });
    }
  }
  if (postizChannels === 0) {
    checks.push({ name: 'postiz:channels', ok: false, detail: 'no channel ids configured', fix: 'npm run doctor -- --postiz, then fill channels.reel / channels.carousel', optional: true });
  }

  return checks;
}

export function printDoctor(checks: Check[]): boolean {
  let hardFailures = 0;
  for (const c of checks) {
    const mark = c.ok ? 'OK  ' : c.optional ? 'WARN' : 'FAIL';
    const line = `${mark} ${c.name.padEnd(24)} ${c.detail}${!c.ok && c.fix ? `\n       -> ${c.fix}` : ''}`;
    if (c.ok) log.info(line);
    else if (c.optional) log.warn(line);
    else {
      log.error(line);
      hardFailures += 1;
    }
  }
  log.step(hardFailures === 0 ? 'doctor: environment is ready' : `doctor: ${hardFailures} blocking issue(s)`);
  return hardFailures === 0;
}
