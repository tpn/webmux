import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { Terminal } from '@frontend/components/Terminal';
import { InputBroadcastProvider } from '@frontend/contexts/InputBroadcastContext';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  close: vi.fn(),
  fitCalls: 0,
  openImmediately: false,
  resizeObserverCallback: undefined as (() => void) | undefined,
  wsOptions: undefined as { onMessage?: (msg: unknown) => void; onOpen?: () => void; onClose?: () => void } | undefined,
  terminal: undefined as { emitData: (data: string) => void } | undefined,
}));

vi.mock('@frontend/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn((options: { onMessage?: (msg: unknown) => void; onOpen?: () => void; onClose?: () => void }) => {
    mocks.wsOptions = options;
    if (mocks.openImmediately) {
      options.onOpen?.();
    }
    return { send: mocks.send, close: mocks.close };
  }),
}));

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    private resizeListeners: Array<(size: { cols: number; rows: number }) => void> = [];
    private dataListeners: Array<(data: string) => void> = [];
    private csiHandlers: Array<{ id: { final: string; prefix?: string }; handler: () => boolean }> = [];
    parser = {
      registerCsiHandler: (id: { final: string; prefix?: string }, handler: () => boolean) => {
        const entry = { id, handler };
        this.csiHandlers.push(entry);
        return {
          dispose: vi.fn(() => {
            const index = this.csiHandlers.indexOf(entry);
            if (index !== -1) this.csiHandlers.splice(index, 1);
          }),
        };
      },
    };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.terminal = this;
    }

    loadAddon(addon: { activate?: (terminal: MockTerminal) => void }) {
      addon.activate?.(this);
    }

    open() {}

    onData(listener: (data: string) => void) {
      this.dataListeners.push(listener);
      return { dispose: vi.fn() };
    }

    onResize(listener: (size: { cols: number; rows: number }) => void) {
      this.resizeListeners.push(listener);
      return { dispose: vi.fn() };
    }

    onBell() {
      return { dispose: vi.fn() };
    }

    attachCustomKeyEventHandler() {}
    focus() {}
    scrollToBottom() {}
    scrollToLine() {}
    write(data: string, callback?: () => void) {
      if (data.includes('\x1b[>c') && !this.dispatchCsi({ prefix: '>', final: 'c' })) {
        this.emitData('\x1b[>0;276;0c');
      }
      if (data.includes('\x1b[c') && !this.dispatchCsi({ final: 'c' })) {
        this.emitData('\x1b[?1;2c');
      }
      callback?.();
    }
    refresh() {}
    dispose() {}

    emitData(data: string) {
      for (const listener of this.dataListeners) listener(data);
    }

    emitResize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      for (const listener of this.resizeListeners) listener({ cols, rows });
    }

    private dispatchCsi(id: { final: string; prefix?: string }) {
      for (let i = this.csiHandlers.length - 1; i >= 0; i--) {
        const entry = this.csiHandlers[i];
        if (entry.id.final === id.final && entry.id.prefix === id.prefix && entry.handler()) {
          return true;
        }
      }
      return false;
    }
  }

  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    private terminal?: { emitResize: (cols: number, rows: number) => void };

    activate(terminal: { emitResize: (cols: number, rows: number) => void }) {
      this.terminal = terminal;
    }

    fit() {
      mocks.fitCalls++;
      this.terminal?.emitResize(132, 37);
    }
  }

  return { FitAddon };
});

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class WebLinksAddon {},
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class SearchAddon {
    onDidChangeResults() {}
    clearDecorations() {}
    findNext() {}
    findPrevious() {}
  },
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <InputBroadcastProvider>{children}</InputBroadcastProvider>
);

describe('Terminal', () => {
  beforeEach(() => {
    mocks.send.mockClear();
    mocks.close.mockClear();
    mocks.fitCalls = 0;
    mocks.openImmediately = false;
    mocks.resizeObserverCallback = undefined;
    mocks.wsOptions = undefined;
    mocks.terminal = undefined;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
    globalThis.ResizeObserver = class ResizeObserver {
      constructor(callback: () => void) {
        mocks.resizeObserverCallback = callback;
      }

      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it('sends fitted terminal size when the websocket opens', () => {
    render(
      <Terminal
        sessionId="session-1"
        fontSize={14}
        state="connected"
        autoScroll={true}
        onStateChange={vi.fn()}
        onViewerUpdate={vi.fn()}
        onFocusGained={vi.fn()}
      />,
      { wrapper },
    );

    expect(mocks.send).not.toHaveBeenCalled();
    mocks.wsOptions?.onOpen?.();

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({ type: 'resize', cols: 132, rows: 37 });
  });

  it('resends the current terminal size after websocket reconnect', () => {
    render(
      <Terminal
        sessionId="session-1"
        fontSize={14}
        state="connected"
        autoScroll={true}
        onStateChange={vi.fn()}
        onViewerUpdate={vi.fn()}
        onFocusGained={vi.fn()}
      />,
      { wrapper },
    );

    mocks.wsOptions?.onOpen?.();
    expect(mocks.send).toHaveBeenCalledWith({ type: 'resize', cols: 132, rows: 37 });

    mocks.send.mockClear();
    mocks.wsOptions?.onClose?.();
    mocks.wsOptions?.onOpen?.();

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({ type: 'resize', cols: 132, rows: 37 });
  });

  it('sends fitted terminal size after mount if the websocket opened first', () => {
    mocks.openImmediately = true;

    render(
      <Terminal
        sessionId="session-1"
        fontSize={14}
        state="connected"
        autoScroll={true}
        onStateChange={vi.fn()}
        onViewerUpdate={vi.fn()}
        onFocusGained={vi.fn()}
      />,
      { wrapper },
    );

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({ type: 'resize', cols: 132, rows: 37 });
  });

  it('sends resize messages for container refits after mount', () => {
    render(
      <Terminal
        sessionId="session-1"
        fontSize={14}
        state="connected"
        autoScroll={true}
        onStateChange={vi.fn()}
        onViewerUpdate={vi.fn()}
        onFocusGained={vi.fn()}
      />,
      { wrapper },
    );

    mocks.wsOptions?.onOpen?.();
    mocks.send.mockClear();
    act(() => {
      mocks.resizeObserverCallback?.();
    });

    expect(mocks.fitCalls).toBe(3);
    expect(mocks.send).toHaveBeenCalledWith({ type: 'resize', cols: 132, rows: 37 });
  });

  it('does not refit for the initial font size but refits when font size changes', () => {
    const props = {
      sessionId: 'session-1',
      state: 'connected' as const,
      autoScroll: true,
      onStateChange: vi.fn(),
      onViewerUpdate: vi.fn(),
      onFocusGained: vi.fn(),
    };

    const { rerender } = render(<Terminal {...props} fontSize={14} />, { wrapper });

    expect(mocks.fitCalls).toBe(1);
    mocks.wsOptions?.onOpen?.();

    rerender(<Terminal {...props} fontSize={14} />);
    expect(mocks.fitCalls).toBe(2);

    mocks.send.mockClear();
    rerender(<Terminal {...props} fontSize={16} />);

    expect(mocks.fitCalls).toBe(3);
    expect(mocks.send).toHaveBeenCalledWith({ type: 'resize', cols: 132, rows: 37 });
  });

  it('refits when the external fit trigger changes', () => {
    const props = {
      sessionId: 'session-1',
      fontSize: 14,
      state: 'connected' as const,
      autoScroll: true,
      onStateChange: vi.fn(),
      onViewerUpdate: vi.fn(),
      onFocusGained: vi.fn(),
    };

    const { rerender } = render(<Terminal {...props} fitTrigger="codex-a" />, { wrapper });
    mocks.wsOptions?.onOpen?.();
    expect(mocks.fitCalls).toBe(2);

    mocks.send.mockClear();
    rerender(<Terminal {...props} fitTrigger="codex-b" />);

    expect(mocks.fitCalls).toBe(3);
    expect(mocks.send).toHaveBeenCalledWith({ type: 'resize', cols: 132, rows: 37 });
  });

  it('suppresses xterm device-attribute replies when requested', () => {
    render(
      <Terminal
        sessionId="session-1"
        fontSize={14}
        state="connected"
        autoScroll={true}
        onStateChange={vi.fn()}
        onViewerUpdate={vi.fn()}
        onFocusGained={vi.fn()}
        suppressDeviceAttributeResponses={true}
      />,
      { wrapper },
    );

    act(() => {
      mocks.wsOptions?.onMessage?.({ type: 'output', data: '\x1b[>c' });
      mocks.wsOptions?.onMessage?.({ type: 'output', data: '\x1b[c' });
    });

    expect(mocks.send).not.toHaveBeenCalled();

    act(() => {
      mocks.terminal?.emitData('a');
    });

    expect(mocks.send).toHaveBeenCalledWith({ type: 'input', data: 'a' });
  });
});
