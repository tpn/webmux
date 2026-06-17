import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import { api } from '../utils/api';
import type { AgentKind, AgentRuntimeStatus, AgentTmuxSession, ConnectionState, NamedTheme, Session } from '../types';

interface AgentWorkspaceProps {
  agentKind?: AgentKind;
  fontSize: number;
  termCols: number;
  termRows: number;
  themes: NamedTheme[];
  globalTheme: string | null;
  onAgentAccessDenied?: () => void;
}

interface AgentConfig {
  label: string;
  pluralLabel: string;
  badge: string;
  layoutTestId: string;
}

type SortMode = 'recently-ready' | 'waiting-longest' | 'name-asc' | 'name-desc' | 'created-newest' | 'created-oldest';

const AGENTS: Record<AgentKind, AgentConfig> = {
  codex: { label: 'Codex', pluralLabel: 'Codexes', badge: 'CODEX', layoutTestId: 'codex-layout' },
  claude: { label: 'Claude', pluralLabel: 'Claudes', badge: 'CLAUDE', layoutTestId: 'claude-layout' },
  copilot: { label: 'Copilot', pluralLabel: 'Copilots', badge: 'COPILOT', layoutTestId: 'copilot-layout' },
};

const SORT_LABELS: Record<SortMode, string> = {
  'recently-ready': 'Recently ready',
  'waiting-longest': 'Waiting longest',
  'name-asc': 'Name A-Z',
  'name-desc': 'Name Z-A',
  'created-newest': 'Created newest',
  'created-oldest': 'Created oldest',
};

interface TerminalPanelProps {
  session: Session;
  fontSize: number;
  theme?: NamedTheme;
  agent: AgentConfig;
  fitTrigger: string;
  onClose?: () => void;
  closeTitle?: string;
}

function sessionKey(session: AgentTmuxSession): string {
  return `${session.kind}:${session.name}`;
}

function isoTime(value: string | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function relativeTime(value: string | undefined): string {
  const time = isoTime(value);
  if (!time) return 'No output seen';
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (deltaSeconds < 60) return 'Last output just now';
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `Last output ${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) return `Last output ${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `Last output ${deltaDays}d ago`;
}

function statusLabel(status: AgentRuntimeStatus): string {
  if (status === 'waiting') return 'Waiting for input';
  if (status === 'working') return 'Working';
  if (status === 'stale') return 'Stale';
  return 'Unknown';
}

function statusColor(status: AgentRuntimeStatus): string {
  if (status === 'waiting') return '#50fa7b';
  if (status === 'working') return '#5a9af7';
  if (status === 'stale') return '#caaa4a';
  return '#777';
}

function sortSessions(sessions: AgentTmuxSession[], sortMode: SortMode): AgentTmuxSession[] {
  const sorted = [...sessions];
  const byName = (a: AgentTmuxSession, b: AgentTmuxSession) =>
    a.display_name.localeCompare(b.display_name) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
  const byCreated = (a: AgentTmuxSession, b: AgentTmuxSession) =>
    isoTime(a.created_at) - isoTime(b.created_at) || byName(a, b);
  const byLastOutput = (a: AgentTmuxSession, b: AgentTmuxSession) =>
    isoTime(a.last_output_at) - isoTime(b.last_output_at) || byName(a, b);
  const waitingRank = (session: AgentTmuxSession) => session.status === 'waiting' ? 0 : 1;

  sorted.sort((a, b) => {
    if (sortMode === 'name-asc') return byName(a, b);
    if (sortMode === 'name-desc') return -byName(a, b);
    if (sortMode === 'created-newest') return -byCreated(a, b);
    if (sortMode === 'created-oldest') return byCreated(a, b);

    const waitingDiff = waitingRank(a) - waitingRank(b);
    if (waitingDiff) return waitingDiff;
    if (sortMode === 'waiting-longest') return byLastOutput(a, b);
    return -byLastOutput(a, b);
  });

  return sorted;
}

function useFlipListAnimation(listRef: React.RefObject<HTMLDivElement | null>, itemKeys: string[], enabled: boolean) {
  const previousRects = useRef<Map<string, DOMRect>>(new Map());

  useLayoutEffect(() => {
    const container = listRef.current;
    if (!container) return;

    const currentRects = new Map<string, DOMRect>();
    for (const element of Array.from(container.querySelectorAll<HTMLElement>('[data-session-key]'))) {
      const key = element.dataset.sessionKey;
      if (!key) continue;
      const nextRect = element.getBoundingClientRect();
      const previousRect = previousRects.current.get(key);
      currentRects.set(key, nextRect);

      if (enabled && previousRect) {
        const deltaY = previousRect.top - nextRect.top;
        if (Math.abs(deltaY) > 1) {
          element.animate(
            [
              { transform: `translateY(${deltaY}px)` },
              { transform: 'translateY(0)' },
            ],
            { duration: 180, easing: 'ease-out' },
          );
        }
      }
    }

    previousRects.current = currentRects;
  }, [enabled, itemKeys.join('|'), listRef]);
}

function TerminalPanel({ session, fontSize, theme, agent, fitTrigger, onClose, closeTitle }: TerminalPanelProps) {
  const [state, setState] = useState<ConnectionState>(session.state);
  const role = session.agent_role ?? session.codex_role;

  useEffect(() => {
    setState(session.state);
  }, [session.id, session.state]);

  return (
    <div style={styles.panel}>
      <div style={styles.panelChrome}>
        <div style={styles.panelTitle}>
          <span style={{ color: state === 'connected' ? '#4aaa6a' : state === 'error' ? '#ff5555' : '#caaa4a', fontSize: 9 }}>{'\u25cf'}</span>
          <span style={styles.panelTitleText}>{session.title}</span>
          {role === 'attach' && <span style={styles.roleBadge}>{agent.badge}</span>}
          {role === 'scratch' && <span style={styles.roleBadge}>SHELL</span>}
        </div>
        {onClose && (
          <button style={styles.closeButton} onClick={onClose} title={closeTitle || 'Close'}>
            {'\u2715'}
          </button>
        )}
      </div>
      <div style={styles.terminalBody}>
        <Terminal
          sessionId={session.id}
          fontSize={fontSize}
          state={state}
          autoScroll={true}
          onStateChange={setState}
          onViewerUpdate={() => {}}
          onFocusGained={() => {}}
          theme={theme?.theme}
          fitTrigger={fitTrigger}
          suppressDeviceAttributeResponses={role === 'attach'}
        />
      </div>
    </div>
  );
}

export function AgentWorkspace({ agentKind, fontSize, termCols, termRows, themes, globalTheme, onAgentAccessDenied }: AgentWorkspaceProps) {
  const combined = agentKind === undefined;
  const fixedAgent = agentKind ? AGENTS[agentKind] : null;
  const workspaceLabel = fixedAgent ? fixedAgent.pluralLabel : 'Agents';
  const layoutTestId = fixedAgent ? fixedAgent.layoutTestId : 'agents-layout';
  const [agentSessions, setAgentSessions] = useState<AgentTmuxSession[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [attachedSession, setAttachedSession] = useState<Session | null>(null);
  const [scratchSession, setScratchSession] = useState<Session | null>(null);
  const [scratchVisible, setScratchVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attachLoading, setAttachLoading] = useState(false);
  const [scratchLoading, setScratchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('recently-ready');
  const attachRequestRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sortModeRef = useRef<SortMode>(sortMode);
  sortModeRef.current = sortMode;

  const activeTheme = themes.find(theme => theme.name === globalTheme);
  const selectedSession = selectedKey ? agentSessions.find(session => sessionKey(session) === selectedKey) ?? null : null;
  const selectedAgentKind = selectedSession?.kind;
  const selectedAgentName = selectedSession?.name;
  const sortedSessions = useMemo(() => sortSessions(agentSessions, sortMode), [agentSessions, sortMode]);
  const sortedKeys = useMemo(() => sortedSessions.map(sessionKey), [sortedSessions]);
  useFlipListAnimation(listRef, sortedKeys, sortMode === 'recently-ready' || sortMode === 'waiting-longest');

  const deleteAgentSession = useCallback((sessionId: string) => {
    api.deleteSession(sessionId).catch(err => {
      console.error(`Failed to delete agent session ${sessionId}:`, err);
    });
  }, []);

  const clearAttachedSession = useCallback(() => {
    setAttachedSession(current => {
      if (current) {
        deleteAgentSession(current.id);
      }
      return null;
    });
  }, [deleteAgentSession]);

  const loadSessions = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading !== false;
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const loaded = !combined && agentKind ? await api.getAgentSessions(agentKind) : await api.getAllAgentSessions();
      setAgentSessions(loaded);
      setSelectedKey(current => {
        if (current && loaded.some(session => sessionKey(session) === current)) return current;
        const firstVisibleSession = sortSessions(loaded, sortModeRef.current)[0];
        return firstVisibleSession ? sessionKey(firstVisibleSession) : null;
      });
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'Agent sessions are disabled in multi-user mode') {
        onAgentAccessDenied?.();
      }
      if (showLoading) {
        setError(message);
        setAgentSessions([]);
        setSelectedKey(null);
        clearAttachedSession();
      } else {
        console.warn(`Failed to refresh ${workspaceLabel}:`, err);
      }
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [agentKind, clearAttachedSession, combined, onAgentAccessDenied, workspaceLabel]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!combined) return;
    const interval = window.setInterval(() => {
      loadSessions({ showLoading: false });
    }, 10000);
    return () => window.clearInterval(interval);
  }, [combined, loadSessions]);

  const attachSelected = useCallback(async (kind: AgentKind, name: string) => {
    const requestId = ++attachRequestRef.current;
    setAttachLoading(true);
    setError(null);
    try {
      const session = await api.attachAgentSession(kind, { name, cols: termCols, rows: termRows });
      if (attachRequestRef.current === requestId) {
        setAttachedSession(session);
      }
    } catch (err) {
      if (attachRequestRef.current === requestId) {
        setError((err as Error).message);
        clearAttachedSession();
        await loadSessions();
      }
    } finally {
      if (attachRequestRef.current === requestId) {
        setAttachLoading(false);
      }
    }
  }, [clearAttachedSession, loadSessions, termCols, termRows]);

  useEffect(() => {
    if (selectedAgentKind && selectedAgentName) {
      attachSelected(selectedAgentKind, selectedAgentName);
    } else {
      clearAttachedSession();
    }
  }, [attachSelected, clearAttachedSession, selectedAgentKind, selectedAgentName]);

  const openScratch = useCallback(async () => {
    if (scratchLoading) return;
    const scratchKind = selectedSession?.kind ?? agentKind;
    if (!scratchKind) return;
    setScratchVisible(true);
    setScratchLoading(true);
    setError(null);
    try {
      const session = await api.createAgentScratch(scratchKind, {
        selectedName: selectedSession?.kind === scratchKind ? selectedSession.name : undefined,
        cols: Math.max(40, Math.floor(termCols / 2)),
        rows: termRows,
      });
      setScratchSession(session);
    } catch (err) {
      setError((err as Error).message);
      setScratchSession(null);
      setScratchVisible(false);
    } finally {
      setScratchLoading(false);
    }
  }, [agentKind, scratchLoading, selectedSession, termCols, termRows]);

  const closeScratch = useCallback(async () => {
    const session = scratchSession;
    if (!session) return;

    setScratchVisible(false);
    setScratchSession(null);
    setError(null);
    try {
      await api.deleteSession(session.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [scratchSession]);

  const showScratch = scratchVisible && scratchSession;
  const reserveScratch = scratchVisible || scratchLoading;
  const layoutFitTrigger = `${fixedAgent ? agentKind : 'agents'}:${selectedKey ?? ''}:${showScratch ? 'split' : 'single'}`;
  const attachedAgent = attachedSession?.agent_kind ? AGENTS[attachedSession.agent_kind] : selectedSession ? AGENTS[selectedSession.kind] : AGENTS.codex;
  const scratchAgent = scratchSession?.agent_kind ? AGENTS[scratchSession.agent_kind] : selectedSession ? AGENTS[selectedSession.kind] : AGENTS.codex;

  return (
    <div style={styles.shell}>
      <aside style={styles.sidebar} data-testid="agent-session-list">
        <div style={styles.sidebarHeader}>
          <div>
            <div style={styles.sidebarTitle}>{workspaceLabel}</div>
            <div style={styles.sidebarSubtitle}>{loading ? 'Loading sessions' : `${agentSessions.length} session${agentSessions.length === 1 ? '' : 's'}`}</div>
          </div>
          <button style={styles.iconButton} onClick={() => loadSessions()} title={`Refresh ${workspaceLabel}`}>
            {'\u21bb'}
          </button>
        </div>

        <div style={styles.sidebarControls}>
          <select
            style={styles.sortSelect}
            value={sortMode}
            onChange={event => setSortMode(event.target.value as SortMode)}
            aria-label="Sort agent sessions"
          >
            {(Object.keys(SORT_LABELS) as SortMode[]).map(mode => (
              <option key={mode} value={mode}>{SORT_LABELS[mode]}</option>
            ))}
          </select>
          <button
            style={styles.shellButton}
            onClick={openScratch}
            disabled={scratchLoading || scratchVisible || (combined && !selectedSession)}
            title={showScratch ? 'Scratch shell open' : scratchVisible ? 'Scratch shell opening' : combined && !selectedSession ? 'Select a session first' : 'Open scratch shell'}
          >
            + Shell
          </button>
        </div>

        {loading && <div style={styles.emptyListText}>Loading...</div>}
        {!loading && agentSessions.length === 0 && !error && (
          <div style={styles.emptyListText}>No {fixedAgent ? fixedAgent.label : 'agent'} sessions</div>
        )}
        <div ref={listRef} style={styles.sessionList}>
          {sortedSessions.map(session => {
            const key = sessionKey(session);
            const selected = key === selectedKey;
            const agent = AGENTS[session.kind];
            return (
              <button
                key={key}
                data-session-key={key}
                data-testid="agent-session-row"
                style={{
                  ...styles.sessionRow,
                  ...(selected ? styles.sessionRowSelected : {}),
                }}
                onClick={() => setSelectedKey(key)}
                title={`${statusLabel(session.status)}; ${session.windows} window${session.windows === 1 ? '' : 's'}, ${session.attached} attached`}
              >
                <span style={{ ...styles.statusDot, background: statusColor(session.status) }} />
                <span style={styles.sessionText}>
                  <span style={styles.sessionTopLine}>
                    <span style={styles.sessionName}>{session.display_name}</span>
                    <span style={styles.kindBadge}>{agent.badge}</span>
                  </span>
                  <span style={styles.sessionMeta}>{relativeTime(session.last_output_at)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <main style={styles.main}>
        {error && <div style={styles.error}>{error}</div>}

        <div
          data-testid={layoutTestId}
          style={{
            ...styles.layout,
            gridTemplateColumns: reserveScratch ? 'minmax(0, 2fr) minmax(0, 1fr)' : 'minmax(0, 1fr)',
          }}
        >
          {attachedSession ? (
            <TerminalPanel
              session={attachedSession}
              fontSize={fontSize}
              theme={activeTheme}
              agent={attachedAgent}
              fitTrigger={`${layoutFitTrigger}:attach:${attachedSession.agent_session_name ?? attachedSession.codex_session_name ?? attachedSession.title}:${attachedSession.updated_at}`}
            />
          ) : (
            <div style={styles.emptyPanel}>{attachLoading ? 'Connecting...' : 'No session selected'}</div>
          )}
          {showScratch && (
            <TerminalPanel
              session={scratchSession}
              fontSize={fontSize}
              theme={activeTheme}
              agent={scratchAgent}
              fitTrigger={`${layoutFitTrigger}:scratch:${scratchSession.id}:${scratchSession.updated_at}`}
              onClose={closeScratch}
              closeTitle="Close scratch shell"
            />
          )}
          {!showScratch && scratchVisible && (
            <div style={styles.emptyPanel}>{loading || scratchLoading ? 'Opening scratch shell...' : 'Scratch shell unavailable'}</div>
          )}
        </div>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr)',
    minHeight: 0,
    height: '100%',
    background: '#0d0d1a',
    color: '#e0e0e0',
  },
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    borderRight: '1px solid #2a2a5a',
    background: '#12122a',
  },
  sidebarHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '10px 10px 8px',
    borderBottom: '1px solid #242452',
    flexShrink: 0,
  },
  sidebarTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: '#f0f0ff',
  },
  sidebarSubtitle: {
    color: '#888',
    fontSize: 11,
    marginTop: 2,
  },
  sidebarControls: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 6,
    padding: 10,
    borderBottom: '1px solid #242452',
    flexShrink: 0,
  },
  sortSelect: {
    minWidth: 0,
    background: '#1a1a3a',
    border: '1px solid #333366',
    borderRadius: 4,
    color: '#ddd',
    fontSize: 12,
    padding: '5px 7px',
  },
  shellButton: {
    background: '#1a1a3a',
    border: '1px solid #333366',
    borderRadius: 4,
    color: '#ccc',
    cursor: 'pointer',
    fontSize: 12,
    padding: '5px 9px',
    whiteSpace: 'nowrap',
  },
  iconButton: {
    background: '#1a1a3a',
    border: '1px solid #333366',
    borderRadius: 4,
    color: '#ccc',
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: 1,
    padding: '6px 8px',
  },
  emptyListText: {
    color: '#888',
    fontSize: 12,
    padding: 12,
  },
  sessionList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minHeight: 0,
    overflowY: 'auto',
    padding: 8,
  },
  sessionRow: {
    alignItems: 'center',
    background: '#171732',
    border: '1px solid #2e2e5f',
    borderRadius: 5,
    color: '#ddd',
    cursor: 'pointer',
    display: 'grid',
    gap: 8,
    gridTemplateColumns: '10px minmax(0, 1fr)',
    minHeight: 54,
    padding: '7px 8px',
    textAlign: 'left',
    width: '100%',
  },
  sessionRowSelected: {
    background: '#1f3f2c',
    border: '1px solid #4aaa6a',
    color: '#f2fff5',
  },
  statusDot: {
    borderRadius: '50%',
    boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.18)',
    display: 'inline-block',
    height: 8,
    width: 8,
  },
  sessionText: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
  },
  sessionTopLine: {
    alignItems: 'center',
    display: 'flex',
    gap: 6,
    minWidth: 0,
  },
  sessionName: {
    flex: '1 1 auto',
    fontSize: 13,
    fontWeight: 650,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  kindBadge: {
    background: '#22224a',
    border: '1px solid #38386c',
    borderRadius: 3,
    color: '#aaa',
    flex: '0 0 auto',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.2,
    padding: '2px 4px',
  },
  sessionMeta: {
    color: '#999',
    fontSize: 11,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
  },
  error: {
    color: '#ff8888',
    background: '#2a1018',
    borderBottom: '1px solid #552030',
    fontSize: 12,
    padding: '6px 10px',
  },
  layout: {
    display: 'grid',
    gap: 8,
    gridTemplateRows: 'minmax(0, 1fr)',
    alignItems: 'stretch',
    minHeight: 0,
    height: '100%',
    flex: 1,
    padding: 8,
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    height: '100%',
    border: '2px solid #333366',
    borderRadius: 6,
    overflow: 'hidden',
    background: '#0d0d1a',
  },
  panelChrome: {
    alignItems: 'center',
    background: '#171732',
    borderBottom: '1px solid #333366',
    display: 'flex',
    flexShrink: 0,
    justifyContent: 'space-between',
    minHeight: 30,
    padding: '4px 8px',
  },
  panelTitle: {
    alignItems: 'center',
    display: 'flex',
    gap: 6,
    minWidth: 0,
  },
  panelTitleText: {
    color: '#ddd',
    fontSize: 12,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  roleBadge: {
    background: '#22224a',
    border: '1px solid #38386c',
    borderRadius: 3,
    color: '#aaa',
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 5px',
  },
  closeButton: {
    background: '#2a1830',
    border: '1px solid #663366',
    borderRadius: 4,
    color: '#ddd',
    cursor: 'pointer',
    fontSize: 12,
    padding: '2px 6px',
  },
  terminalBody: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden',
  },
  emptyPanel: {
    alignItems: 'center',
    border: '1px dashed #333366',
    color: '#888',
    display: 'flex',
    fontSize: 13,
    justifyContent: 'center',
    minHeight: 0,
  },
};
