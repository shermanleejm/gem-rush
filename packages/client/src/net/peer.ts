/**
 * Serverless multiplayer over WebRTC.
 *
 * The game is hosted by a *browser tab* rather than a Node process, so the
 * whole thing can be served as static files from GitHub Pages with nobody
 * standing up a server. One player creates a room and their tab runs the
 * authoritative `Room` from the shared package — byte-for-byte the same
 * simulation the Node host runs. Everyone else connects to it by room code
 * over a WebRTC DataChannel.
 *
 * Signalling uses PeerJS's free public broker. That is a third party, but it
 * only introduces two peers to each other and carries no game traffic; once the
 * DataChannel is open the data path is genuinely peer-to-peer.
 *
 * Known limitation, surfaced rather than hidden: WebRTC needs STUN to discover
 * public addresses, and behind strict or symmetric NATs a pair needs a TURN
 * *relay* to connect at all. Public STUN is free; TURN is not, and there is no
 * free public TURN worth relying on. A minority of pairs will therefore fail to
 * connect, so `onError` reports it plainly instead of hanging on "Connecting…".
 */

import Peer, { type DataConnection } from 'peerjs';

/** Room codes are user-typed, so avoid glyphs that look alike. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
/** Namespaced so we never collide with another app on the shared broker. */
const PEER_PREFIX = 'squadarena-';

const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },
};

export function makeRoomCode(): string {
  let out = '';
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

export function normaliseCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** How long to wait for a DataChannel before calling it a NAT failure. */
const CONNECT_TIMEOUT_MS = 20000;

// ── host side ───────────────────────────────────────────────────────────────

export interface PeerHostHandlers {
  onPeerJoin: (peerId: string) => void;
  onPeerLeave: (peerId: string) => void;
  onMessage: (peerId: string, data: unknown) => void;
  onReady: (code: string) => void;
  onError: (message: string) => void;
}

/**
 * Hosts a room. Owns the PeerJS peer and one DataConnection per guest; it does
 * not know anything about the game, so the caller can drive `Room` with it.
 */
export class PeerHost {
  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>();
  readonly code: string;

  constructor(
    private readonly handlers: PeerHostHandlers,
    code = makeRoomCode(),
  ) {
    this.code = code;
  }

  start(): void {
    const peer = new Peer(PEER_PREFIX + this.code, PEER_CONFIG);
    this.peer = peer;

    peer.on('open', () => this.handlers.onReady(this.code));

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        this.conns.set(conn.peer, conn);
        this.handlers.onPeerJoin(conn.peer);
      });
      conn.on('data', (data) => this.handlers.onMessage(conn.peer, data));
      const drop = (): void => {
        if (!this.conns.delete(conn.peer)) return;
        this.handlers.onPeerLeave(conn.peer);
      };
      conn.on('close', drop);
      conn.on('error', drop);
    });

    peer.on('error', (err: Error & { type?: string }) => {
      // An ID collision means somebody already holds this room code; a fresh
      // code is a better answer than failing outright.
      if (err.type === 'unavailable-id') {
        this.handlers.onError('That room code is already taken. Reload to get a new one.');
        return;
      }
      this.handlers.onError(describePeerError(err));
    });
  }

  send(peerId: string, data: unknown): void {
    const conn = this.conns.get(peerId);
    if (conn?.open) conn.send(data);
  }

  broadcast(data: unknown): void {
    for (const conn of this.conns.values()) if (conn.open) conn.send(data);
  }

  get peerCount(): number {
    return this.conns.size;
  }

  close(): void {
    for (const conn of this.conns.values()) conn.close();
    this.conns.clear();
    this.peer?.destroy();
    this.peer = null;
  }
}

// ── guest side ──────────────────────────────────────────────────────────────

export interface PeerGuestHandlers {
  onOpen: () => void;
  onMessage: (data: unknown) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Joins a hosted room by code. */
export class PeerGuest {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private timeout: number | null = null;
  private settled = false;

  constructor(private readonly handlers: PeerGuestHandlers) {}

  connect(code: string): void {
    const peer = new Peer(PEER_CONFIG);
    this.peer = peer;

    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + normaliseCode(code), {
        reliable: true,
        // Ordered+reliable: snapshots are delta-encoded against the last one
        // acknowledged, so a dropped or reordered frame would desync the view.
        serialization: 'json',
      });
      this.conn = conn;

      conn.on('open', () => {
        this.settle();
        this.handlers.onOpen();
      });
      conn.on('data', (data) => this.handlers.onMessage(data));
      conn.on('close', () => this.handlers.onClose());
      conn.on('error', (err: Error) => this.fail(describePeerError(err)));
    });

    peer.on('error', (err: Error & { type?: string }) => {
      if (err.type === 'peer-unavailable') {
        this.fail(`No room found with that code. Check it and try again.`);
        return;
      }
      this.fail(describePeerError(err));
    });

    // WebRTC fails by hanging, not by erroring, when NAT traversal cannot find
    // a path. Without this the player stares at "Connecting…" forever.
    this.timeout = window.setTimeout(() => {
      this.fail(
        "Couldn't reach the host. This usually means one of your networks blocks " +
          'peer-to-peer connections. Try a different network, or have the host use ' +
          'the downloadable version.',
      );
    }, CONNECT_TIMEOUT_MS);
  }

  private settle(): void {
    this.settled = true;
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settle();
    this.handlers.onError(message);
  }

  send(data: unknown): void {
    if (this.conn?.open) this.conn.send(data);
  }

  close(): void {
    this.settle();
    this.conn?.close();
    this.peer?.destroy();
    this.conn = null;
    this.peer = null;
  }
}

function describePeerError(err: Error & { type?: string }): string {
  switch (err.type) {
    case 'browser-incompatible':
      return 'This browser does not support WebRTC. Try Chrome, Edge, Firefox or Safari.';
    case 'network':
      return 'Lost contact with the matchmaking service. Check your connection and reload.';
    case 'server-error':
      return 'The free matchmaking service is unreachable right now. Try again shortly.';
    case 'webrtc':
      return 'The peer-to-peer connection failed. Your network may block WebRTC.';
    default:
      return err.message || 'Connection failed.';
  }
}
