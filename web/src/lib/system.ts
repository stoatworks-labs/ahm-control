/**
 * The browser's link to the local server: one WebSocket, reconnecting, with the
 * whole system state pushed on every change.
 *
 * The server is the single source of truth. Nothing here keeps a shadow copy of
 * device state -- optimistic local edits are the server's job, because it is the
 * side that knows whether a value was confirmed by the unit.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SystemState, ZoneProcessing } from '../../../src/protocol/state.ts';
import type { StripRef } from '../../../src/protocol/addressing.ts';

export type Command =
  | { type: 'setLevel'; ref: string; level: number }
  | { type: 'setMute'; ref: string; muted: boolean }
  | { type: 'setSendLevel'; from: string; to: string; level: number }
  | { type: 'setSendMute'; from: string; to: string; muted: boolean }
  | { type: 'recallPreset'; preset: number }
  | { type: 'selectSource'; zone: number; source: number }
  | { type: 'rename'; ref: string; name: string }
  | { type: 'setPresetName'; preset: number; name: string }
  | { type: 'setProcessing'; zone: number; processing: Partial<ZoneProcessing> }
  | { type: 'connect'; host: string; port?: number; model?: number }
  | { type: 'disconnect' };

export function refId(ref: StripRef): string {
  return `${ref.kind}:${ref.index}`;
}

export interface SystemLink {
  state: SystemState | null;
  /** The browser's own link to the server, not the server's link to the AHM. */
  linkUp: boolean;
  send: (command: Command) => void;
}

export function useSystem(): SystemLink {
  const [state, setState] = useState<SystemState | null>(null);
  const [linkUp, setLinkUp] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;

    const open = () => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      socketRef.current = socket;

      socket.onopen = () => setLinkUp(true);
      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'state') setState(msg.state);
      };
      socket.onclose = () => {
        // Only disown the ref if it still points at THIS socket. A closing old
        // socket must not clear a newer one -- React StrictMode's double-mount
        // and any reconnect race both land here, and clobbering the live ref
        // leaves the UI receiving state while silently dropping every command.
        if (socketRef.current === socket) {
          socketRef.current = null;
          setLinkUp(false);
        }
        if (!closed) retry = window.setTimeout(open, 1000);
      };
      socket.onerror = () => socket.close();
    };

    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((command: Command) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
  }, []);

  return { state, linkUp, send };
}

/** Upload a System Manager .cfg file for parsing. */
export async function uploadConfig(file: File): Promise<Record<string, unknown>> {
  const response = await fetch('/api/config', { method: 'POST', body: await file.arrayBuffer() });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'could not read that file');
  return body;
}
