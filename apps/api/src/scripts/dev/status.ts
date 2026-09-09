/**
 * Dev-loop lifecycle inspector.
 *
 *   pnpm dev:loop:status                  list all known profiles + liveness
 *   pnpm dev:loop:status --pretty         human-readable table
 *   pnpm dev:loop:status --prune          delete profile files whose PID is dead
 *   pnpm dev:loop:status --kill <profile> kill the loop owning that profile
 *
 * Each profile file under `.dev-loop/profiles/` is written by `dev/loop.sh`
 * when a stack boots, and removed by its cleanup trap on shutdown. A
 * SIGKILL'd loop leaves its file behind — `--prune` (and the auto-prune in
 * `_profile_loader.ts`) clean those up.
 *
 * Liveness has two levels: PID-alive (`kill -0` succeeds) and API-alive
 * (the recorded `API_BASE_URL/.well-known/health-check` returns 2xx within
 * 1s). PID without API typically means the stack is still booting or the
 * API crashed independently of the parent loop.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const PROFILES_DIR = path.join(REPO_ROOT, '.dev-loop/profiles');

interface ProfileFile {
  profile?: string;
  pid?: number;
  startedAt?: string;
  env?: Record<string, string>;
}

interface ProfileStatus {
  name: string;
  file: string;
  pid?: number;
  pidAlive: boolean;
  apiBaseUrl?: string;
  apiAlive: boolean;
  startedAt?: string;
  ports: Record<string, string | undefined>;
  pruned?: boolean;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function probeApi(baseUrl: string): Promise<boolean> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1000);
    const res = await fetch(`${baseUrl}/.well-known/health-check`, { signal: ac.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function readProfile(file: string): ProfileFile | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as ProfileFile;
  } catch {
    return null;
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) return 'true';
  return next;
}

async function inspectProfiles(opts: { prune: boolean }): Promise<ProfileStatus[]> {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  const files = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json'));
  const results: ProfileStatus[] = [];

  for (const fileName of files) {
    const file = path.join(PROFILES_DIR, fileName);
    const data = readProfile(file);
    const name = data?.profile ?? fileName.replace(/\.json$/, '');
    const pid = data?.pid;
    const pidAlive = typeof pid === 'number' ? isPidAlive(pid) : false;
    const apiBaseUrl = data?.env?.API_BASE_URL;
    const apiAlive = pidAlive && apiBaseUrl ? await probeApi(apiBaseUrl) : false;

    let pruned = false;
    if (opts.prune && !pidAlive) {
      try {
        fs.unlinkSync(file);
        pruned = true;
      } catch {
        // best effort
      }
    }

    results.push({
      name,
      file,
      pid,
      pidAlive,
      apiBaseUrl,
      apiAlive,
      startedAt: data?.startedAt,
      ports: {
        api: data?.env?.PORT,
        app: data?.env?.APP_PORT,
        web: data?.env?.WEB_PORT,
        fakeChannels: data?.env?.FAKE_CHANNELS_PORT,
      },
      pruned,
    });
  }

  return results;
}

function renderPretty(results: ProfileStatus[]) {
  if (results.length === 0) {
    process.stdout.write('No dev-loop profiles found.\n');
    return;
  }
  const header = ['PROFILE', 'STATUS', 'PID', 'API', 'STARTED', 'PORTS'].join('\t');
  process.stdout.write(`${header}\n`);
  for (const r of results) {
    let status: string;
    if (r.pruned) status = 'pruned';
    else if (r.apiAlive) status = 'alive';
    else if (r.pidAlive) status = 'booting?';
    else status = 'dead';

    const portStr = [r.ports.api, r.ports.app, r.ports.web, r.ports.fakeChannels]
      .filter(Boolean)
      .join('/');
    process.stdout.write(
      [
        r.name,
        status,
        r.pid ?? '-',
        r.apiBaseUrl ?? '-',
        r.startedAt ?? '-',
        portStr,
      ].join('\t') + '\n',
    );
  }
}

async function killProfile(name: string): Promise<{ killed: boolean; pid?: number; reason?: string }> {
  const file = path.join(PROFILES_DIR, `${name}.json`);
  const data = readProfile(file);
  if (!data) return { killed: false, reason: `no profile file at ${file}` };
  const pid = data.pid;
  if (typeof pid !== 'number') return { killed: false, reason: 'profile file has no pid' };
  if (!isPidAlive(pid)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best effort
    }
    return { killed: false, pid, reason: 'pid was already dead; file removed' };
  }
  try {
    process.kill(pid, 'SIGTERM');
    return { killed: true, pid };
  } catch (err) {
    return { killed: false, pid, reason: (err as Error).message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const pretty = args.includes('--pretty');
  const prune = args.includes('--prune');
  const killTarget = flag(args, 'kill');

  if (killTarget && killTarget !== 'true') {
    const result = await killProfile(killTarget);
    if (pretty) {
      if (result.killed) {
        process.stdout.write(`Killed ${killTarget} (pid ${result.pid}).\n`);
      } else {
        process.stdout.write(`Did not kill ${killTarget}: ${result.reason ?? 'unknown'}\n`);
      }
    } else {
      process.stdout.write(JSON.stringify({ profile: killTarget, ...result }, null, 2) + '\n');
    }
    return;
  }

  const results = await inspectProfiles({ prune });
  if (pretty) {
    renderPretty(results);
  } else {
    process.stdout.write(JSON.stringify({ profiles: results }, null, 2) + '\n');
  }
}

main().catch((err) => {
  process.stderr.write(`[dev:loop:status] error: ${(err as Error).message}\n`);
  process.exit(1);
});
