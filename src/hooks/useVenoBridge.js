/**
 * useVenoBridge.js
 *
 * Drop this file into your VenoApp PWA at: src/hooks/useVenoBridge.js
 *
 * Usage:
 *   const { isConnected, sendPrintJob, sendOrderEvent } = useVenoBridge();
 *
 *   // Send a print job (falls back silently if not connected)
 *   sendPrintJob(receiptPayload);
 *
 *   // Broadcast an order event (falls back to Supabase in your own code)
 *   const sent = sendOrderEvent("order:insert", orderPayload);
 *   if (!sent) { // do Supabase insert instead }
 */

import { useEffect, useRef, useState, useCallback } from "react";

const BRIDGE_WS_URL  = "ws://venobridge.local:3355";
const RECONNECT_MS   = 5_000;   // how long to wait before re-attempting
const PING_INTERVAL  = 20_000;  // heartbeat interval
const CONNECT_TIMEOUT = 3_000;  // give up on each connection attempt after this

/**
 * @returns {{
 *   isConnected: boolean,
 *   sendPrintJob: (receiptPayload: object) => boolean,
 *   sendOrderEvent: (type: string, payload: object) => boolean
 * }}
 */
export function useVenoBridge() {
  const wsRef        = useRef(null);
  const pingTimerRef = useRef(null);
  const reconnectRef = useRef(null);
  const mountedRef   = useRef(true);

  const [isConnected, setIsConnected] = useState(false);

  // ── Send a raw JSON message ─────────────────────────────────────────────────
  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }, []);

  // ── Public: send a print job ────────────────────────────────────────────────
  const sendPrintJob = useCallback(
    (receiptPayload) => send({ type: "print:receipt", payload: receiptPayload }),
    [send]
  );

  // ── Public: send an order event ─────────────────────────────────────────────
  const sendOrderEvent = useCallback(
    (type, payload) => send({ type, payload }),
    [send]
  );

  // ── Connection management ───────────────────────────────────────────────────
  const clearTimers = () => {
    clearInterval(pingTimerRef.current);
    clearTimeout(reconnectRef.current);
  };

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Bail if already open / connecting
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN ||
                     existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let connectTimeoutId;
    let ws;

    try {
      ws = new WebSocket(BRIDGE_WS_URL);
    } catch {
      // WebSocket constructor threw (e.g. invalid URL in some environments)
      scheduleReconnect();
      return;
    }

    wsRef.current = ws;

    // Hard timeout — if the connection hasn't opened within CONNECT_TIMEOUT ms,
    // close and retry.  This prevents a 30+ second browser TCP timeout.
    connectTimeoutId = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.close();
      }
    }, CONNECT_TIMEOUT);

    ws.onopen = () => {
      clearTimeout(connectTimeoutId);
      if (!mountedRef.current) { ws.close(); return; }
      setIsConnected(true);

      // Start heartbeat
      pingTimerRef.current = setInterval(() => {
        send({ type: "bridge:ping" });
      }, PING_INTERVAL);
    };

    ws.onclose = () => {
      clearTimeout(connectTimeoutId);
      clearTimers();
      if (!mountedRef.current) return;
      setIsConnected(false);
      wsRef.current = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror — just suppress the console noise
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Reserved for future inbound handling (e.g. order updates pushed from bridge)
        if (msg.type === "bridge:pong") {
          // heartbeat acknowledged — nothing to do
        }
      } catch {
        // ignore malformed messages
      }
    };
  }, [send]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    reconnectRef.current = setTimeout(connect, RECONNECT_MS);
  }, [connect]);

  // ── Mount / unmount ─────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      clearTimers();
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isConnected, sendPrintJob, sendOrderEvent };
}

export default useVenoBridge;
