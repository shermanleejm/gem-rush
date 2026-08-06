/**
 * Hosting a match from a browser tab.
 *
 * Runs the same authoritative `Room` the Node host runs — the simulation has no
 * idea which environment it is in, which is the whole reason `shared/` was kept
 * free of DOM and Node APIs. Guests arrive over WebRTC; the hosting player is
 * wired in through a loopback transport so they are just another client.
 */

import { Room, TICK_DT, decode, type ClientMessage } from '@squad-arena/shared';

import { PeerHost } from './peer.ts';
import { LoopbackTransport } from './transport.ts';

const LOCAL_KEY = 'local';

export interface BrowserHostHandlers {
  onReady: (code: string) => void;
  onError: (message: string) => void;
  onPeersChanged: (count: number) => void;
}

export class BrowserHost {
  readonly room: Room;
  readonly loopback: LoopbackTransport;
  private readonly peers: PeerHost;
  private timer: number | null = null;
  private lastTick = 0;

  constructor(private readonly handlers: BrowserHostHandlers) {
    this.room = new Room((playerId, msg) => this.route(playerId, msg));
    this.loopback = new LoopbackTransport((msg) => this.fromLocal(msg));

    this.peers = new PeerHost({
      onReady: (code) => handlers.onReady(code),
      onError: (m) => handlers.onError(m),
      onPeerJoin: () => handlers.onPeersChanged(this.peers.peerCount),
      onPeerLeave: (peerId) => {
        if (this.room.detach(peerId)) this.broadcastLobby();
        handlers.onPeersChanged(this.peers.peerCount);
      },
      onMessage: (peerId, data) => this.fromPeer(peerId, data),
    });
  }

  get code(): string {
    return this.peers.code;
  }

  start(): void {
    this.peers.start();

    // The host tab owns the clock. A short interval with an accumulator inside
    // Room.advance keeps ticks fixed even though browser timers are imprecise
    // and get throttled when the tab is backgrounded.
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;
      this.room.advance(dt);
    }, Math.max(4, Math.round((TICK_DT * 1000) / 4)));
  }

  /**
   * Signal the loopback transport that it is live.
   *
   * Called *after* the hosting tab's Connection has attached its handlers.
   * Opening in `start()` fired the open callback before anything was listening,
   * so the host's own `hello` was dropped and its lobby never appeared.
   */
  openLocalClient(): void {
    this.loopback.open();
  }

  /** Deliver a Room message to whichever transport that player is on. */
  private route(playerId: number, msg: unknown): void {
    const key = this.room.keyFor(playerId);
    if (key === LOCAL_KEY) {
      this.loopback.deliver(msg);
    } else if (key !== undefined) {
      this.peers.send(key, typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
  }

  private ingest(key: string, msg: ClientMessage): void {
    if (this.room.handle(key, msg)) this.broadcastLobby();
  }

  private fromLocal(msg: unknown): void {
    this.ingest(LOCAL_KEY, msg as ClientMessage);
  }

  private fromPeer(peerId: string, data: unknown): void {
    // PeerJS hands back parsed objects for JSON serialisation, strings
    // otherwise. Accept both rather than assuming.
    const msg = typeof data === 'string' ? decode<ClientMessage>(data) : (data as ClientMessage);
    if (!msg || typeof msg.t !== 'string') return;
    this.ingest(peerId, msg);
  }

  private broadcastLobby(): void {
    const payload = this.room.lobbyPayload();
    for (const member of this.room.members.values()) this.route(member.id, payload);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.peers.close();
  }
}
