import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import express from 'express';
import request from 'supertest';

const mockExecFileSync = jest.fn();
const mockExecSync = jest.fn();

jest.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
  execSync: mockExecSync,
}));

describe('Codex API Routes', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalShell: string | undefined;
  let app: express.Express;
  let sessionBroker: any;
  let transportLauncher: any;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmux-codex-'));
    originalHome = process.env.WEBMUX_HOME;
    originalShell = process.env.SHELL;
    process.env.WEBMUX_HOME = tmpDir;
    process.env.SHELL = '/bin/test-shell';

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

    mockExecFileSync.mockReset();
    mockExecSync.mockReset();
    jest.resetModules();

    const { default: agentsRouter } = require('@backend/api/agents');
    const { default: codexRouter } = require('@backend/api/codex');
    const { default: sessionsRouter } = require('@backend/api/sessions');
    sessionBroker = require('@backend/services/sessionBroker').sessionBroker;
    transportLauncher = require('@backend/services/transportLauncher').transportLauncher;

    await sessionBroker.initialize();

    app = express();
    app.use(express.json());
    app.use('/api/agents', agentsRouter);
    app.use('/api/codex', codexRouter);
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockTmuxLists(outputs: Record<string, string | Error>) {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const socketIndex = args.indexOf('-L');
      const socket = socketIndex >= 0 ? args[socketIndex + 1] : 'default';
      if (args.includes('list-sessions')) {
        const output = outputs[socket];
        if (output instanceof Error) throw output;
        return output ?? '';
      }
      if (args.includes('display-message')) return tmpDir + '\n';
      return '';
    });
  }

  function mockTmuxList(output: string) {
    mockTmuxLists({ codex: output });
  }

  it('parses tmux sessions from GET /api/codex/sessions', async () => {
    mockTmuxList('codex-a\t1\t2\ncodex-b\t3\t0\n');

    const res = await request(app).get('/api/codex/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { name: 'codex-a', windows: 1, attached: 2 },
      { name: 'codex-b', windows: 3, attached: 0 },
    ]);
  });

  it('returns an empty list when tmux has no codex sessions', async () => {
    mockTmuxList('');

    const res = await request(app).get('/api/codex/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('rejects attach for a name not present in tmux list', async () => {
    mockTmuxList('codex-a\t1\t0\n');

    const res = await request(app).post('/api/codex/attach').send({ name: 'missing' });

    expect(res.status).toBe(404);
  });

  it('creates and reuses one codex attach session per tmux name', async () => {
    mockTmuxList('codex-a\t1\t0\n');

    const first = await request(app).post('/api/codex/attach').send({ name: 'codex-a', cols: 120, rows: 40 });
    const second = await request(app).post('/api/codex/attach').send({ name: 'codex-a', cols: 120, rows: 40 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.workspace).toBe('codexes');
    expect(second.body.agent_kind).toBe('codex');
    expect(second.body.agent_role).toBe('attach');
    expect(second.body.agent_session_name).toBe('codex-a');
    expect(second.body.codex_role).toBe('attach');
    expect(second.body.codex_session_name).toBe('codex-a');
    expect(second.body.persistent).toBe(false);
    expect(second.body.exec_argv).toEqual(['tmux', '-L', 'codex', 'attach-session', '-t', 'codex-a']);
  });

  it('excludes codex sessions from normal /api/sessions', async () => {
    mockTmuxList('codex-a\t1\t0\n');

    await request(app).post('/api/codex/attach').send({ name: 'codex-a' });
    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('creates and reuses a codex scratch shell', async () => {
    mockTmuxList('codex-a\t1\t0\n');

    const first = await request(app).post('/api/codex/scratch').send({ selectedName: 'codex-a' });
    const second = await request(app).post('/api/codex/scratch').send({ selectedName: 'codex-a' });

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

    const res = await request(app).post('/api/codex/scratch').send({ selectedName: 'codex-a' });

    expect(res.status).toBe(201);
    expect(res.body.exec_argv).toEqual(['/bin/sh', '-l']);
  });

  it('lists Claude sessions through the generic agent API', async () => {
    mockTmuxLists({ claude: 'claude-a\t1\t2\n' });

    const res = await request(app).get('/api/agents/claude/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'claude-a', windows: 1, attached: 2 }]);
  });

  it('returns an empty Copilot session list when the tmux socket has no server', async () => {
    mockTmuxLists({ copilot: new Error('no server') });

    const res = await request(app).get('/api/agents/copilot/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
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
