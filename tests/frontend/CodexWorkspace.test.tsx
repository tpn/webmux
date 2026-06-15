import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Session } from '@frontend/types';
import { CodexWorkspace } from '@frontend/components/CodexWorkspace';
import { AgentWorkspace } from '@frontend/components/AgentWorkspace';

const apiMock = vi.hoisted(() => ({
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

const defaultProps = {
  fontSize: 14,
  termCols: 120,
  termRows: 40,
  themes: [],
  globalTheme: null,
};

describe('CodexWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAgentSessions.mockResolvedValue([{ name: 'codex-a', windows: 1, attached: 0 }]);
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
  });

  it('clicking a codex button requests attach for that session', async () => {
    apiMock.getAgentSessions.mockResolvedValue([
      { name: 'codex-a', windows: 1, attached: 0 },
      { name: 'codex-b', windows: 1, attached: 2 },
    ]);
    apiMock.attachAgentSession
      .mockResolvedValueOnce(makeSession({ id: 'codex-session-a', title: 'codex-a', agent_session_name: 'codex-a', codex_session_name: 'codex-a' }))
      .mockResolvedValueOnce(makeSession({ id: 'codex-session-a', title: 'codex-b', agent_session_name: 'codex-b', codex_session_name: 'codex-b' }));

    render(<CodexWorkspace {...defaultProps} />);

    fireEvent.click(await screen.findByText('codex-b'));

    await waitFor(() => {
      expect(apiMock.attachAgentSession).toHaveBeenCalledWith('codex', { name: 'codex-b', cols: 120, rows: 40 });
    });
    expect(apiMock.deleteSession).not.toHaveBeenCalled();
    expect(await screen.findByTestId('terminal-codex-session-a')).toBeDefined();
    expect(screen.getAllByText('codex-b').length).toBeGreaterThan(1);
  });

  it('opens and closes a scratch shell in a side split', async () => {
    render(<CodexWorkspace {...defaultProps} />);

    await screen.findByTestId('terminal-codex-session-1');
    expect(screen.getByTestId('codex-layout')).toHaveStyle('grid-template-columns: minmax(0, 1fr)');

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
  });

  it('auto-selects a Claude session through the same workspace', async () => {
    apiMock.getAgentSessions.mockResolvedValue([{ name: 'claude-a', windows: 1, attached: 0 }]);
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
    expect(screen.getByText('CLAUDE')).toBeDefined();
  });

  it('shows an empty state when an agent has no sessions', async () => {
    apiMock.getAgentSessions.mockResolvedValue([]);

    render(<AgentWorkspace agentKind="copilot" {...defaultProps} />);

    expect(await screen.findByText('No Copilot sessions')).toBeDefined();
    expect(apiMock.attachAgentSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('copilot-layout')).toHaveStyle('grid-template-columns: minmax(0, 1fr)');

    fireEvent.click(screen.getByText('+ Shell'));

    await waitFor(() => {
      expect(apiMock.createAgentScratch).toHaveBeenCalledWith('copilot', { selectedName: undefined, cols: 60, rows: 40 });
    });
  });
});
