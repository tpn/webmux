import { useEffect, useState, type CSSProperties } from 'react';
import { isTerminalDebugEnabled, recordTerminalDebug, type TerminalDebugEvent } from '../utils/terminalDebug';

export function TerminalDebugPanel() {
  const [enabled] = useState(() => isTerminalDebugEnabled());
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<TerminalDebugEvent[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    recordTerminalDebug('debug-panel-enabled');
    const refresh = () => setEvents(window.webmuxTerminalDebug?.dump().slice(-80) ?? []);
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  if (!enabled) return null;

  const payload = JSON.stringify(events, null, 2);

  return (
    <div style={styles.shell}>
      <button
        style={styles.button}
        onClick={() => {
          setOpen(current => !current);
          setCopied(false);
        }}
      >
        Debug
      </button>
      {open && (
        <div style={styles.panel}>
          <div style={styles.header}>
            <span style={styles.title}>Terminal Timing</span>
            <button
              style={styles.smallButton}
              onClick={() => {
                window.webmuxTerminalDebug?.clear();
                setEvents([]);
                setCopied(false);
              }}
            >
              Clear
            </button>
            <button
              style={styles.smallButton}
              onClick={() => {
                navigator.clipboard?.writeText(payload).then(() => setCopied(true)).catch(() => setCopied(false));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <textarea readOnly value={payload} style={styles.textarea} />
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  shell: {
    position: 'fixed',
    right: 12,
    bottom: 12,
    zIndex: 1000,
    fontFamily: '"JetBrains Mono", Monaco, Consolas, Menlo, monospace',
  },
  button: {
    background: '#1a1a3a',
    border: '1px solid #4a8fba',
    borderRadius: 4,
    color: '#d8efff',
    cursor: 'pointer',
    fontSize: 12,
    padding: '5px 10px',
  },
  panel: {
    position: 'absolute',
    right: 0,
    bottom: 32,
    width: 'min(620px, calc(100vw - 24px))',
    height: 'min(380px, calc(100vh - 90px))',
    background: '#0d0d1a',
    border: '1px solid #333366',
    borderRadius: 6,
    boxShadow: '0 12px 36px rgba(0, 0, 0, 0.45)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: 8,
    borderBottom: '1px solid #333366',
  },
  title: {
    color: '#e0e0e0',
    flex: 1,
    fontSize: 12,
    fontWeight: 700,
  },
  smallButton: {
    background: '#1a1a3a',
    border: '1px solid #333366',
    borderRadius: 4,
    color: '#aaa',
    cursor: 'pointer',
    fontSize: 11,
    padding: '3px 8px',
  },
  textarea: {
    flex: 1,
    minHeight: 0,
    resize: 'none',
    background: '#050510',
    border: 0,
    color: '#d8efff',
    font: '11px "JetBrains Mono", Monaco, Consolas, Menlo, monospace',
    outline: 'none',
    padding: 8,
  },
};
