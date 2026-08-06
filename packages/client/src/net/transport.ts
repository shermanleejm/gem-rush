/**
 * How the client's `Connection` talks to whoever is authoritative.
 *
 * Three implementations, one interface:
 *  - `WebSocketTransport` — the Node host serves the bundle and the socket
 *  - `PeerTransport`      — a guest joining a browser-hosted room over WebRTC
 *  - `LoopbackTransport`  — the hosting tab talking to its own in-process Room
 *
 * The loopback case matters: the host is also a player, and routing their input
 * through a real network stack to reach a Room in the same tab would be absurd.
 * Making it a transport keeps `Connection` from needing to know it is the host.
 */

import { PeerGuest } from './peer.ts';

export interface Transport {
  send(msg: unknown): void;
  close(): void;
  /** Registered by Connection before the transport starts delivering. */
  onMessage: ((raw: string) => void) | null;
  onClose: (() => void) | null;
  onOpen: (() => void) | null;
}

export class WebSocketTransport implements Transport {
  onMessage: ((raw: string) => void) | null = null;
  onClose: (() => void) | null = null;
  onOpen: (() => void) | null = null;
  private ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.onOpen?.();
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.onMessage?.(ev.data);
    };
    this.ws.onclose = () => this.onClose?.();
    this.ws.onerror = () => {
      /* onclose always follows */
    };
  }

  send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * Direct hand-off between the hosting tab's client and its own Room.
 *
 * Messages are delivered on a microtask rather than synchronously: a
 * synchronous round trip would let `Connection` re-enter mid-send and makes the
 * local player behave differently from every remote one, which is exactly the
 * class of bug that only shows up for the host.
 */
export class LoopbackTransport implements Transport {
  onMessage: ((raw: string) => void) | null = null;
  onClose: (() => void) | null = null;
  onOpen: (() => void) | null = null;

  constructor(private readonly toHost: (msg: unknown) => void) {}

  open(): void {
    queueMicrotask(() => this.onOpen?.());
  }

  send(msg: unknown): void {
    queueMicrotask(() => this.toHost(msg));
  }

  /** Called by the host to push a message down to its own client. */
  deliver(msg: unknown): void {
    const raw = typeof msg === 'string' ? msg : JSON.stringify(msg);
    queueMicrotask(() => this.onMessage?.(raw));
  }

  close(): void {
    this.onClose?.();
  }
}

/**
 * A guest joining a browser-hosted room over WebRTC.
 *
 * Errors are surfaced through `onFail` rather than `onClose`, because a
 * connection that never opened and one that dropped mid-match need different
 * messages — "check the code" versus "the host left".
 */
export class PeerTransport implements Transport {
  onMessage: ((raw: string) => void) | null = null;
  onClose: (() => void) | null = null;
  onOpen: (() => void) | null = null;

  private guest: PeerGuest;

  constructor(code: string, onFail: (message: string) => void) {
    this.guest = new PeerGuest({
      onOpen: () => this.onOpen?.(),
      onMessage: (data) => {
        // PeerJS hands back parsed objects under JSON serialisation; Connection
        // wants raw text, so normalise here rather than in the parser.
        const raw = typeof data === 'string' ? data : JSON.stringify(data);
        this.onMessage?.(raw);
      },
      onClose: () => this.onClose?.(),
      onError: onFail,
    });
    this.guest.connect(code);
  }

  send(msg: unknown): void {
    this.guest.send(msg);
  }

  close(): void {
    this.guest.close();
  }
}
