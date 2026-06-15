import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import { api } from '../utils/api';
import type { AgentKind, AgentTmuxSession, ConnectionState, NamedTheme, Session } from '../types';

interface AgentWorkspaceProps {
  agentKind: AgentKind;
  fontSize: number;
  termCols: number;
  termRows: number;
  themes: NamedTheme[];
  globalTheme: string | null;
}

interface AgentConfig {
  label: string;
  pluralLabel: string;
  badge: string;
  layoutTestId: string;
}

const AGENTS: Record<AgentKind, AgentConfig> = {
  codex: { label: 'Codex', pluralLabel: 'Codexes', badge: 'CODEX', layoutTestId: 'codex-layout' },
  claude: { label: 'Claude', pluralLabel: 'Claudes', badge: 'CLAUDE', layoutTestId: 'claude-layout' },
  copilot: { label: 'Copilot', pluralLabel: 'Copilots', badge: 'COPILOT', layoutTestId: 'copilot-layout' },
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
        />
      </div>
    </div>
  );
}

export function AgentWorkspace({ agentKind, fontSize, termCols, termRows, themes, globalTheme }: AgentWorkspaceProps) {
  const agent = AGENTS[agentKind];
  const [agentSessions, setAgentSessions] = useState<AgentTmuxSession[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [attachedSession, setAttachedSession] = useState<Session | null>(null);
  const [scratchSession, setScratchSession] = useState<Session | null>(null);
  const [scratchVisible, setScratchVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attachLoading, setAttachLoading] = useState(false);
  const [scratchLoading, setScratchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachRequestRef = useRef(0);

  const activeTheme = themes.find(theme => theme.name === globalTheme);

  const deleteAgentSession = useCallback((sessionId: string) => {
    api.deleteSession(sessionId).catch(err => {
      console.error(`Failed to delete ${agentKind} session ${sessionId}:`, err);
    });
  }, [agentKind]);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await api.getAgentSessions(agentKind);
      setAgentSessions(loaded);
      setSelectedName(current => {
        if (current && loaded.some(session => session.name === current)) return current;
        return loaded[0]?.name ?? null;
      });
    } catch (err) {
      setError((err as Error).message);
      setAgentSessions([]);
      setSelectedName(null);
    } finally {
      setLoading(false);
    }
  }, [agentKind]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const attachSelected = useCallback(async (name: string) => {
    const requestId = ++attachRequestRef.current;
    setAttachLoading(true);
    setError(null);
    try {
      const session = await api.attachAgentSession(agentKind, { name, cols: termCols, rows: termRows });
      if (attachRequestRef.current === requestId) {
        setAttachedSession(session);
      }
    } catch (err) {
      if (attachRequestRef.current === requestId) {
        setError((err as Error).message);
        setAttachedSession(current => {
          if (current) {
            deleteAgentSession(current.id);
          }
          return null;
        });
        await loadSessions();
      }
    } finally {
      if (attachRequestRef.current === requestId) {
        setAttachLoading(false);
      }
    }
  }, [agentKind, loadSessions, termCols, termRows]);

  useEffect(() => {
    if (selectedName) {
      attachSelected(selectedName);
    } else {
      setAttachedSession(current => {
        if (current) {
          deleteAgentSession(current.id);
        }
        return null;
      });
    }
  }, [attachSelected, deleteAgentSession, selectedName]);

  const openScratch = useCallback(async () => {
    if (scratchLoading) return;
    setScratchVisible(true);
    setScratchLoading(true);
    setError(null);
    try {
      const session = await api.createAgentScratch(agentKind, {
        selectedName: selectedName ?? undefined,
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
  }, [agentKind, scratchLoading, selectedName, termCols, termRows]);

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
  const layoutFitTrigger = `${agentKind}:${selectedName ?? ''}:${showScratch ? 'split' : 'single'}`;

  return (
    <div style={styles.shell}>
      <div style={styles.sessionStrip}>
        {loading && <span style={styles.muted}>Loading...</span>}
        {!loading && agentSessions.length === 0 && !error && <span style={styles.muted}>No {agent.label} sessions</span>}
        {agentSessions.map(session => {
          const selected = session.name === selectedName;
          return (
            <button
              key={session.name}
              style={{
                ...styles.sessionButton,
                background: selected ? '#1f3f2c' : '#1a1a3a',
                borderColor: selected ? '#4aaa6a' : '#333366',
                color: selected ? '#e8fff0' : '#ccc',
              }}
              onClick={() => setSelectedName(session.name)}
              title={`${session.windows} window${session.windows === 1 ? '' : 's'}, ${session.attached} attached`}
            >
              <span style={{ color: selected ? '#50fa7b' : '#4aaa6a', fontSize: 8 }}>{'\u25cf'}</span>
              <span style={styles.sessionName}>{session.name}</span>
            </button>
          );
        })}
        <div style={styles.stripSpacer} />
        <button style={styles.stripButton} onClick={loadSessions} title={`Refresh ${agent.label} sessions`}>
          {'\u21bb'}
        </button>
        <button
          style={styles.stripButton}
          onClick={openScratch}
          disabled={scratchLoading || scratchVisible}
          title={showScratch ? 'Scratch shell open' : scratchVisible ? 'Scratch shell opening' : 'Open scratch shell'}
        >
          + Shell
        </button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div
        data-testid={agent.layoutTestId}
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
            agent={agent}
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
            agent={agent}
            fitTrigger={`${layoutFitTrigger}:scratch:${scratchSession.id}:${scratchSession.updated_at}`}
            onClose={closeScratch}
            closeTitle="Close scratch shell"
          />
        )}
        {!showScratch && scratchVisible && (
          <div style={styles.emptyPanel}>{loading || scratchLoading ? 'Opening scratch shell...' : 'Scratch shell unavailable'}</div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
    background: '#0d0d1a',
    color: '#e0e0e0',
  },
  sessionStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px',
    background: '#12122a',
    borderBottom: '1px solid #2a2a5a',
    flexShrink: 0,
    overflowX: 'auto',
  },
  sessionButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    border: '1px solid #333366',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap',
  },
  sessionName: {
    maxWidth: 260,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  stripSpacer: {
    flex: 1,
    minWidth: 12,
  },
  stripButton: {
    background: '#1a1a3a',
    border: '1px solid #333366',
    borderRadius: 4,
    color: '#ccc',
    cursor: 'pointer',
    fontSize: 12,
    padding: '5px 9px',
    whiteSpace: 'nowrap',
  },
  muted: {
    color: '#888',
    fontSize: 12,
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
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 30,
    padding: '0 8px',
    background: '#16163a',
    borderBottom: '1px solid #333366',
    flexShrink: 0,
  },
  panelTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  panelTitleText: {
    color: '#ddd',
    fontSize: 12,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  roleBadge: {
    color: '#8aa0ff',
    background: '#1a1a3a',
    borderRadius: 3,
    fontSize: 9,
    padding: '1px 4px',
  },
  closeButton: {
    background: 'transparent',
    border: 'none',
    color: '#ff8888',
    cursor: 'pointer',
    fontSize: 12,
    padding: '3px 5px',
  },
  terminalBody: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  emptyPanel: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 0,
    border: '1px dashed #333366',
    borderRadius: 6,
    color: '#777',
    fontSize: 13,
  },
};
