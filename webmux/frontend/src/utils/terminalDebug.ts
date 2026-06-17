type TerminalDebugDetails = Record<string, unknown>;

export interface TerminalDebugEvent {
  at: number;
  kind: string;
  sessionId?: string;
  details?: TerminalDebugDetails;
}

interface TerminalDebugState {
  events: TerminalDebugEvent[];
  clear: () => void;
  dump: () => TerminalDebugEvent[];
}

declare global {
  interface Window {
    webmuxTerminalDebug?: TerminalDebugState;
  }
}

const MAX_EVENTS = 500;
const SLOW_WRITE_MS = 500;
const HIGH_BUFFERED_AMOUNT = 256 * 1024;
let initialized = false;
let enabled: boolean | null = null;
let sequence = 0;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function isTerminalDebugEnabled(): boolean {
  if (enabled !== null) return enabled;
  if (typeof window === 'undefined') {
    enabled = false;
    return enabled;
  }

  const params = new URLSearchParams(window.location.search);
  enabled = params.get('webmux_debug') === '1' || window.localStorage.getItem('webmux_terminal_debug') === '1';
  return enabled;
}

function initializeDebugState(): TerminalDebugState {
  if (!window.webmuxTerminalDebug) {
    const events: TerminalDebugEvent[] = [];
    window.webmuxTerminalDebug = {
      events,
      clear: () => { events.length = 0; },
      dump: () => events.slice(),
    };
  }

  if (!initialized) {
    initialized = true;
    const PerformanceObserverCtor = window.PerformanceObserver;
    if (PerformanceObserverCtor) {
      try {
        const observer = new PerformanceObserverCtor(list => {
          for (const entry of list.getEntries()) {
            recordTerminalDebug('browser-long-task', undefined, {
              durationMs: Math.round(entry.duration),
              startTime: Math.round(entry.startTime),
            });
          }
        });
        observer.observe({ type: 'longtask', buffered: true });
      } catch {
        // Some browsers expose PerformanceObserver but not longtask entries.
      }
    }
  }

  return window.webmuxTerminalDebug;
}

export function recordTerminalDebug(kind: string, sessionId?: string, details?: TerminalDebugDetails): void {
  if (!isTerminalDebugEnabled() || typeof window === 'undefined') return;
  const state = initializeDebugState();
  const event = { at: now(), kind, sessionId, details };
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);

  if (kind === 'output-write-end' && typeof details?.durationMs === 'number' && details.durationMs >= SLOW_WRITE_MS) {
    console.warn('[webmux] slow terminal output render', event);
  }
  if (kind === 'input-send' && typeof details?.bufferedAmount === 'number' && details.bufferedAmount >= HIGH_BUFFERED_AMOUNT) {
    console.warn('[webmux] websocket send backlog before terminal input', event);
  }
}

export function terminalDebugNow(): number {
  return now();
}

export function nextTerminalDebugSeq(): number | undefined {
  if (!isTerminalDebugEnabled()) return undefined;
  sequence += 1;
  return sequence;
}
