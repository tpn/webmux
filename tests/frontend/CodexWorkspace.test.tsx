import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { Session } from '@frontend/types';
import { CodexWorkspace } from '@frontend/components/CodexWorkspace';
import { AgentWorkspace } from '@frontend/components/AgentWorkspace';

const apiMock = vi.hoisted(() => ({
  getAllAgentSessions: vi.fn(),
  getAgentSessions: vi.fn(),
  attachAgentSession: vi.fn(),
  createAgentScratch: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock('@frontend/utils/api', () => ({
  api: apiMock,
}));

vi.mock('@frontend/components/Terminal', () => ({
  Terminal: ({ sessionId }: { sessionId: string }) => <div data-testid={`terminal-${sessionId}`}>Terminal {sessionId}</div>,
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'codex-session-1',
    kind: 'terminal',
    owner: 'anonymous',
    transport: 'exec',
    host_id: '',
    hostname: 'codex.local',
    port: 0,
    username: 'codex',
    key_id: '',
    cols: 120,
    rows: 40,
    row: 0,
    col: 0,
    state: 'connected',
    created_at: '',
    updated_at: '',
    title: 'codex-a',
    persistent: true,
    minimized: false,
    workspace: 'codexes',
    agent_kind: 'codex',
    agent_role: 'attach',
    agent_session_name: 'codex-a',
    codex_role: 'attach',
    codex_session_name: 'codex-a',
    ...overrides,
  };
}

function makeAgentSession(kind: 'codex' | 'claude' | 'copilot', name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    kind,
    display_name: name,
    windows: 1,
    attached: 0,
    created_at: '2026-06-14T22:08:55.000Z',
    last_output_at: '2026-06-17T20:00:00.000Z',
    status: 'waiting',
    status_source: 'hook',
    ...overrides,
  };
}

const defaultProps = {
  fontSize: 14,
  termCols: 120,
  termRows: 40,
  themes: [],
  globalTheme: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('CodexWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAllAgentSessions.mockResolvedValue([makeAgentSession('codex', 'codex-a')]);
    apiMock.getAgentSessions.mockResolvedValue([makeAgentSession('codex', 'codex-a')]);
    apiMock.attachAgentSession.mockResolvedValue(makeSession());
    apiMock.createAgentScratch.mockResolvedValue(makeSession({
      id: 'codex-scratch-1',
      title: 'Scratch shell',
      agent_role: 'scratch',
      agent_session_name: undefined,
      codex_role: 'scratch',
      codex_session_name: undefined,
    }));
    apiMock.deleteSession.mockResolvedValue(undefined);
  });

  it('auto-selects the first codex session and requests attach', async () => {
    render(<CodexWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(apiMock.attachAgentSession).toHaveBeenCalledWith('codex', { name: 'codex-a', cols: 120, rows: 40 });
    });
    expect(await screen.findByTestId('terminal-codex-session-1')).toBeDefined();
    expect(screen.getByTestId('codex-layout')).toHaveStyle('grid-template-columns: minmax(0, 1fr)');
    expect(apiMock.createAgentScratch).not.toHaveBeenCalled();
  });

  it('clicking a codex button requests attach for that session', async () => {
    apiMock.getAgentSessions.mockResolvedValue([
      makeAgentSession('codex', 'codex-a'),
      makeAgentSession('codex', 'codex-b', { attached: 2, last_output_at: '2026-06-17T19:00:00.000Z' }),
    ]);
    apiMock.attachAgentSession
      .mockResolvedValueOnce(makeSession({ id: 'codex-session-a', title: 'codex-a', agent_session_name: 'codex-a', codex_session_name: 'codex-a' }))
      .mockResolvedValueOnce(makeSession({ id: 'codex-session-b', title: 'codex-b', agent_session_name: 'codex-b', codex_session_name: 'codex-b' }));

    render(<CodexWorkspace {...defaultProps} />);

    expect(await screen.findByTestId('terminal-codex-session-a')).toBeDefined();
    fireEvent.click(screen.getByText('codex-b'));

    await waitFor(() => {
      expect(apiMock.attachAgentSession).toHaveBeenCalledWith('codex', { name: 'codex-b', cols: 120, rows: 40 });
    });
    expect(apiMock.deleteSession).not.toHaveBeenCalled();
    expect(await screen.findByTestId('terminal-codex-session-b')).toBeDefined();
    expect(screen.getAllByText('codex-b').length).toBeGreaterThan(1);
  });

  it('opens a scratch shell on demand and can close and reopen it', async () => {
    render(<CodexWorkspace {...defaultProps} />);

    await screen.findByTestId('terminal-codex-session-1');
    expect(screen.getByTestId('codex-layout')).toHaveStyle('grid-template-columns: minmax(0, 1fr)');
    expect(apiMock.createAgentScratch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('+ Shell'));

    await waitFor(() => {
      expect(apiMock.createAgentScratch).toHaveBeenCalledWith('codex', { selectedName: 'codex-a', cols: 60, rows: 40 });
    });
    expect(screen.getByTestId('codex-layout')).toHaveStyle('grid-template-columns: minmax(0, 2fr) minmax(0, 1fr)');
    expect(await screen.findByTestId('terminal-codex-scratch-1')).toBeDefined();

    fireEvent.click(screen.getByTitle('Close scratch shell'));

    await waitFor(() => {
      expect(apiMock.deleteSession).toHaveBeenCalledWith('codex-scratch-1');
    });
    expect(screen.getByTestId('codex-layout')).toHaveStyle('grid-template-columns: minmax(0, 1fr)');

    fireEvent.click(screen.getByText('+ Shell'));

    await waitFor(() => {
      expect(apiMock.createAgentScratch).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId('codex-layout')).toHaveStyle('grid-template-columns: minmax(0, 2fr) minmax(0, 1fr)');
  });

  it('does not create or reserve a scratch shell while sessions load', async () => {
    const sessions = deferred<ReturnType<typeof makeAgentSession>[]>();
    apiMock.getAgentSessions.mockReturnValue(sessions.promise);

    render(<CodexWorkspace {...defaultProps} />);

    expect(screen.getByTestId('codex-layout')).toHaveStyle('grid-template-columns: minmax(0, 1fr)');
    expect(screen.getByRole('button', { name: '+ Shell' })).toBeEnabled();
    expect(apiMock.createAgentScratch).not.toHaveBeenCalled();

    await act(async () => {
      sessions.resolve([makeAgentSession('codex', 'codex-a')]);
    });
    await waitFor(() => {
      expect(apiMock.attachAgentSession).toHaveBeenCalledWith('codex', { name: 'codex-a', cols: 120, rows: 40 });
    });
    await act(async () => {});

    expect(apiMock.createAgentScratch).not.toHaveBeenCalled();
  });

  it('auto-selects a Claude session through the same workspace', async () => {
    apiMock.getAgentSessions.mockResolvedValue([makeAgentSession('claude', 'claude-a')]);
    apiMock.attachAgentSession.mockResolvedValue(makeSession({
      id: 'claude-session-1',
      title: 'claude-a',
      workspace: 'claudes',
      agent_kind: 'claude',
      agent_session_name: 'claude-a',
      codex_role: undefined,
      codex_session_name: undefined,
    }));

    render(<AgentWorkspace agentKind="claude" {...defaultProps} />);

    await waitFor(() => {
      expect(apiMock.attachAgentSession).toHaveBeenCalledWith('claude', { name: 'claude-a', cols: 120, rows: 40 });
    });
    expect(await screen.findByTestId('terminal-claude-session-1')).toBeDefined();
    expect(screen.getAllByText('CLAUDE').length).toBeGreaterThan(0);
  });

  it('shows an empty state when an agent has no sessions', async () => {
    apiMock.getAgentSessions.mockResolvedValue([]);

    render(<AgentWorkspace agentKind="copilot" {...defaultProps} />);

    expect(await screen.findByText('No Copilot sessions')).toBeDefined();
    expect(apiMock.attachAgentSession).not.toHaveBeenCalled();
    expect(apiMock.createAgentScratch).not.toHaveBeenCalled();
    expect(screen.getByTestId('copilot-layout')).toHaveStyle('grid-template-columns: minmax(0, 1fr)');

    fireEvent.click(screen.getByText('+ Shell'));

    await waitFor(() => {
      expect(apiMock.createAgentScratch).toHaveBeenCalledWith('copilot', { selectedName: undefined, cols: 60, rows: 40 });
    });
    expect(screen.getByTestId('copilot-layout')).toHaveStyle('grid-template-columns: minmax(0, 2fr) minmax(0, 1fr)');
  });

  it('renders the combined Agents session list and attaches by selected kind and raw name', async () => {
    apiMock.getAllAgentSessions.mockResolvedValue([
      makeAgentSession('codex', 'codex-hiccup-2026-06-14-15-08-55', { display_name: 'hiccup' }),
      makeAgentSession('claude', 'claude-food-2026-06-14-16-32-59', { display_name: 'food' }),
    ]);
    apiMock.attachAgentSession
      .mockResolvedValueOnce(makeSession({
        id: 'codex-session-hiccup',
        title: 'codex-hiccup-2026-06-14-15-08-55',
        agent_session_name: 'codex-hiccup-2026-06-14-15-08-55',
        codex_session_name: 'codex-hiccup-2026-06-14-15-08-55',
      }))
      .mockResolvedValueOnce(makeSession({
        id: 'claude-session-food',
        title: 'claude-food-2026-06-14-16-32-59',
        workspace: 'claudes',
        agent_kind: 'claude',
        agent_session_name: 'claude-food-2026-06-14-16-32-59',
        codex_role: undefined,
        codex_session_name: undefined,
      }));

    render(<AgentWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(apiMock.attachAgentSession).toHaveBeenCalledWith('codex', {
        name: 'codex-hiccup-2026-06-14-15-08-55',
        cols: 120,
        rows: 40,
      });
    });
    expect(screen.getByTestId('agents-layout')).toHaveStyle('grid-template-columns: minmax(0, 1fr)');
    expect(screen.getByText('hiccup')).toBeDefined();
    expect(screen.getByText('food')).toBeDefined();

    fireEvent.click(screen.getByText('food'));

    await waitFor(() => {
      expect(apiMock.attachAgentSession).toHaveBeenCalledWith('claude', {
        name: 'claude-food-2026-06-14-16-32-59',
        cols: 120,
        rows: 40,
      });
    });
  });

  it('does not reattach the selected combined session when a refresh returns the same session', async () => {
    apiMock.getAllAgentSessions
      .mockResolvedValueOnce([
        makeAgentSession('codex', 'codex-hiccup-2026-06-14-15-08-55', {
          display_name: 'hiccup',
          last_output_at: '2026-06-17T20:00:00.000Z',
        }),
      ])
      .mockResolvedValueOnce([
        makeAgentSession('codex', 'codex-hiccup-2026-06-14-15-08-55', {
          display_name: 'hiccup',
          last_output_at: '2026-06-17T20:10:00.000Z',
        }),
      ]);

    render(<AgentWorkspace {...defaultProps} />);

    await waitFor(() => {
      expect(apiMock.attachAgentSession).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTitle('Refresh Agents'));

    await waitFor(() => {
      expect(apiMock.getAllAgentSessions).toHaveBeenCalledTimes(2);
    });
    expect(apiMock.attachAgentSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the active attached terminal when a combined background refresh fails', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval').mockImplementation(() => {
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      apiMock.getAllAgentSessions
        .mockResolvedValueOnce([
          makeAgentSession('codex', 'codex-hiccup-2026-06-14-15-08-55', { display_name: 'hiccup' }),
        ])
        .mockRejectedValueOnce(new Error('temporary failure'));
      apiMock.attachAgentSession.mockResolvedValue(makeSession({
        id: 'codex-session-hiccup',
        title: 'codex-hiccup-2026-06-14-15-08-55',
        agent_session_name: 'codex-hiccup-2026-06-14-15-08-55',
        codex_session_name: 'codex-hiccup-2026-06-14-15-08-55',
      }));

      render(<AgentWorkspace {...defaultProps} />);

      expect(await screen.findByTestId('terminal-codex-session-hiccup')).toBeDefined();
      const poll = setIntervalSpy.mock.calls.find(([, delay]) => delay === 10000)?.[0] as (() => void) | undefined;
      expect(poll).toBeDefined();

      await act(async () => {
        poll?.();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(apiMock.getAllAgentSessions).toHaveBeenCalledTimes(2);
      });
      expect(screen.getByText('hiccup')).toBeDefined();
      expect(screen.getByTestId('terminal-codex-session-hiccup')).toBeDefined();
      expect(apiMock.deleteSession).not.toHaveBeenCalled();
      expect(apiMock.attachAgentSession).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('clears the active attached terminal when a foreground refresh fails', async () => {
    apiMock.getAllAgentSessions
      .mockResolvedValueOnce([
        makeAgentSession('codex', 'codex-hiccup-2026-06-14-15-08-55', { display_name: 'hiccup' }),
      ])
      .mockRejectedValueOnce(new Error('list failed'));
    apiMock.attachAgentSession.mockResolvedValue(makeSession({
      id: 'codex-session-hiccup',
      title: 'codex-hiccup-2026-06-14-15-08-55',
      agent_session_name: 'codex-hiccup-2026-06-14-15-08-55',
      codex_session_name: 'codex-hiccup-2026-06-14-15-08-55',
    }));

    render(<AgentWorkspace {...defaultProps} />);

    expect(await screen.findByTestId('terminal-codex-session-hiccup')).toBeDefined();

    fireEvent.click(screen.getByTitle('Refresh Agents'));

    await waitFor(() => {
      expect(apiMock.getAllAgentSessions).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(apiMock.deleteSession).toHaveBeenCalledWith('codex-session-hiccup');
    });
    expect(screen.queryByTestId('terminal-codex-session-hiccup')).toBeNull();
    expect(screen.getByText('list failed')).toBeDefined();
    expect(apiMock.attachAgentSession).toHaveBeenCalledTimes(1);
  });

  it('sorts combined sessions with recently ready sessions first', async () => {
    apiMock.getAllAgentSessions.mockResolvedValue([
      makeAgentSession('codex', 'codex-old-2026-06-14-15-08-55', {
        display_name: 'old',
        last_output_at: '2026-06-14T20:00:00.000Z',
        status: 'waiting',
      }),
      makeAgentSession('codex', 'codex-new-2026-06-16-15-08-55', {
        display_name: 'new',
        last_output_at: '2026-06-17T20:00:00.000Z',
        status: 'waiting',
      }),
      makeAgentSession('claude', 'claude-active-2026-06-14-15-08-55', {
        display_name: 'active',
        last_output_at: '2026-06-17T20:30:00.000Z',
        status: 'working',
      }),
    ]);

    render(<AgentWorkspace {...defaultProps} />);

    await screen.findByText('new');
    await waitFor(() => {
      expect(apiMock.attachAgentSession).toHaveBeenCalledWith('codex', {
        name: 'codex-new-2026-06-16-15-08-55',
        cols: 120,
        rows: 40,
      });
    });
    let rows = screen.getAllByTestId('agent-session-row').map(row => row.textContent);
    expect(rows[0]).toContain('new');
    expect(rows[1]).toContain('old');
    expect(rows[2]).toContain('active');

    fireEvent.change(screen.getByLabelText('Sort agent sessions'), { target: { value: 'waiting-longest' } });

    rows = screen.getAllByTestId('agent-session-row').map(row => row.textContent);
    expect(rows[0]).toContain('old');
    expect(rows[1]).toContain('new');
    expect(rows[2]).toContain('active');
  });
});
