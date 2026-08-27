import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';

// config.ts reads the environment ONCE, while the module is evaluating, so
// every case here has to load a fresh copy of the module against a fresh
// environment. That is why each test goes through loadConfig() rather than
// importing `config` at the top: a single import would freeze the first
// environment in place and every later expectation would be measuring it.
//
// `os` and `fs` are stubbed for the same reason the OS detection exists at
// all -- the answer depends on the machine the suite happens to run on, and a
// test that only passes on the developer's platform is not a test. Stubbing
// them is what lets the WSL branch be exercised from Windows and from CI's
// Linux runner alike.

const MANAGED = [
  'MACHINE_NAME',
  'MACHINE_OS',
  'WSL_DISTRO_NAME',
  'CLAUDE_CODE_PATH',
  'LOG_RETENTION_DAYS',
  'SYNC_INCREMENTAL',
] as const;

type ManagedKey = (typeof MANAGED)[number];

// A documented placeholder, not a real home directory: this repository is
// public and the personal-data guard scans test files too.
const HOME = '/home/test';

const saved = new Map<string, string | undefined>();

const loadConfig = async (
  env: Partial<Record<ManagedKey, string>> = {},
  host: { platform?: string; wslRunMarker?: boolean } = {},
) => {
  for (const key of MANAGED) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  vi.resetModules();
  vi.doMock('os', async (importOriginal) => ({
    ...(await importOriginal<typeof import('os')>()),
    homedir: () => HOME,
    hostname: () => 'localhost',
    platform: () => host.platform ?? 'linux',
  }));
  vi.doMock('fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('fs')>()),
    // Only the interop marker exists; anything else the module asks about is
    // absent, so a stray existsSync cannot accidentally read as "in WSL".
    existsSync: (path: string) => Boolean(host.wslRunMarker) && path === '/run/WSL',
  }));

  const { config } = await import('./config.js');
  return config;
};

afterEach(() => {
  vi.doUnmock('os');
  vi.doUnmock('fs');
  vi.resetModules();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('which operating system the config reports', () => {
  // Issue #33: project-path comparison depends on whether the filesystem is
  // case-insensitive, and WSL is the one platform where process.platform is
  // misleading about that -- it answers "linux" while its /mnt/<letter> mounts
  // are Windows drives. So WSL has to be its own value, detected rather than
  // assumed, or two machines disagree about whether they saw the same project.
  it('takes process.platform at its word anywhere but Linux', async () => {
    expect((await loadConfig({}, { platform: 'win32' })).os).toBe('win32');
    expect((await loadConfig({}, { platform: 'darwin' })).os).toBe('darwin');
  });

  it('stays "linux" on a Linux carrying no interop markers', async () => {
    // The detection is deliberately narrow: os.release() carries "microsoft"
    // inside ANY container on Docker Desktop's WSL2 backend, where the
    // filesystem is the container's own and nothing is drvfs. Reading the
    // markers instead is what keeps a containerized sync reporting linux.
    expect((await loadConfig({}, { platform: 'linux' })).os).toBe('linux');
  });

  it('reports "wsl" when the distro name is in the environment', async () => {
    expect((await loadConfig({ WSL_DISTRO_NAME: 'distro' }, { platform: 'linux' })).os).toBe('wsl');
  });

  it('reports "wsl" from the /run/WSL marker with no env var set', async () => {
    // Either marker is enough on its own. A shell that inherited a scrubbed
    // environment still runs on a real WSL filesystem.
    expect((await loadConfig({}, { platform: 'linux', wslRunMarker: true })).os).toBe('wsl');
  });

  it('lets a relay that knows better override the detection entirely', async () => {
    expect((await loadConfig({ MACHINE_OS: 'wsl' }, { platform: 'win32' })).os).toBe('wsl');
  });
});

describe('which machine the config claims to be', () => {
  it('falls back to the OS hostname', async () => {
    expect((await loadConfig({})).machine).toBe('localhost');
  });

  it('prefers MACHINE_NAME, because a container hostname is a random id', async () => {
    // Several machines sync into one database and every project carries its
    // origin, so an unset name means rows stamped with a container id that
    // means nothing the next time the container is recreated.
    // 'server' rather than a realistic device name: this repo is public and
    // the personal-data guard rejects a machine-name assignment whose value is
    // not a recognised generic.
    expect((await loadConfig({ MACHINE_NAME: 'server' })).machine).toBe('server');
  });
});

describe('source paths from the environment', () => {
  it('expands a leading ~ so the default reaches a real home directory', async () => {
    expect((await loadConfig({})).sources.claudeCode.path).toBe(join(HOME, '/.claude'));
  });

  it('leaves a path that does not start with ~ exactly as given', async () => {
    // A bind mount inside a container has no ~ to expand, and rewriting it
    // would point the sync at a directory that does not exist -- which
    // presents as "no conversations found" rather than as an error.
    expect((await loadConfig({ CLAUDE_CODE_PATH: '/mnt/data/claude' })).sources.claudeCode.path).toBe(
      '/mnt/data/claude',
    );
  });
});

describe('numbers from the environment', () => {
  it('uses the default when the variable is absent', async () => {
    expect((await loadConfig({})).logs.retentionDays).toBe(14);
  });

  it('parses the value when one is set', async () => {
    expect((await loadConfig({ LOG_RETENTION_DAYS: '30' })).logs.retentionDays).toBe(30);
  });
});

describe('flags from the environment', () => {
  it('uses the default when the variable is absent', async () => {
    expect((await loadConfig({})).sync.incremental).toBe(true);
  });

  it('reads "false" as false', async () => {
    expect((await loadConfig({ SYNC_INCREMENTAL: 'false' })).sync.incremental).toBe(false);
  });

  it('reads "1" as true, because compose files spell booleans that way', async () => {
    // A deployment that wrote SYNC_INCREMENTAL=1 meaning "yes" and silently got
    // a full re-sync every hour would be an expensive way to learn this.
    expect((await loadConfig({ SYNC_INCREMENTAL: '1' })).sync.incremental).toBe(true);
  });

  it('is not case-sensitive about "true"', async () => {
    expect((await loadConfig({ SYNC_INCREMENTAL: 'TRUE' })).sync.incremental).toBe(true);
  });

  it('reads any other word as false rather than guessing', async () => {
    expect((await loadConfig({ SYNC_INCREMENTAL: 'yes' })).sync.incremental).toBe(false);
  });
});
