import { spawn } from 'node:child_process';
import { log } from './log.ts';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Stream child output to stderr instead of only buffering it. */
  stream?: boolean;
  input?: string;
  allowFailure?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  command: string;
}

/**
 * Promise wrapper around spawn. No shell interpolation anywhere in the pipeline:
 * every argument is passed as an argv element, so scraped competitor text can
 * never turn into shell syntax.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { cwd, env, timeoutMs = 0, stream = false, input, allowFailure = false } = options;
  const printable = `${command} ${args.join(' ')}`.trim();
  log.debug('exec', { command: printable });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stream) process.stderr.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stream) process.stderr.write(chunk);
    });

    if (input) {
      child.stdin?.write(input);
      child.stdin?.end();
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      const hint =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? ` - binary "${command}" not found. Run scripts/setup-server.sh or npm run doctor.`
          : '';
      reject(new Error(`Failed to start: ${printable}${hint}\n${err.message}`));
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const result: RunResult = { code: code ?? -1, stdout, stderr, command: printable };
      if (timedOut) {
        reject(new Error(`Timed out after ${timeoutMs}ms: ${printable}`));
        return;
      }
      if (code !== 0 && !allowFailure) {
        reject(
          new Error(`Exited with ${code}: ${printable}\n${stderr.slice(-4000) || stdout.slice(-2000)}`),
        );
        return;
      }
      resolve(result);
    });
  });
}

export async function which(binary: string): Promise<string | null> {
  try {
    // Login shell so pipx/nvm PATH additions from the profile are visible (systemd
    // and cron won't have them otherwise). Profiles may print noise (nvm banners),
    // so only the last line — the resolved path — is used.
    const result = await run('sh', ['-lc', `command -v ${JSON.stringify(binary)}`], {
      allowFailure: true,
    });
    const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const found = lines[lines.length - 1];
    return result.code === 0 && found && found.startsWith('/') ? found : null;
  } catch {
    return null;
  }
}
