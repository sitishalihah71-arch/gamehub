/* ============================================================
   game.js
   Orchestrates everything: the game loop, the arena, melee /
   projectile / ultimate hit-resolution (host side), snapshot
   application (client side), rendering, and wiring between the
   UIManager and the NetworkManager.
   ============================================================ */

const ARENA_W = 1280;
const ARENA_H = 720;
const DEFAULT_KILL_TARGET = 10;
const ITEM_PICKUP_RADIUS = 60;      // how close (px) a player must be to press P and collect
const ITEM_SPAWN_MIN = 10000;       // Feature 2: spawn every 10-20s
const ITEM_SPAWN_MAX = 20000;
const MAX_ITEMS_ON_MAP = 5;

// Feature 2: item type metadata used for spawning, rendering and pickup text
const ITEM_TYPES = {
  health: { label: 'Health +25', color: '#7dff8f' },
  sword: { label: 'Sword Upgrade Acquired', color: '#d7dbe4' },
  gun: { label: 'Gun Acquired', color: '#ffe27a' },
  rocket: { label: 'Rocket Launcher Acquired', color: '#ff8f5c' },
  shield: { label: 'Shield Acquired', color: '#69d9ff' },
};

const PLATFORMS = [ 
  { x: 0, y: 650, w: 1280, h: 70 }, // ground 
  { x: 160, y: 500, w: 180, h: 8 }, // left lower
  { x: 550, y: 520, w: 180, h: 8 }, // lower center
  { x: 940, y: 500, w: 180, h: 8 }, // lower right
  { x: 270, y: 340, w: 180, h: 8 }, // upper left
  { x: 550, y: 260, w: 180, h: 8 }, // upper center
  { x: 830, y: 340, w: 180, h: 8 }, // upper right
  { x: 560, y: 120, w: 120, h: 8 }, // secret floating platform ];
];

const SPAWN_POINTS = [
  { x: 110, y: 650 },
  { x: 1170, y: 650 },
  { x: 265, y: 480 },
  { x: 1015, y: 480 },
];

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

class Game {
  constructor(ui) {
    this.ui = ui;
    ui.game = this;
    ui._onCreateRoom = () => this.handleCreateRoom();
    ui._onJoinRoom = (code) => this.handleJoinRoom(code);
    ui._onLeave = () => this.handleLeave();

    this.canvas = document.getElementById('game-canvas');
    this.ctx = this.canvas.getContext('2d');

    this.players = new Map();
    this.projectiles = [];
    this.items = [];                 // Feature 2: {id, type, x, y}
    this.itemIdCounter = 0;
    this.itemSpawnTimer = this._randomSpawnDelay();
    this.effects = new EffectsManager();
    this.remoteInputBuffer = new Map(); // host only: peerId -> queued input
    this.localPlayerId = null;
    this.running = false;
    this.matchOver = false;
    this.matchEnding = false;        // Feature 1: true during the 5s victory-animation freeze
    this.winnerId = null;
    this.killTarget = DEFAULT_KILL_TARGET;

    this.lastKillEvent = null;       // Feature 1: {id, victim, killer}
    this._lastKillEventId = null;
    this._killEventCounter = 0;
    this.lastPickupEvent = null;     // Feature 3: {id, playerId, text}
    this._lastPickupEventId = null;
    this._victoryFxAccum = 0;
    this._winnerTimeoutHandle = null;

    // Match Coin Reward System: a small rolling queue of recent coin-reward
    // events (not a single dedup'd field like lastKillEvent) so a burst of
    // rapid kills can't drop a notification — the client processes every
    // new id it hasn't seen yet, which is what lets toasts stack correctly.
    this._matchCoinEvents = [];
    this._coinEventCounter = 0;
    this._lastCoinEventId = 0;

    this.heldKeys = new Set();
    this.justPressed = new Set();
    this._bindKeyboard();

    this._newNetwork();

    this.lastTime = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  }

  _newNetwork() {
    const net = new NetworkManager();
    this.net = net;
    this.ui.net = net;

    net.onOpen = (id) => { /* handled by caller flows */ };

    net.onRosterChanged = (roster) => {
      this.ui.updateLobby(roster, net.isHost, net.localId);
    };

    net.onStart = (roster, killTarget) => this.startMatch(roster, killTarget);
    net.onRestart = () => this.restartMatch();

    net.onStateReceived = (snapshot) => this.applySnapshot(snapshot);
    net.onInputReceived = (peerId, input) => this._bufferRemoteInput(peerId, input);

    net.onPeerLeft = (peerId) => {
      const p = this.players.get(peerId);
      if (p) { p.alive = false; p.health = 0; p.disconnected = true; }
      this.remoteInputBuffer.delete(peerId);
    };

    // Same peer id reconnected mid-match (see NetworkManager._attemptReconnectToHost)
    // — revive their existing Player instead of leaving them a permanent ghost.
    net.onPeerRejoined = (peerId) => {
      const p = this.players.get(peerId);
      if (!p) return;
      p.disconnected = false;
      p.alive = true;
      p.health = p.maxHealth;
      p.x = p.spawnX; p.y = p.spawnY;
      p.targetX = p.spawnX; p.targetY = p.spawnY;
      p.vx = 0; p.vy = 0;
      p.state = 'idle';
      p.invulnTimer = 1500;
    };

    net.onError = (msg) => {
      if (this.ui.screens.create.classList.contains('active')) this.ui.createStatus.textContent = msg;
      else if (this.ui.screens.join.classList.contains('active')) this.ui.joinStatus.textContent = msg;
      else this.ui.lobbyHint.textContent = msg;
    };
  }

  // ---------------------------------------------------------- flows
  handleCreateRoom() {
    this.net.createRoom(this.ui.localName, this.ui.selectedWeapon, this.ui.selectedPower, resolveEquippedCosmetics(this.ui.profile))
      .then((id) => {
        this.ui.setRoomCode(id);
        setTimeout(() => this.ui.goToLobby(), 300);
      })
      .catch((err) => { this.ui.createStatus.textContent = err; });
  }

  handleJoinRoom(code) {
    this.net.joinRoom(code, this.ui.localName, this.ui.selectedWeapon, this.ui.selectedPower, resolveEquippedCosmetics(this.ui.profile))
      .then(() => this.ui.goToLobby())
      .catch((err) => { this.ui.joinStatus.textContent = err; });
  }

  handleLeave() {
    this.net.leave();
    this.running = false;
    this.matchOver = true;
    this.matchEnding = false;
    clearTimeout(this._winnerTimeoutHandle);
    this.players.clear();
    this.projectiles = [];
    this.items = [];
    this._newNetwork();
  }

  // ---------------------------------------------------------- match lifecycle
  startMatch(rosterArray, killTarget) {
    this.players.clear();
    this.projectiles = [];
    this.items = [];
    this.itemSpawnTimer = this._randomSpawnDelay();
    this.remoteInputBuffer.clear();
    this.winnerId = null;
    this.matchOver = false;
    this.matchEnding = false;
    clearTimeout(this._winnerTimeoutHandle);
    this.killTarget = [10, 30, 50].includes(killTarget) ? killTarget : DEFAULT_KILL_TARGET;
    this.lastKillEvent = null; this._lastKillEventId = null; this._killEventCounter = 0;
    this.lastPickupEvent = null; this._lastPickupEventId = null;
    this._matchCoinEvents = []; this._coinEventCounter = 0; this._lastCoinEventId = 0;
    this.heldKeys.clear();
    this.justPressed.clear();

    rosterArray.forEach((r, i) => {
      const sp = SPAWN_POINTS[i % SPAWN_POINTS.length];
      const p = new Player(r.id, r.name, sp.x, sp.y, PLAYER_COLORS[i % 4], r.weapon, r.power);
      p.spawnX = sp.x; p.spawnY = sp.y;
      p.targetX = sp.x; p.targetY = sp.y;
      // Cosmetics were resolved locally (resolveEquippedCosmetics) and carried
      // in the roster the whole time the player sat in the lobby — apply them
      // now so they're visible from the very first frame of the match.
      p.cosmetics = r.cosmetics || null;
      this.players.set(r.id, p);
    });

    this.localPlayerId = this.net.localId;
    this.ui.buildHUD(Array.from(this.players.values()));
    this.ui.buildMatchHUD(this.killTarget);
    this.ui.showScreen('game');
    this.ui.flashBanner(`FIGHT! First to ${this.killTarget} kills wins`);
    this.running = true;
  }

  // Restart resets HP, ultimate gauge/cooldowns, weapons, position, all
  // cooldowns and clears item buffs/map items, per Feature 1.
  restartMatch() {
    this.projectiles = [];
    this.items = [];
    this.itemSpawnTimer = this._randomSpawnDelay();
    this.winnerId = null;
    this.matchOver = false;
    this.matchEnding = false;
    clearTimeout(this._winnerTimeoutHandle);
    this.lastKillEvent = null; this._lastKillEventId = null; this._killEventCounter = 0;
    this.lastPickupEvent = null; this._lastPickupEventId = null;
    this._matchCoinEvents = []; this._coinEventCounter = 0; this._lastCoinEventId = 0;

    // Bugfix: a Restart used to reset every disconnected flag to false,
    // silently reviving players who had actually left mid-match. Drop them
    // instead of respawning them.
    for (const [id, p] of this.players) {
      if (p.disconnected) this.players.delete(id);
    }

    let i = 0;
    for (const p of this.players.values()) {
      const sp = SPAWN_POINTS[i % SPAWN_POINTS.length];
      p.x = sp.x; p.y = sp.y; p.targetX = sp.x; p.targetY = sp.y;
      p.vx = 0; p.vy = 0;
      p.health = p.maxHealth;
      p.alive = true;
      p.score = 0;
      p.deaths = 0;
      p.matchCoins = 0;
      p.state = 'idle';
      p.victoryPoseId = null; // cosmetics themselves (p.cosmetics) are untouched by restart
      p.currentAttack = null;
      p.invulnTimer = 1200;
      // reset cooldowns / ultimate gauge
      p.attackCooldown = 0; p.heavyCooldown = 0; p.dashCooldown = 0;
      p.skillCooldown = 0; p.ultCooldown = 0; p.hitstunTimer = 0;
      p.comboCount = 0; p.comboResetTimer = 0;
      // reset weapon back to lobby loadout & clear item buffs
      p.weapon = new Weapon(p.baseWeaponId);
      p.previousWeapon = null;
      p.tempWeaponTimer = 0;
      p.shieldTimer = 0;
      p.ultTelegraph = null;
      i++;
    }
    this.ui.buildMatchHUD(this.killTarget);
    this.ui.showScreen('game');
    this.ui.flashBanner(`FIGHT! First to ${this.killTarget} kills wins`);
    this.running = true;
  }

  // ---------------------------------------------------------- input
  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (this._isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (['a', 'd', 'w', 'q', 'j', 'k', 'l', 'f', ' '].includes(k)) e.preventDefault();
      if (!this.heldKeys.has(k)) this.justPressed.add(k);
      this.heldKeys.add(k);
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.heldKeys.delete(k);
    });
  }

  _isTypingTarget(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  _buildLocalInput() {
    const k = this.heldKeys, jp = this.justPressed;
    const input = {
      left: k.has('a'),
      right: k.has('d'),
      jump: jp.has('w'),
      dash: jp.has(' '),
      attack: jp.has('j'),
      heavy: jp.has('k'),
      skill: jp.has('l'),
      ult: jp.has('q'),
      pickup: jp.has('f'),
    };
    jp.clear();
    return input;
  }

  _bufferRemoteInput(peerId, input) {
    let buf = this.remoteInputBuffer.get(peerId);
    if (!buf) { buf = { left: false, right: false, jumpQ: false, dashQ: false, attackQ: false, heavyQ: false, skillQ: false, ultQ: false, pickupQ: false }; this.remoteInputBuffer.set(peerId, buf); }
    buf.left = !!input.left;
    buf.right = !!input.right;
    buf.jumpQ = buf.jumpQ || !!input.jump;
    buf.dashQ = buf.dashQ || !!input.dash;
    buf.attackQ = buf.attackQ || !!input.attack;
    buf.heavyQ = buf.heavyQ || !!input.heavy;
    buf.skillQ = buf.skillQ || !!input.skill;
    buf.ultQ = buf.ultQ || !!input.ult;
    buf.pickupQ = buf.pickupQ || !!input.pickup;
  }

  // ---------------------------------------------------------- main loop
  _loop(now) {
    let dt = now - this.lastTime;
    this.lastTime = now;
    if (dt > 50) dt = 50; // clamp huge pauses (tab switch etc.)

    if (this.running) {
      const localInput = this._buildLocalInput();

      if (this.net.isHost) {
        const lp = this.players.get(this.localPlayerId);
        if (lp) Object.assign(lp.input, localInput);
        this._hostTick(dt);
      } else {
        this.net.sendInput(localInput);
        this._clientTick(dt);
      }
    } else if (this.matchEnding) {
      // Feature 1: movement/attacks are frozen (running === false) but we
      // keep playing a short victory particle animation for 5 seconds.
      this._victoryFxAccum += dt;
      if (this._victoryFxAccum >= 240) {
        this._victoryFxAccum = 0;
        const w = this.players.get(this.winnerId);
        if (w) this.effects.spawnElementalBurst(
          w.x + (Math.random() - 0.5) * 80, w.y - w.height - Math.random() * 60,
          w.power, 40, 14
        );
      }
      // Host ticks the winner's Victory Animation clock (reuses animTimer,
      // same as any other state-driven animation) and broadcasts it below —
      // clients never run _hostTick, so they'd otherwise never see it advance.
      if (this.net.isHost) {
        const winner = this.players.get(this.winnerId);
        if (winner) winner.animTimer += dt;
      }
    }

    // Broadcast state whenever there's something clients need to see — this
    // must NOT be nested inside `if (this.running)` above: a match-ending
    // kill flips `running` to false mid-tick, and previously that meant the
    // final snapshot carrying winnerId could be skipped entirely, leaving
    // clients stuck without ever finding out who won (see _onKill, which
    // also force-sends one immediately the instant the match ends).
    if (this.net.isHost && (this.running || this.matchEnding)) {
      this._broadcastSnapshot();
    }

    if (this.running || this.matchEnding) {
      this.effects.update(dt / 1000);
      this._render();
      this.ui.updateHUD(Array.from(this.players.values()));
      this.ui.updateMatchHUD(Array.from(this.players.values()), this.killTarget);
      this.ui.updateCooldowns(this.players.get(this.localPlayerId));
    }

    requestAnimationFrame((t) => this._loop(t));
  }

  // ---------------------------------------------------------- HOST simulation
  _hostTick(dt) {
    // pull remote inputs into their player.input
    for (const [id, p] of this.players) {
      if (id === this.localPlayerId || p.disconnected) continue;
      const buf = this.remoteInputBuffer.get(id);
      if (!buf) continue;
      p.input.left = buf.left; p.input.right = buf.right;
      p.input.jump = buf.jumpQ; p.input.dash = buf.dashQ;
      p.input.attack = buf.attackQ; p.input.heavy = buf.heavyQ;
      p.input.skill = buf.skillQ; p.input.ult = buf.ultQ;
      p.input.pickup = buf.pickupQ;
      buf.jumpQ = buf.dashQ = buf.attackQ = buf.heavyQ = buf.skillQ = buf.ultQ = buf.pickupQ = false;
    }

    // resolve skill / ultimate casts BEFORE physics update consumes the flags
    for (const p of this.players.values()) {
      if (!p.alive || p.disconnected) continue;
      if (p.input.skill && p.canAct() && !p.isBusyState() && p.skillCooldown <= 0) {
        if (p.requestSkill()) this._spawnSkillProjectile(p);
      }
      if (p.input.ult && p.canAct() && !p.isBusyState() && p.ultCooldown <= 0) {
        if (p.requestUltimate()) this._beginUltimateTelegraph(p);
      }
    }

    // physics + animation (also detects non-combat deaths, e.g. falling off the map)
    for (const p of this.players.values()) {
      if (p.disconnected) continue;
      const wasAlive = p.alive;
      p.update(dt, PLATFORMS, ARENA_W);
      if (wasAlive && !p.alive) { p.deaths += 1; this._announceDeath(p.name, null); }
    }

    // Feature 4: resolve any ultimate whose telegraph window has elapsed
    for (const p of this.players.values()) {
      if (p.ultTelegraph && p.ultTelegraph.msLeft !== undefined) {
        p.ultTelegraph.msLeft -= dt;
        if (p.ultTelegraph.msLeft <= 0) {
          p.ultTelegraph = null;
          this._resolveUltimate(p);
        }
      }
    }

    // spawn a projectile for ranged weapon pickups (gun/rocket) exactly once per swing
    for (const p of this.players.values()) {
      const ca = p.currentAttack;
      if (ca && p.weapon.isRanged && !ca.rangedSpawned) {
        ca.rangedSpawned = true;
        this._spawnWeaponProjectile(p, ca);
      }
    }

    // melee hit resolution (ranged-weapon attackers deal damage via projectiles instead)
    const list = Array.from(this.players.values());
    for (const attacker of list) {
      if (!attacker.alive || attacker.weapon.isRanged) continue;
      const hb = attacker.getActiveHitbox();
      if (!hb) continue;
      for (const defender of list) {
        if (defender === attacker || !defender.alive || defender.invulnTimer > 0) continue;
        const db = defender.getBounds();
        if (rectsOverlap(hb, db)) {
          attacker.markAttackHit();
          const died = defender.takeDamage(hb.dmg, attacker.x, hb.kb, null);
          this.effects.spawnHitSpark(defender.x, defender.y - defender.height * 0.6, '#ffe27a');
          this.effects.spawnDamageNumber(defender.x, defender.y - defender.height - 20, hb.dmg);
          if (died) this._onKill(attacker, defender);
        }
      }
    }

    // projectiles (elemental skills AND weapon pickups both reuse the Projectile class)
    for (const pr of this.projectiles) {
      pr.update(dt / 1000, this.effects);
      if (pr.dead) continue;
      for (const defender of list) {
        if (defender.id === pr.ownerId || !defender.alive || defender.invulnTimer > 0) continue;
        const db = defender.getBounds();
        const closestX = Math.max(db.x, Math.min(pr.x, db.x + db.w));
        const closestY = Math.max(db.y, Math.min(pr.y, db.y + db.h));
        const dx = pr.x - closestX, dy = pr.y - closestY;
        if (dx * dx + dy * dy <= pr.radius * pr.radius) {
          pr.dead = true;
          const died = defender.takeDamage(pr.damage, pr.x, 8, pr.power.statusOnHit);
          this.effects.spawnElementalBurst(defender.x, defender.y - defender.height * 0.5, pr.power, 50, 16);
          const attacker = this.players.get(pr.ownerId);
          if (died && attacker) this._onKill(attacker, defender);

          // Rocket Launcher splash damage (Feature 2), reusing the same takeDamage/_onKill path
          if (pr.splashRadius) {
            for (const other of list) {
              if (other === defender || other.id === pr.ownerId || !other.alive || other.invulnTimer > 0) continue;
              const d = Math.hypot(other.x - pr.x, other.y - pr.y);
              if (d <= pr.splashRadius) {
                const splashDied = other.takeDamage(Math.round(pr.damage * 0.5), pr.x, 6, null);
                this.effects.spawnHitSpark(other.x, other.y - other.height * 0.5, pr.power.color, 10);
                if (splashDied && attacker) this._onKill(attacker, other);
              }
            }
          }
        }
      }
      if (pr.x < -50 || pr.x > ARENA_W + 50) pr.dead = true;
    }
    this.projectiles = this.projectiles.filter(p => !p.dead);

    // Feature 2: periodic random item spawns
    this.itemSpawnTimer -= dt;
    if (this.itemSpawnTimer <= 0) {
      this._spawnRandomItem();
      this.itemSpawnTimer = this._randomSpawnDelay();
    }

    // Feature 3: pickup resolution (press P while standing near an item)
    for (const p of list) {
      if (!p.alive || !p.input.pickup || this.items.length === 0) continue;
      let closest = null, closestDist = Infinity;
      for (const it of this.items) {
        const d = Math.hypot(it.x - p.x, it.y - p.y);
        if (d <= ITEM_PICKUP_RADIUS && d < closestDist) { closest = it; closestDist = d; }
      }
      if (closest) {
        this.items = this.items.filter(it => it !== closest);
        this._applyItem(p, closest);
      }
    }
  }

  _spawnSkillProjectile(p) {
    const proj = new Projectile(p.id, p.x + p.facing * 24, p.y - p.height * 0.55, p.facing, p.power, false);
    this.projectiles.push(proj);
    this.effects.spawnElementalBurst(p.x + p.facing * 24, p.y - p.height * 0.55, p.power, 30, 10);
  }

  // Fires a bullet/rocket for gun & rocket pickups by reusing the Projectile
  // class with a small power-shaped object built from the weapon's stats
  // (Feature 2/3/6: reuse instead of duplicating projectile logic).
  _spawnWeaponProjectile(attacker, ca) {
    const w = attacker.weapon;
    const fakePower = { id: w.id, color: w.color, glow: w.accent, skillSpeed: w.projectileSpeed, skillRadius: w.projectileRadius, statusOnHit: null };
    const proj = new Projectile(attacker.id, attacker.x + attacker.facing * 24, attacker.y - attacker.height * 0.55, attacker.facing, fakePower, false);
    proj.damage = ca.damage;
    proj.splashRadius = w.splashRadius || 0;
    proj.isWeaponProjectile = true;
    this.projectiles.push(proj);
  }

  // Feature 4: show the ultimate's damage radius for a brief telegraph
  // window before the AoE actually resolves; the circle then disappears.
  _beginUltimateTelegraph(caster) {
    caster.ultTelegraph = { radius: caster.power.ultRadius, color: caster.power.color, msLeft: 380 };
  }

  _resolveUltimate(caster) {
    const power = caster.power;
    this.effects.spawnElementalBurst(caster.x, caster.y - caster.height * 0.5, power, power.ultRadius, 70);
    this.effects.flash(power.color, 0.5);
    for (const p of this.players.values()) {
      if (p === caster || !p.alive || p.invulnTimer > 0) continue;
      const dist = Math.hypot(p.x - caster.x, (p.y - p.height / 2) - (caster.y - caster.height / 2));
      if (dist <= power.ultRadius) {
        const died = p.takeDamage(power.ultDamage, caster.x, 15, power.statusOnHit);
        this.effects.spawnDamageNumber(p.x, p.y - p.height - 20, power.ultDamage, true);
        if (died) this._onKill(caster, p);
      }
    }
  }

  // Feature 1: large centered banner text whenever anyone dies (combat or otherwise)
  _announceDeath(victimName, killerName) {
    this.lastKillEvent = { id: ++this._killEventCounter, victim: victimName, killer: killerName };
    const text = killerName ? `${victimName} has been killed by ${killerName}` : `${victimName} fell to their doom`;
    this.ui.showKillBanner(text);
  }

  _onKill(attacker, defender) {
    attacker.score += 1;
    defender.deaths += 1;
    this.effects.spawnHitSpark(defender.x, defender.y - defender.height * 0.5, '#ff5c5c', 24);
    this._announceDeath(defender.name, attacker.name);
    this._awardCoins(attacker, 10, 'kill'); // Match Coin Reward System — instant floating toast for the killer

    if (attacker.score >= this.killTarget && !this.matchOver) {
      // Feature 1: freeze gameplay immediately, play a short victory
      // animation, then reveal the winner screen with Restart/Menu after 5s.
      this.matchOver = true;
      this.winnerId = attacker.id;
      this.running = false;
      this.matchEnding = true;
      this._victoryFxAccum = 0;
      // Kick off the winner's equipped Victory Animation — reuses state +
      // animTimer exactly like attack/skill/ult poses (see Player.draw).
      attacker.state = 'victory';
      attacker.animTimer = 0;
      attacker.victoryPoseId = (attacker.cosmetics && attacker.cosmetics.victory) ? attacker.cosmetics.victory.style : null;
      // End-of-match coin bonuses, tallied silently into matchCoins (no
      // floating toast — they're revealed on the Match Results screen
      // instead, which would otherwise be competing for attention with a
      // burst of "+10"/"+25" toasts right as the victory freeze kicks in).
      for (const p of this.players.values()) {
        if (p.disconnected) continue;
        this._awardCoins(p, 10, 'participation', false);
        if (p.id === attacker.id) this._awardCoins(p, 25, 'victory', false);
      }
      // Force-send the winning snapshot right now rather than waiting for
      // the next _loop tick's broadcast — guarantees every client learns
      // the match ended and who won, even if this exact tick is unlucky.
      this._broadcastSnapshot();
      clearTimeout(this._winnerTimeoutHandle);
      this._winnerTimeoutHandle = setTimeout(() => {
        this.matchEnding = false;
        const walletBefore = this.ui.profile.coins;
        this._awardMatchRewards();
        this.ui.showWinner(attacker, Array.from(this.players.values()), walletBefore);
      }, 5000);
    }
  }

  // Match Coin Reward System — the single source of truth for "coins earned
  // this match" (Player.matchCoins), consumed by both the floating toast
  // (notify=true, e.g. a kill) and the end-of-match summary/wallet deposit
  // (notify=false sources just tally silently). Host-authoritative: only
  // ever called from host-side code (_onKill), and matchCoins syncs to
  // clients via the snapshot like score/deaths already do — see
  // _buildSnapshot/applySnapshot. Adding a new coin source later (kill
  // streaks, match missions, ...) is just another call to this method.
  _awardCoins(player, amount, source, notify = true) {
    player.matchCoins += amount;
    if (!notify) return;
    this._coinEventCounter += 1;
    this._matchCoinEvents.push({ id: this._coinEventCounter, playerId: player.id, amount, source });
    if (this._matchCoinEvents.length > 20) this._matchCoinEvents.shift();
    // Host shows its own toast immediately (no network round-trip needed);
    // remote clients pick up the same event from the synced snapshot below.
    if (player.id === this.localPlayerId) this.ui.showCoinReward(amount);
  }

  // Coins/stats are tracked per-browser (PlayerProfile, cosmetics.js) with
  // no shared economy across peers, so every player — host and each client
  // alike — independently rewards their OWN profile based on their OWN
  // matchCoins total (kills + participation + victory bonus, all already
  // tallied via _awardCoins above) once their local view of the match
  // concludes. Called once from each of the two match-end paths below (host
  // via _onKill, clients via applySnapshot) right before the winner screen.
  _awardMatchRewards() {
    const me = this.players.get(this.localPlayerId);
    if (!me) return;
    this.ui.profile.awardMatchResult({
      won: this.winnerId === this.localPlayerId,
      kills: me.score,
      deaths: me.deaths,
      matchCoins: me.matchCoins,
    });
  }

  // ---------------------------------------------------------- items (Feature 2/3)
  _randomSpawnDelay() {
    return ITEM_SPAWN_MIN + Math.random() * (ITEM_SPAWN_MAX - ITEM_SPAWN_MIN);
  }

  _spawnRandomItem() {
    if (this.items.length >= MAX_ITEMS_ON_MAP) return;
    const plat = PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];
    const margin = 34;
    const usableW = Math.max(10, plat.w - margin * 2);
    const x = plat.x + margin + Math.random() * usableW;
    const y = plat.y; // sits exactly on the platform surface — never inside a wall or off-map
    const types = Object.keys(ITEM_TYPES);
    const type = types[Math.floor(Math.random() * types.length)];
    this.items.push({ id: 'it' + (this.itemIdCounter++), type, x, y });
  }

  _applyItem(player, item) {
    switch (item.type) {
      case 'health':
        player.health = Math.min(player.maxHealth, player.health + 25);
        break;
      case 'sword':
        player.weapon = makeUpgradedSword();
        player.previousWeapon = null;
        player.tempWeaponTimer = 0;
        break;
      case 'gun':
        this._equipTempWeapon(player, 'gun', 10000);
        break;
      case 'rocket':
        this._equipTempWeapon(player, 'rocket', 10000);
        break;
      case 'shield':
        player.shieldTimer = 8000;
        break;
    }
    this._announcePickup(player, ITEM_TYPES[item.type].label);
  }

  _equipTempWeapon(player, weaponId, durationMs) {
    if (!player.previousWeapon) player.previousWeapon = player.weapon;
    player.weapon = new Weapon(weaponId);
    player.tempWeaponTimer = durationMs;
  }

  _announcePickup(player, text) {
    this._pickupEventCounter = (this._pickupEventCounter || 0) + 1;
    this.lastPickupEvent = { id: this._pickupEventCounter, playerId: player.id, text };
    if (player.id === this.localPlayerId) this.ui.showPickupToast(text);
  }

  // ---------------------------------------------------------- snapshotting
  // Sends a snapshot and drains the coin-events queue. Safe to drain rather
  // than keep resending: NetworkManager connections are opened with
  // {reliable: true} (multiplayer.js), so a broadcast that goes out is
  // guaranteed to arrive — unlike lastKillEvent/lastPickupEvent's
  // resend-forever-until-superseded pattern, coinEvents doesn't need that
  // insurance, and draining keeps the payload from growing for the rest of
  // the match every time someone gets a kill.
  _broadcastSnapshot() {
    this.net.sendState(this._buildSnapshot());
    this._matchCoinEvents.length = 0;
  }

  // Positions/timers are rounded before going over the wire — sub-pixel and
  // sub-millisecond precision is invisible on screen but bloats the JSON
  // payload sent every broadcast tick.
  _buildSnapshot() {
    const r1 = (n) => Math.round(n * 10) / 10;
    const ri = (n) => Math.round(n);
    return {
      players: Array.from(this.players.values()).map(p => ({
        id: p.id, name: p.name, color: p.color,
        x: r1(p.x), y: r1(p.y), facing: p.facing, state: p.state,
        animTimer: ri(p.animTimer), animPhase: r1(p.animPhase),
        health: ri(p.health), maxHealth: p.maxHealth, alive: p.alive,
        weapon: p.weapon.id, weaponName: p.weapon.name, power: p.power.id,
        attackCooldown: ri(p.attackCooldown), heavyCooldown: ri(p.heavyCooldown),
        dashCooldown: ri(p.dashCooldown), skillCooldown: ri(p.skillCooldown), ultCooldown: ri(p.ultCooldown),
        score: p.score, deaths: p.deaths, matchCoins: p.matchCoins, invulnTimer: ri(p.invulnTimer),
        shieldTimer: ri(p.shieldTimer), tempWeaponTimer: ri(p.tempWeaponTimer),
        ultTelegraph: p.ultTelegraph ? { radius: p.ultTelegraph.radius, color: p.ultTelegraph.color } : null,
        currentAttack: p.currentAttack ? { type: p.currentAttack.type, duration: p.currentAttack.duration } : null,
        victoryPoseId: p.victoryPoseId,
      })),
      projectiles: this.projectiles.map(pr => ({ x: r1(pr.x), y: r1(pr.y), power: pr.power.id, ownerId: pr.ownerId })),
      items: this.items.map(it => ({ id: it.id, type: it.type, x: it.x, y: it.y })),
      killTarget: this.killTarget,
      lastKillEvent: this.lastKillEvent,
      lastPickupEvent: this.lastPickupEvent,
      // Last few coin-reward events (not just the latest one) — a rapid
      // multi-kill can generate more than one between broadcast ticks, and
      // clients only care about the ones they haven't already processed
      // (see applySnapshot's _lastCoinEventId watermark below). Sliced to a
      // fresh array: _broadcastSnapshot drains _matchCoinEvents right after
      // this returns, and since PeerJS sends can be deferred under
      // connection backpressure, a snapshot holding the *same* array
      // reference could see it emptied before it's actually transmitted.
      coinEvents: this._matchCoinEvents.slice(),
      winnerId: this.winnerId,
    };
  }

  applySnapshot(snap) {
    for (const ps of snap.players) {
      let p = this.players.get(ps.id);
      if (!p) {
        p = new Player(ps.id, ps.name, ps.x, ps.y, ps.color, ps.weapon, ps.power);
        this.players.set(ps.id, p);
      }
      p.targetX = ps.x; p.targetY = ps.y;
      if (p.x === undefined || Number.isNaN(p.x)) { p.x = ps.x; p.y = ps.y; }
      p.facing = ps.facing;
      p.state = ps.state;
      p.animTimer = ps.animTimer;
      p.animPhase = ps.animPhase;
      p.health = ps.health;
      p.maxHealth = ps.maxHealth;
      p.alive = ps.alive;
      if (!p.weapon || p.weapon.id !== ps.weapon) p.weapon = new Weapon(ps.weapon);
      p.weapon.name = ps.weaponName; // reflects "Sword+" upgrades without duplicating stats over the wire
      p.attackCooldown = ps.attackCooldown;
      p.heavyCooldown = ps.heavyCooldown;
      p.dashCooldown = ps.dashCooldown;
      p.skillCooldown = ps.skillCooldown;
      p.ultCooldown = ps.ultCooldown;
      p.invulnTimer = ps.invulnTimer;
      p.shieldTimer = ps.shieldTimer || 0;
      p.tempWeaponTimer = ps.tempWeaponTimer || 0;
      p.ultTelegraph = ps.ultTelegraph; // {radius,color} or null — Feature 4 render-only indicator
      p.score = ps.score;
      p.deaths = ps.deaths || 0;
      p.matchCoins = ps.matchCoins || 0;
      p.currentAttack = ps.currentAttack;
      p.victoryPoseId = ps.victoryPoseId || null;
    }
    this.projectiles = snap.projectiles.map(ps => ({
      x: ps.x, y: ps.y,
      radius: POWER_TYPES[ps.power] ? POWER_TYPES[ps.power].skillRadius : WEAPON_TYPES[ps.power].projectileRadius,
      power: POWER_TYPES[ps.power] || { color: WEAPON_TYPES[ps.power].color, glow: WEAPON_TYPES[ps.power].accent },
      draw: Projectile.prototype.draw,
    }));

    this.items = snap.items || [];
    if (snap.killTarget) this.killTarget = snap.killTarget;

    // Feature 1: large centered death banner, shown once per event via id dedup
    if (snap.lastKillEvent && snap.lastKillEvent.id !== this._lastKillEventId) {
      this._lastKillEventId = snap.lastKillEvent.id;
      const { victim, killer } = snap.lastKillEvent;
      this.ui.showKillBanner(killer ? `${victim} has been killed by ${killer}` : `${victim} fell to their doom`);
    }

    // Match Coin Reward System: process every event newer than the last one
    // we've seen (not just the latest, unlike the dedup'd fields above) so a
    // burst of rapid kills can't drop a toast — each new event belonging to
    // the local player pops its own stacking floating notification.
    if (snap.coinEvents && snap.coinEvents.length) {
      for (const ev of snap.coinEvents) {
        if (ev.id <= this._lastCoinEventId) continue;
        this._lastCoinEventId = ev.id;
        if (ev.playerId === this.localPlayerId) this.ui.showCoinReward(ev.amount);
      }
    }

    // Feature 3: pickup toast, shown only to the player who picked it up
    if (snap.lastPickupEvent && snap.lastPickupEvent.id !== this._lastPickupEventId) {
      this._lastPickupEventId = snap.lastPickupEvent.id;
      if (snap.lastPickupEvent.playerId === this.localPlayerId) this.ui.showPickupToast(snap.lastPickupEvent.text);
    }

    // Feature 1: freeze locally too, then reveal Restart/Menu after the same 5s animation window
    if (snap.winnerId && !this.matchOver) {
      this.matchOver = true;
      this.running = false;
      this.matchEnding = true;
      this.winnerId = snap.winnerId;
      this._victoryFxAccum = 0;
      const w = this.players.get(snap.winnerId);
      clearTimeout(this._winnerTimeoutHandle);
      this._winnerTimeoutHandle = setTimeout(() => {
        this.matchEnding = false;
        const walletBefore = this.ui.profile.coins;
        this._awardMatchRewards();
        this.ui.showWinner(w || null, Array.from(this.players.values()), walletBefore);
      }, 5000);
    }
  }

  _clientTick(dt) {
    // Higher multiplier = snappier catch-up to the host's authoritative
    // position. 16 took ~120ms to converge 90% of the way, which stacked
    // visibly on top of network RTT; 26 cuts that to ~65-70ms.
    const factor = Math.min(1, (dt / 1000) * 26);
    for (const p of this.players.values()) {
      if (p.targetX === undefined) continue;
      p.x += (p.targetX - p.x) * factor;
      p.y += (p.targetY - p.y) * factor;
    }
  }

  // ---------------------------------------------------------- render
  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, ARENA_W, ARENA_H);

    // sky backdrop
    const grad = ctx.createLinearGradient(0, 0, 0, ARENA_H);
    grad.addColorStop(0, '#1b2038');
    grad.addColorStop(1, '#0a0c16');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);

    // faint parallax circles (mountains/moon vibe)
    ctx.fillStyle = '#242a44';
    ctx.beginPath(); ctx.arc(1080, 130, 70, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#161a2e';
    ctx.beginPath(); ctx.moveTo(0, 640); ctx.lineTo(220, 500); ctx.lineTo(440, 640); ctx.fill();
    ctx.beginPath(); ctx.moveTo(700, 640); ctx.lineTo(980, 460); ctx.lineTo(1280, 640); ctx.fill();

    // platforms
    for (const plat of PLATFORMS) {
      ctx.fillStyle = '#2c3252';
      ctx.fillRect(plat.x, plat.y, plat.w, plat.h);
      ctx.fillStyle = '#3d4570';
      ctx.fillRect(plat.x, plat.y, plat.w, 5);
    }

    // Feature 2: glowing item pickups sitting on their platform
    this._renderItems(ctx);

    // Feature 4: ultimate AoE telegraph circles (drawn under the players, semi-transparent)
    for (const p of this.players.values()) {
      if (!p.alive || !p.ultTelegraph) continue;
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = p.ultTelegraph.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y - p.height * 0.5, p.ultTelegraph.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // players (draw shadow, then body)
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 4, p.width * 0.6, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      p.draw(ctx);
    }

    // projectiles
    for (const pr of this.projectiles) pr.draw(ctx);

    // particles / floating text
    this.effects.draw(ctx);
    this.effects.drawScreenFlash(ctx, ARENA_W, ARENA_H);
  }

  // Feature 2: small glowing glyphs for each item type, with a gentle pulse.
  // Purely decorative/local — item state itself is host-authoritative.
  _renderItems(ctx) {
    const t = Date.now() / 1000;
    for (const it of this.items) {
      const meta = ITEM_TYPES[it.type];
      const glow = 8 + Math.sin(t * 3 + it.x) * 3;
      const iy = it.y - 16;
      ctx.save();
      ctx.shadowBlur = 16 + glow;
      ctx.shadowColor = meta.color;
      ctx.fillStyle = meta.color;
      ctx.beginPath();
      ctx.arc(it.x, iy, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = '#0d0f1a';
      ctx.font = 'bold 12px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const glyph = { health: '+', sword: 'S', gun: 'G', rocket: 'R', shield: 'D' }[it.type] || '?';
      ctx.fillText(glyph, it.x, iy + 1);
    }
  }
}

// ---------------------------------------------------------- bootstrap
window.addEventListener('DOMContentLoaded', () => {
  const ui = new UIManager();
  const game = new Game(ui);
});
