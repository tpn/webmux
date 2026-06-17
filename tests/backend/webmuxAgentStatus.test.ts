const execFileSyncMock = jest.fn();

jest.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
}));

describe('webmux-agent-status script', () => {
  let originalTmux: string | undefined;
  let originalCodexSocket: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    execFileSyncMock.mockReset();
    originalTmux = process.env.TMUX;
    originalCodexSocket = process.env.CODEX_TMUX_SOCKET;
    delete process.env.TMUX;
    delete process.env.CODEX_TMUX_SOCKET;
  });

  afterEach(() => {
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
    if (originalCodexSocket === undefined) {
      delete process.env.CODEX_TMUX_SOCKET;
    } else {
      process.env.CODEX_TMUX_SOCKET = originalCodexSocket;
    }
  });

  it('resolves pane sessions from the agent tmux socket before default tmux', () => {
    const { tmuxSessionFromPane } = require('../../webmux/scripts/webmux-agent-status.js');
    execFileSyncMock.mockReturnValue('codex-hiccup\n');

    expect(tmuxSessionFromPane('codex', '%1')).toBe('codex-hiccup');
    expect(execFileSyncMock).toHaveBeenCalledWith('tmux', [
      '-L',
      'codex',
      'display-message',
      '-p',
      '-t',
      '%1',
      '#S',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  });

  it('falls back to the TMUX socket path before default tmux', () => {
    process.env.TMUX = '/tmp/tmux-1000/codex,123,0';
    const { tmuxSessionFromPane } = require('../../webmux/scripts/webmux-agent-status.js');
    execFileSyncMock
      .mockImplementationOnce(() => {
        throw new Error('wrong socket');
      })
      .mockReturnValueOnce('codex-from-env\n');

    expect(tmuxSessionFromPane('codex', '%2')).toBe('codex-from-env');
    expect(execFileSyncMock.mock.calls[0][1]).toEqual([
      '-L',
      'codex',
      'display-message',
      '-p',
      '-t',
      '%2',
      '#S',
    ]);
    expect(execFileSyncMock.mock.calls[1][1]).toEqual([
      '-S',
      '/tmp/tmux-1000/codex',
      'display-message',
      '-p',
      '-t',
      '%2',
      '#S',
    ]);
  });
});
