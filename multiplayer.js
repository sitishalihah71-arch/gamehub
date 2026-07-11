/* ============================================================
   multiplayer.js
   Serverless peer-to-peer multiplayer using WebRTC data channels
   via the PeerJS library. PeerJS uses its free public cloud
   "PeerServer" purely to exchange connection handshakes
   (that handshake channel itself runs over WebSocket) — after
   that hand-shake, ALL game traffic (inputs / state) travels
   directly browser-to-browser over an RTCDataChannel.

   No Node.js, Express, database, or custom backend is used or
   required. This file works from a plain static index.html.

   Topology: host-authoritative star network.
     - The room creator is the HOST. The host simulates the
       whole match and broadcasts world snapshots.
     - Joining players are CLIENTS. They send their input to the
       host every frame and render whatever snapshot they last
       received.
   ============================================================ */

const MAX_PLAYERS = 4;

// STUN alone can't traverse every NAT (symmetric NAT / restrictive firewalls,
// common on mobile networks and corporate Wi-Fi) — without a TURN relay,
// those peers can never complete the WebRTC handshake at all, which is why
// a 3rd/4th join could hang or fail while the first couple succeeded on
// friendlier networks. This is a free public relay suitable for a small
// project; swap in your own TURN credentials for production traffic.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
const PEER_CONFIG = { debug: 0, config: { iceServers: ICE_SERVERS } };

// A later joiner often needs slower TURN-relayed ICE negotiation than the
// first player or two, so a single short timeout was rejecting joins that
// would have succeeded given a bit more time — retry a few times instead.
const JOIN_TIMEOUT_MS = 8000;
const JOIN_MAX_ATTEMPTS = 3;

class NetworkManager {
  constructor() {
    this.peer = null;
    this.isHost = false;
    this.roomId = null;
    this.localId = null;

    // host-side: map peerId -> DataConnection
    this.connections = new Map();
    // client-side: connection to host
    this.hostConnection = null;

    // roster shared in the lobby: id -> {name, weapon, power, cosmetics, ready, isHost}
    this.roster = new Map();

    this._lastLoadout = null;     // {name, weapon, power, cosmetics} — resent on reconnect
    this._intentionalClose = false;
    this._failCurrentJoin = null; // settles the in-flight join promise on an immediate rejection (e.g. room full)

    // ----- event hooks (assigned by ui.js / game.js) -----
    this.onRosterChanged = null;
    this.onStart = null;          // (rosterArray) => void
    this.onRestart = null;
    this.onStateReceived = null;  // client: (snapshot) => void
    this.onInputReceived = null;  // host: (peerId, input) => void
    this.onPeerLeft = null;       // (peerId) => void
    this.onPeerRejoined = null;   // host: (peerId) => void — same peer id reconnected mid-match
    this.onError = null;          // (message) => void
    this.onOpen = null;           // (idOrRoom) => void
  }

  // ---------------------------------------------------------
  _makeRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  createRoom(playerName, weapon, power, cosmetics) {
    return new Promise((resolve, reject) => {
      const roomId = 'SD-' + this._makeRoomCode();
      this.peer = new Peer(roomId, PEER_CONFIG);
      this.isHost = true;
      this.roomId = roomId;

      this.peer.on('open', (id) => {
        this.localId = id;
        this.roster.set(id, { name: playerName, weapon, power, cosmetics: cosmetics || null, ready: false, isHost: true, id });
        this._emitRoster();
        if (this.onOpen) this.onOpen(id);
        resolve(id);
      });

      this.peer.on('connection', (conn) => this._handleIncomingConnection(conn));

      // The signaling *socket* can drop (brief Wi-Fi blip) without touching
      // already-established P2P data connections to players already in the
      // room — reconnect it so new players can still find/join the room.
      this.peer.on('disconnected', () => {
        if (!this._intentionalClose && this.peer) this.peer.reconnect();
      });

      this.peer.on('error', (err) => {
        const msg = this._friendlyError(err);
        if (this.onError) this.onError(msg);
        reject(msg);
      });
    });
  }

  joinRoom(roomId, playerName, weapon, power, cosmetics) {
    this.isHost = false;
    this.roomId = roomId;
    this._lastLoadout = { name: playerName, weapon, power, cosmetics: cosmetics || null };
    this._joined = false; // true only once we've actually received the roster (host accepted us)

    return new Promise((resolve, reject) => {
      this.peer = new Peer(PEER_CONFIG);

      this.peer.on('open', (id) => {
        this.localId = id;
        this._resolveJoin = resolve;
        this._connectToHost(0, (msg) => reject(msg));
      });

      this.peer.on('disconnected', () => {
        if (!this._intentionalClose && this.peer) this.peer.reconnect();
      });

      this.peer.on('error', (err) => reject(this._friendlyError(err)));
    });
  }

  // Opens the RTCDataConnection to the host and sends our join request. On
  // handshake timeout/error it retries a few times (JOIN_MAX_ATTEMPTS)
  // before finally giving up via onGiveUp. Once the channel is open we're
  // just waiting on the host's reply — 'roster' means accepted (see
  // _handleClientData), 'full' means rejected.
  _connectToHost(attempt, onGiveUp) {
    const conn = this.peer.connect(this.roomId, { reliable: true });
    this.hostConnection = conn;
    let handshakeSettled = false; // true once the channel opened (or we gave up trying to open it)

    // allowRetry=false is for unrecoverable rejections (host doesn't exist)
    // — no point burning JOIN_MAX_ATTEMPTS retries on those.
    const settleFail = (msg, allowRetry) => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      clearTimeout(failTimer);
      conn.close();
      if (allowRetry && attempt + 1 < JOIN_MAX_ATTEMPTS) {
        setTimeout(() => this._connectToHost(attempt + 1, onGiveUp), 400);
      } else if (onGiveUp) {
        onGiveUp(msg || ('Could not reach room "' + this.roomId + '". Check the code and try again.'));
      }
    };
    // Lets _handleClientData reject the outer join promise immediately on a
    // {type:'full'} reply, whether that arrives before or after the
    // handshake itself completed.
    this._failCurrentJoin = (msg) => {
      if (!handshakeSettled) { settleFail(msg, false); return; }
      if (onGiveUp) onGiveUp(msg);
    };

    const failTimer = setTimeout(() => settleFail(undefined, true), JOIN_TIMEOUT_MS);

    conn.on('open', () => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      clearTimeout(failTimer);
      const { name, weapon, power, cosmetics } = this._lastLoadout;
      conn.send({ type: 'join', name, weapon, power, cosmetics, id: this.localId });
      if (this.onOpen) this.onOpen(this.localId);
    });

    conn.on('data', (data) => this._handleClientData(data));

    conn.on('close', () => {
      clearTimeout(failTimer);
      if (this._intentionalClose) return;
      if (!handshakeSettled) { settleFail(undefined, true); return; }
      if (this._joined) {
        // We were fully in the room/match before this — a mid-session drop.
        // Try to resume as the same player (same Peer id).
        this._attemptReconnectToHost();
      } else if (onGiveUp) {
        // Channel opened but the host never actually accepted us (e.g.
        // rejected then closed) — a failed join, not something to loop on.
        onGiveUp('Could not join the room. Try again.');
      }
    });

    conn.on('error', (err) => {
      clearTimeout(failTimer);
      // "Room not found" is unrecoverable — retrying can't fix a host that
      // doesn't exist, so surface it immediately instead of burning retries.
      const allowRetry = !(err && err.type === 'peer-unavailable');
      settleFail(this._friendlyError(err), allowRetry);
    });
  }

  // Mid-match reconnect: reuses the same Peer/id, so the host recognizes us
  // as the same player and revives our existing state instead of treating
  // this as a brand-new joiner (see onPeerRejoined / game.js).
  _attemptReconnectToHost(retries = 4) {
    if (this._intentionalClose) return;
    if (retries <= 0) {
      if (this.onError) this.onError('Disconnected from host.');
      return;
    }
    const conn = this.peer.connect(this.roomId, { reliable: true });
    this.hostConnection = conn;
    const timer = setTimeout(() => conn.close(), 6000);

    conn.on('open', () => {
      clearTimeout(timer);
      const { name, weapon, power, cosmetics } = this._lastLoadout;
      conn.send({ type: 'join', name, weapon, power, cosmetics, id: this.localId, rejoin: true });
    });
    conn.on('data', (data) => this._handleClientData(data));
    conn.on('close', () => {
      clearTimeout(timer);
      if (this._intentionalClose) return;
      setTimeout(() => this._attemptReconnectToHost(retries - 1), 1200);
    });
    conn.on('error', () => clearTimeout(timer));
  }

  _friendlyError(err) {
    const type = err && err.type;
    if (type === 'peer-unavailable') return 'Room not found. Double-check the Room ID.';
    if (type === 'network') return 'Network error — check your connection.';
    if (type === 'disconnected') return 'Connection lost.';
    return 'Connection error: ' + (type || (err && err.message) || 'unknown');
  }

  // ---------------------- HOST SIDE -------------------------
  _handleIncomingConnection(conn) {
    conn.on('open', () => {
      if (this.connections.size >= MAX_PLAYERS - 1) {
        conn.send({ type: 'full' });
        setTimeout(() => conn.close(), 400);
        return;
      }
      this.connections.set(conn.peer, conn);

      conn.on('data', (data) => this._handleHostData(conn, data));
      conn.on('close', () => this._removePeer(conn.peer));
      conn.on('error', () => this._removePeer(conn.peer));
    });
  }

  _handleHostData(conn, data) {
    switch (data.type) {
      case 'join': {
        // A rejoin keeps whatever ready-state we already had for this id
        // instead of resetting it, since it's the same player resuming.
        const prevReady = this.roster.has(conn.peer) ? this.roster.get(conn.peer).ready : false;
        this.roster.set(conn.peer, {
          name: data.name, weapon: data.weapon, power: data.power, cosmetics: data.cosmetics || null,
          ready: data.rejoin ? prevReady : false, isHost: false, id: conn.peer,
        });
        this._broadcastRoster();
        this._emitRoster();
        if (data.rejoin && this.onPeerRejoined) this.onPeerRejoined(conn.peer);
        break;
      }
      case 'loadout':
        if (this.roster.has(conn.peer)) {
          const r = this.roster.get(conn.peer);
          r.weapon = data.weapon; r.power = data.power;
        }
        this._broadcastRoster();
        this._emitRoster();
        break;
      case 'cosmetics':
        if (this.roster.has(conn.peer)) this.roster.get(conn.peer).cosmetics = data.cosmetics;
        this._broadcastRoster();
        this._emitRoster();
        break;
      case 'ready':
        if (this.roster.has(conn.peer)) this.roster.get(conn.peer).ready = data.ready;
        this._broadcastRoster();
        this._emitRoster();
        break;
      case 'input':
        if (this.onInputReceived) this.onInputReceived(conn.peer, data.input);
        break;
      case 'leave':
        this._removePeer(conn.peer);
        break;
    }
  }

  _removePeer(peerId) {
    this.connections.delete(peerId);
    this.roster.delete(peerId);
    this._broadcastRoster();
    this._emitRoster();
    if (this.onPeerLeft) this.onPeerLeft(peerId);
  }

  setLocalLoadout(name, weapon, power) {
    if (this.roster.has(this.localId)) {
      const r = this.roster.get(this.localId);
      r.name = name; r.weapon = weapon; r.power = power;
    }
    if (this.isHost) { this._broadcastRoster(); this._emitRoster(); }
    else if (this.hostConnection) this.hostConnection.send({ type: 'loadout', weapon, power });
  }

  // Pushes an equipped-cosmetics change (from the Wardrobe, opened inside
  // the lobby) to every other player immediately — same broadcast pattern
  // as setLocalLoadout. Also updates _lastLoadout so a reconnect/rejoin
  // resends the current cosmetics instead of stale ones from initial join.
  setLocalCosmetics(cosmetics) {
    if (this._lastLoadout) this._lastLoadout.cosmetics = cosmetics;
    if (this.roster.has(this.localId)) this.roster.get(this.localId).cosmetics = cosmetics;
    if (this.isHost) { this._broadcastRoster(); this._emitRoster(); }
    else if (this.hostConnection) this.hostConnection.send({ type: 'cosmetics', cosmetics });
  }

  setLocalReady(ready) {
    if (this.isHost) {
      if (this.roster.has(this.localId)) this.roster.get(this.localId).ready = ready;
      this._broadcastRoster();
      this._emitRoster();
    } else if (this.hostConnection) {
      this.hostConnection.send({ type: 'ready', ready });
    }
  }

  startMatch(killTarget = 10) {
    if (!this.isHost) return;
    const list = Array.from(this.roster.values());
    this.broadcast({ type: 'start', roster: list, killTarget });
    if (this.onStart) this.onStart(list, killTarget);
  }

  restartMatch() {
    if (!this.isHost) return;
    this.broadcast({ type: 'restart' });
    if (this.onRestart) this.onRestart();
  }

  // Host -> all clients
  broadcast(msg) {
    for (const conn of this.connections.values()) {
      if (conn.open) conn.send(msg);
    }
  }

  sendState(snapshot) {
    this.broadcast({ type: 'state', snapshot });
  }

  _broadcastRoster() {
    this.broadcast({ type: 'roster', roster: Array.from(this.roster.values()) });
  }

  _emitRoster() {
    if (this.onRosterChanged) this.onRosterChanged(Array.from(this.roster.values()));
  }

  // ---------------------- CLIENT SIDE -------------------------
  _handleClientData(data) {
    switch (data.type) {
      case 'full':
        // Settle the in-flight join attempt immediately instead of letting
        // it sit around and retry a few times before finally timing out.
        if (this._failCurrentJoin) { const fn = this._failCurrentJoin; this._failCurrentJoin = null; fn('Room is full (max 4 players).'); }
        if (this.onError) this.onError('Room is full (max 4 players).');
        break;
      case 'host-left':
        if (this.onError) this.onError('Host left the room.');
        break;
      case 'roster':
        this.roster = new Map(data.roster.map(r => [r.id, r]));
        this._emitRoster();
        if (this._resolveJoin) { this._joined = true; this._resolveJoin(this.localId); this._resolveJoin = null; }
        break;
      case 'start':
        this.roster = new Map(data.roster.map(r => [r.id, r]));
        if (this.onStart) this.onStart(data.roster, data.killTarget);
        break;
      case 'restart':
        if (this.onRestart) this.onRestart();
        break;
      case 'state':
        if (this.onStateReceived) this.onStateReceived(data.snapshot);
        break;
    }
  }

  sendInput(input) {
    if (this.hostConnection && this.hostConnection.open) {
      this.hostConnection.send({ type: 'input', input });
    }
  }

  leave() {
    this._intentionalClose = true;
    try {
      if (this.isHost) {
        this.broadcast({ type: 'host-left' }); // best-effort notice
        for (const conn of this.connections.values()) conn.close();
      } else if (this.hostConnection) {
        this.hostConnection.send({ type: 'leave' });
        this.hostConnection.close();
      }
      if (this.peer) this.peer.destroy();
    } catch (e) { /* ignore */ }
    this.connections.clear();
    this.roster.clear();
    this.peer = null;
    this.hostConnection = null;
  }
}
