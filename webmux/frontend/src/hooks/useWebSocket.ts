import { useEffect, useRef, useCallback } from 'react';
import { buildWsUrl } from '../utils/api';
import type { WebSocketMessage } from '../types';
import { recordTerminalDebug } from '../utils/terminalDebug';

interface UseWebSocketOptions {
  sessionId: string;
  onMessage: (msg: WebSocketMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface WebSocketHandle {
  send: (msg: WebSocketMessage) => void;
  bufferedAmount: () => number;
  close: () => void;
}

const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export function useWebSocket(options: UseWebSocketOptions): WebSocketHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const closedRef = useRef(false);

  const { sessionId, onMessage, onOpen, onClose } = options;

  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { onOpenRef.current = onOpen; }, [onOpen]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    closedRef.current = false;
    attemptRef.current = 0;

    function connect() {
      if (closedRef.current) return;

      const url = buildWsUrl(sessionId);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
        recordTerminalDebug('ws-open', sessionId);
        onOpenRef.current?.();
      };

      ws.onclose = (event) => {
        if (closedRef.current) return;
        recordTerminalDebug('ws-close', sessionId, {
          code: event.code,
          reason: event.reason,
          bufferedAmount: ws.bufferedAmount,
        });
        onCloseRef.current?.();
        // 1000 = intentional close (component unmount, session deleted)
        if (event.code === 1000) return;
        const delay = Math.min(INITIAL_DELAY_MS * Math.pow(2, attemptRef.current), MAX_DELAY_MS);
        attemptRef.current++;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = (e) => {
        recordTerminalDebug('ws-error', sessionId, { bufferedAmount: ws.bufferedAmount });
        console.error('WebSocket error', e);
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(event.data) as WebSocketMessage;
          onMessageRef.current(msg);
        } catch {
          recordTerminalDebug('ws-malformed-message', sessionId, { chars: event.data.length });
          // ignore malformed messages
        }
      };
    }

    connect();

    return () => {
      closedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close(1000);
      wsRef.current = null;
    };
  }, [sessionId]);

  const send = useCallback((msg: WebSocketMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const bufferedAmount = useCallback(() => wsRef.current?.bufferedAmount ?? 0, []);

  const close = useCallback(() => {
    closedRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    wsRef.current?.close(1000);
  }, []);

  return { send, bufferedAmount, close };
}
