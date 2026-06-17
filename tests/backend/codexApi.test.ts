import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import express from 'express';
import request from 'supertest';

const mockExecFile = jest.fn();
const mockExecSync = jest.fn();

jest.mock('child_process', () => ({
  execFile: mockExecFile,
  execSync: mockExecSync,
}));

describe('Codex API Routes', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalShell: string | undefined;
  let app: express.Express;
  let sessionBroker: any;
  let transportLauncher: any;
  let dateNowSpy: jest.SpyInstance<number, []>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmux-codex-'));
    originalHome = process.env.WEBMUX_HOME;
    originalShell = process.env.SHELL;
    process.env.WEBMUX_HOME = tmpDir;
    process.env.SHELL = '/bin/test-shell';
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-17T20:10:00.000Z'));

    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'auth.yaml'), 'auth:\n  mode: none\n  users: []\n');
    fs.writeFileSync(path.join(configDir, 'hosts.yaml'), 'hosts: []\n');
    fs.writeFileSync(path.join(configDir, 'keys.yaml'), 'keys: []\n');
    fs.writeFileSync(path.join(configDir, 'layout.yaml'), 'layout:\n  font_size: 14\n  tiles: []\n');
    fs.writeFileSync(
      path.join(configDir, 'app.yaml'),
      'app:\n' +
        '  name: webmux\n' +
        '  listen_host: 0.0.0.0\n' +
        '  http_port: 8080\n' +
        '  https_port: 8443\n' +
        '  secure_mode: false\n' +
        '  trusted_http_allowed: true\n' +
        '  default_term:\n' +
        '    cols: 80\n' +
        '    rows: 24\n' +
        '    font_size: 14\n' +
        '  transport:\n' +
        '    prefer_mosh: false\n' +
        '    ssh_fallback: true\n',
    );

    mockExecFile.mockReset();
    mockExecSync.mockReset();
    jest.resetModules();

    const { default: agentsRouter } = require('@backend/api/agents');
    const { default: sessionsRouter } = require('@backend/api/sessions');
    sessionBroker = require('@backend/services/sessionBroker').sessionBroker;
    transportLauncher = require('@backend/services/transportLauncher').transportLauncher;

    await sessionBroker.initialize();

    app = express();
    app.use(express.json());
    app.use('/api/agents', agentsRouter);
    app.use('/api/sessions', sessionsRouter);
  });

  afterEach(() => {
    if (sessionBroker && transportLauncher) {
      for (const session of sessionBroker.list()) {
        transportLauncher.kill(session.id);
      }
    }
    if (originalHome === undefined) {
      delete process.env.WEBMUX_HOME;
    } else {
      process.env.WEBMUX_HOME = originalHome;
    }
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
    dateNowSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockTmuxLists(outputs: Record<string, string | Error>) {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _options: unknown, callback: (err: Error | null, stdout?: string) => void) => {
      const socketIndex = args.indexOf('-L');
      const socket = socketIndex >= 0 ? args[socketIndex + 1] : 'default';
      if (args.includes('list-sessions')) {
        const output = outputs[socket];
        if (output instanceof Error) {
          callback(output);
          return;
        }
        callback(null, output ?? '');
        return;
      }
      if (args.includes('display-message')) {
        callback(null, tmpDir + '\n');
        return;
      }
      callback(null, '');
    });
  }

  function mockTmuxList(output: string) {
    mockTmuxLists({ codex: output });
  }

  function encodedStatusName(name: string) {
    return Buffer.from(name, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  function writeAgentStatus(kind: string, name: string, status: Record<string, unknown>) {
    const dir = path.join(tmpDir, 'data', 'agent-status', kind);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${encodedStatusName(name)}.json`), JSON.stringify({
      kind,
      name,
      ...status,
    }));
  }

  function readAgentStatus(kind: string, name: string) {
    const file = path.join(tmpDir, 'data', 'agent-status', kind, `${encodedStatusName(name)}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  }

  function writeAuthConfig(content: string) {
    fs.writeFileSync(path.join(tmpDir, 'config', 'auth.yaml'), content);
  }

  it('parses tmux sessions from GET /api/agents/codex/sessions', async () => {
    mockTmuxList('codex-alpha-2026-06-14-15-08-55\t1\t2\t1781474936\t1781725677\ncodex-beta\t3\t0\t1781475000\t1781476000\n');

    const res = await request(app).get('/api/agents/codex/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        name: 'codex-alpha-2026-06-14-15-08-55',
        kind: 'codex',
        display_name: 'alpha',
        windows: 1,
        attached: 2,
        created_at: '2026-06-14T22:08:56.000Z',
        last_output_at: '2026-06-17T19:47:57.000Z',
        status: 'unknown',
        status_source: 'tmux',
      },
      {
        name: 'codex-beta',
        kind: 'codex',
        display_name: 'beta',
        windows: 3,
        attached: 0,
        created_at: '2026-06-14T22:10:00.000Z',
        last_output_at: '2026-06-14T22:26:40.000Z',
        status: 'stale',
        status_source: 'tmux',
      },
    ]);
  });

  it('returns combined agent sessions with duplicate display names disambiguated by creation time', async () => {
    mockTmuxLists({
      codex:
        'codex-hiccup-output-questions-2026-06-14-20-12-51\t1\t0\t1781493171\t1781727026\n' +
        'codex-hiccup-output-questions-2026-06-16-11-58-47\t1\t0\t1781636327\t1781670530\n',
      claude: 'claude-food-2026-06-14-16-32-59\t1\t1\t1781479979\t1781729170\n',
      copilot: '',
    });

    const res = await request(app).get('/api/agents/sessions');

    expect(res.status).toBe(200);
    expect(res.body.map((session: { kind: string; name: string; display_name: string }) => ({
      kind: session.kind,
      name: session.name,
      display_name: session.display_name,
    }))).toEqual([
      {
        kind: 'codex',
        name: 'codex-hiccup-output-questions-2026-06-14-20-12-51',
        display_name: 'hiccup-output-questions (1)',
      },
      {
        kind: 'codex',
        name: 'codex-hiccup-output-questions-2026-06-16-11-58-47',
        display_name: 'hiccup-output-questions (2)',
      },
      {
        kind: 'claude',
        name: 'claude-food-2026-06-14-16-32-59',
        display_name: 'food',
      },
    ]);
  });

  it('returns available combined agent sessions when one agent socket fails', async () => {
    mockTmuxLists({
      codex: 'codex-hiccup-2026-06-14-15-08-55\t1\t0\t1781474936\t1781725677\n',
      claude: new Error('permission denied'),
      copilot: '',
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const res = await request(app).get('/api/agents/sessions');

      expect(res.status).toBe(200);
      expect(res.body.map((session: { kind: string; name: string; display_name: string }) => ({
        kind: session.kind,
        name: session.name,
        display_name: session.display_name,
      }))).toEqual([
        {
          kind: 'codex',
          name: 'codex-hiccup-2026-06-14-15-08-55',
          display_name: 'hiccup',
        },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to list claude sessions for combined agent list:',
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('merges hook status metadata for live tmux sessions', async () => {
    mockTmuxList('codex-hiccup-2026-06-14-15-08-55\t1\t0\t1781474936\t1781725677\n');
    writeAgentStatus('codex', 'codex-hiccup-2026-06-14-15-08-55', {
      status: 'waiting',
      source: 'hook',
      updated_at: '2026-06-17T20:00:00.000Z',
      last_ready_at: '2026-06-17T20:00:00.000Z',
      last_output_at: '2026-06-17T20:00:00.000Z',
    });

    const res = await request(app).get('/api/agents/codex/sessions');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      name: 'codex-hiccup-2026-06-14-15-08-55',
      display_name: 'hiccup',
      last_output_at: '2026-06-17T20:00:00.000Z',
      status: 'waiting',
      status_source: 'hook',
    });
  });

  it('does not use webmux attach output metadata as the session last output time', async () => {
    mockTmuxList('codex-hiccup-2026-06-14-15-08-55\t1\t0\t1781474936\t1781476000\n');
    writeAgentStatus('codex', 'codex-hiccup-2026-06-14-15-08-55', {
      status: 'working',
      source: 'webmux',
      updated_at: '2026-06-17T20:00:00.000Z',
      last_output_at: '2026-06-17T20:00:00.000Z',
    });

    const res = await request(app).get('/api/agents/codex/sessions');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      name: 'codex-hiccup-2026-06-14-15-08-55',
      last_output_at: '2026-06-14T22:26:40.000Z',
      status: 'working',
      status_source: 'webmux',
    });
  });

  it('uses marked live webmux output metadata as the session last output time', async () => {
    mockTmuxList('codex-hiccup-2026-06-14-15-08-55\t1\t0\t1781474936\t1781476000\n');
    writeAgentStatus('codex', 'codex-hiccup-2026-06-14-15-08-55', {
      status: 'working',
      source: 'webmux',
      updated_at: '2026-06-17T20:00:00.000Z',
      last_output_at: '2026-06-17T20:00:00.000Z',
      last_output_source: 'live',
    });

    const res = await request(app).get('/api/agents/codex/sessions');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      name: 'codex-hiccup-2026-06-14-15-08-55',
      last_output_at: '2026-06-17T20:00:00.000Z',
      status: 'working',
      status_source: 'webmux',
    });
  });

  it('clears the live output marker when a hook writes a new output timestamp', async () => {
    const { agentService } = require('@backend/services/agentService');

    await agentService.recordStatus('codex', 'codex-a', {
      status: 'working',
      source: 'webmux',
      last_output_at: '2026-06-17T20:00:00.000Z',
      last_output_source: 'live',
    });
    await agentService.recordStatus('codex', 'codex-a', {
      status: 'waiting',
      source: 'hook',
      last_output_at: '2026-06-17T20:01:00.000Z',
      last_ready_at: '2026-06-17T20:01:00.000Z',
    });

    const status = readAgentStatus('codex', 'codex-a');
    expect(status).toMatchObject({
      kind: 'codex',
      name: 'codex-a',
      status: 'waiting',
      source: 'hook',
      last_output_at: '2026-06-17T20:01:00.000Z',
      last_ready_at: '2026-06-17T20:01:00.000Z',
    });
    expect(status.last_output_source).toBeUndefined();
  });

  it('does not expose stale hook files for sessions no longer in tmux', async () => {
    mockTmuxList('');
    writeAgentStatus('codex', 'codex-missing-2026-06-14-15-08-55', {
      status: 'waiting',
      source: 'hook',
      updated_at: '2026-06-17T20:00:00.000Z',
    });

    const res = await request(app).get('/api/agents/codex/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns an empty list when tmux has no codex sessions', async () => {
    mockTmuxList('');

    const res = await request(app).get('/api/agents/codex/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('rejects attach for a name not present in tmux list', async () => {
    mockTmuxList('codex-a\t1\t0\n');

    const res = await request(app).post('/api/agents/codex/attach').send({ name: 'missing' });

    expect(res.status).toBe(404);
  });

  it('reuses one codex attach session when switching tmux names', async () => {
    mockTmuxList('codex-a\t1\t0\ncodex-b\t1\t0\n');

    const first = await request(app).post('/api/agents/codex/attach').send({ name: 'codex-a', cols: 120, rows: 40 });
    const second = await request(app).post('/api/agents/codex/attach').send({ name: 'codex-b', cols: 120, rows: 40 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.workspace).toBe('codexes');
    expect(second.body.agent_kind).toBe('codex');
    expect(second.body.agent_role).toBe('attach');
    expect(second.body.agent_session_name).toBe('codex-b');
    expect(second.body.codex_role).toBe('attach');
    expect(second.body.codex_session_name).toBe('codex-b');
    expect(second.body.persistent).toBe(false);
    expect(second.body.exec_argv).toEqual(['tmux', '-L', 'codex', 'attach-session', '-t', 'codex-b']);
  });

  it('excludes codex sessions from normal /api/sessions', async () => {
    mockTmuxList('codex-a\t1\t0\n');

    await request(app).post('/api/agents/codex/attach').send({ name: 'codex-a' });
    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('creates and reuses a codex scratch shell', async () => {
    mockTmuxList('codex-a\t1\t0\n');

    const first = await request(app).post('/api/agents/codex/scratch').send({ selectedName: 'codex-a' });
    const second = await request(app).post('/api/agents/codex/scratch').send({ selectedName: 'codex-a' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.workspace).toBe('codexes');
    expect(second.body.agent_kind).toBe('codex');
    expect(second.body.agent_role).toBe('scratch');
    expect(second.body.codex_role).toBe('scratch');
    expect(second.body.persistent).toBe(false);
    expect(second.body.exec_argv).toEqual(['/bin/test-shell', '-l']);
    expect(second.body.exec_cwd).toBe(tmpDir);
  });

  it('falls back to /bin/sh for scratch shells when SHELL is unset', async () => {
    mockTmuxList('codex-a\t1\t0\n');
    delete process.env.SHELL;

    const res = await request(app).post('/api/agents/codex/scratch').send({ selectedName: 'codex-a' });

    expect(res.status).toBe(201);
    expect(res.body.exec_argv).toEqual(['/bin/sh', '-l']);
  });

  it('lists Claude sessions through the generic agent API', async () => {
    mockTmuxLists({ claude: 'claude-a\t1\t2\n' });

    const res = await request(app).get('/api/agents/claude/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      name: 'claude-a',
      kind: 'claude',
      display_name: 'a',
      windows: 1,
      attached: 2,
      status: 'unknown',
      status_source: 'none',
    }]);
  });

  it('returns an empty Copilot session list when the tmux socket has no server', async () => {
    mockTmuxLists({ copilot: new Error('error connecting to /tmp/tmux-1000/copilot (No such file or directory)') });

    const res = await request(app).get('/api/agents/copilot/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 503 when listing agent sessions fails unexpectedly', async () => {
    mockTmuxLists({ copilot: new Error('permission denied') });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await request(app).get('/api/agents/copilot/sessions');

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('Failed to list Copilot sessions');
      expect(res.body.error).not.toContain('permission denied');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects scratch shells for a selected session not present in tmux list', async () => {
    mockTmuxList('codex-a\t1\t0\n');

    const res = await request(app).post('/api/agents/codex/scratch').send({ selectedName: 'missing' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Codex session not found');
  });

  it('blocks shared agent sockets when local auth has multiple users', async () => {
    writeAuthConfig(
      'auth:\n' +
        '  mode: local\n' +
        '  users:\n' +
        '    - username: alice\n' +
        '      password_hash: hash\n' +
        '    - username: bob\n' +
        '      password_hash: hash\n',
    );
    const { signToken } = require('@backend/middleware/auth');
    const token = signToken('alice');

    const list = await request(app).get('/api/agents/codex/sessions').set('Authorization', `Bearer ${token}`);
    const combinedList = await request(app).get('/api/agents/sessions').set('Authorization', `Bearer ${token}`);
    const attach = await request(app).post('/api/agents/codex/attach').set('Authorization', `Bearer ${token}`).send({ name: 'codex-a' });

    expect(list.status).toBe(403);
    expect(combinedList.status).toBe(403);
    expect(attach.status).toBe(403);
    expect(list.body.error).toBe('Agent sessions are disabled in multi-user mode');
    expect(combinedList.body.error).toBe('Agent sessions are disabled in multi-user mode');
    expect(attach.body.error).toBe('Agent sessions are disabled in multi-user mode');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('creates and reuses Claude attach sessions without exposing them through normal sessions', async () => {
    mockTmuxLists({ claude: 'claude-a\t1\t0\n' });

    const first = await request(app).post('/api/agents/claude/attach').send({ name: 'claude-a', cols: 120, rows: 40 });
    const second = await request(app).post('/api/agents/claude/attach').send({ name: 'claude-a', cols: 120, rows: 40 });
    const sessions = await request(app).get('/api/sessions');

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.workspace).toBe('claudes');
    expect(second.body.agent_kind).toBe('claude');
    expect(second.body.agent_role).toBe('attach');
    expect(second.body.agent_session_name).toBe('claude-a');
    expect(second.body.exec_argv).toEqual(['tmux', '-L', 'claude', 'attach-session', '-t', 'claude-a']);
    expect(sessions.body).toEqual([]);
  });

  it('creates and reuses a Copilot scratch shell even when no Copilot sessions exist', async () => {
    mockTmuxLists({ copilot: '' });

    const first = await request(app).post('/api/agents/copilot/scratch').send({});
    const second = await request(app).post('/api/agents/copilot/scratch').send({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.workspace).toBe('copilots');
    expect(second.body.agent_kind).toBe('copilot');
    expect(second.body.agent_role).toBe('scratch');
    expect(second.body.persistent).toBe(false);
    expect(second.body.exec_argv).toEqual(['/bin/test-shell', '-l']);
  });
});
