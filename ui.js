/* ============================================================
   ui.js
   Screen management, lobby UI, loadout chips, in-game HUD
   (health bars / cooldown icons) and the winner screen.
   ============================================================ */

const PLAYER_COLORS = ['#ff5c5c', '#5cc8ff', '#7dff8f', '#d68bff'];

class UIManager {
  constructor() {
    this.net = null;   // NetworkManager, injected by game.js
    this.game = null;  // Game, injected by game.js

    this.localName = 'Fighter';
    this.selectedWeapon = 'sword';
    this.selectedPower = 'fire';
    this.selectedKillTarget = 10; // host-only "match ends at N kills" (Feature 1)
    this.localReady = false;

    // Single source of truth for cosmetics — WardrobeUI reads/writes this
    // same instance (not a copy), so an equip in the Wardrobe is instantly
    // reflected everywhere else that reads ui.profile (lobby, room create/join).
    this.profile = PlayerProfile.load();

    this._cacheDom();
    this._wireEvents();
    this._buildLoadoutChips();
    this.wardrobe = new WardrobeUI(this);
    this.showScreen('main');
  }

  _cacheDom() {
    this.screens = {
      main: document.getElementById('screen-main'),
      create: document.getElementById('screen-create'),
      join: document.getElementById('screen-join'),
      lobby: document.getElementById('screen-lobby'),
      game: document.getElementById('screen-game'),
      winner: document.getElementById('screen-winner'),
      wardrobe: document.getElementById('screen-wardrobe'),
    };
    this.nameInput = document.getElementById('input-player-name');
    this.roomCodeDisplay = document.getElementById('room-code-display');
    this.createStatus = document.getElementById('create-status');
    this.roomIdInput = document.getElementById('input-room-id');
    this.joinStatus = document.getElementById('join-status');
    this.lobbyRoomCode = document.getElementById('lobby-room-code');
    this.lobbyPlayers = document.getElementById('lobby-players');
    this.weaponSelect = document.getElementById('weapon-select');
    this.powerSelect = document.getElementById('power-select');
    this.killTargetGroup = document.getElementById('killtarget-group');
    this.killTargetSelect = document.getElementById('killtarget-select');
    this.btnReady = document.getElementById('btn-ready');
    this.btnStartMatch = document.getElementById('btn-start-match');
    this.lobbyHint = document.getElementById('lobby-hint');
    this.hudTop = document.getElementById('hud-top');
    this.matchHud = document.getElementById('match-hud');
    this.roundBanner = document.getElementById('round-banner');
    this.killBanner = document.getElementById('kill-banner');
    this.pickupToast = document.getElementById('pickup-toast');
    this.coinRewardStack = document.getElementById('coin-reward-stack');
    this.winnerName = document.getElementById('winner-name');
    this.winnerPanel = this.winnerName ? this.winnerName.closest('.panel') : null;
    this.matchSummaryList = document.getElementById('match-summary-list');
    this.walletDeposit = document.getElementById('wallet-deposit');
    this.walletDepositValue = document.getElementById('wallet-deposit-value');
    this.walletDepositDelta = document.getElementById('wallet-deposit-delta');
    this.btnRestart = document.getElementById('btn-restart');
    this.btnToMenu = document.getElementById('btn-to-menu');
    this.cdEls = {
      attack: document.getElementById('cd-attack'),
      heavy: document.getElementById('cd-heavy'),
      skill: document.getElementById('cd-skill'),
      ult: document.getElementById('cd-ult'),
    };
  }

  _wireEvents() {
    document.getElementById('btn-goto-create').onclick = () => {
      this.localName = this.nameInput.value.trim() || 'Fighter';
      this.showScreen('create');
      this._onCreateRoom && this._onCreateRoom();
    };
    document.getElementById('btn-goto-join').onclick = () => {
      this.localName = this.nameInput.value.trim() || 'Fighter';
      this.showScreen('join');
    };
    document.getElementById('btn-back-from-create').onclick = () => {
      this._onLeave && this._onLeave();
      this.showScreen('main');
    };
    document.getElementById('btn-back-from-join').onclick = () => this.showScreen('main');
    document.getElementById('btn-copy-code').onclick = () => {
      navigator.clipboard && navigator.clipboard.writeText(this.roomCodeDisplay.textContent).catch(() => {});
    };
    document.getElementById('btn-do-join').onclick = () => {
      const code = this.roomIdInput.value.trim().toUpperCase();
      if (!code) { this.joinStatus.textContent = 'Enter a room ID.'; return; }
      this.joinStatus.textContent = 'Connecting…';
      this._onJoinRoom && this._onJoinRoom(code);
    };
    document.getElementById('btn-ready').onclick = () => {
      this.localReady = !this.localReady;
      this.btnReady.textContent = this.localReady ? 'Unready' : 'Ready';
      this.net && this.net.setLocalReady(this.localReady);
    };
    document.getElementById('btn-start-match').onclick = () => {
      this.net && this.net.startMatch(this.selectedKillTarget);
    };
    document.getElementById('btn-leave-lobby').onclick = () => {
      this._onLeave && this._onLeave();
      this.showScreen('main');
    };
    document.getElementById('btn-restart').onclick = () => {
      this.net && this.net.restartMatch();
    };
    document.getElementById('btn-to-menu').onclick = () => {
      this._onLeave && this._onLeave();
      this.showScreen('main');
    };
    // Wardrobe is reachable only from inside the Lobby (never the main menu
    // or the game screen) — that's what enforces "no wardrobe changes once
    // the match has started" without needing a separate runtime guard.
    document.getElementById('btn-goto-wardrobe').onclick = () => {
      this.showScreen('wardrobe');
      this.wardrobe.open();
    };
    document.getElementById('btn-back-from-wardrobe').onclick = () => {
      this.wardrobe.close();
      this.showScreen('lobby');
    };
  }

  _buildLoadoutChips() {
    // gun/rocket are pickup-only ranged weapons (Feature 2/3), not a starting loadout choice
    const startingWeapons = Object.values(WEAPON_TYPES).filter(w => !w.isRanged);

    this.weaponSelect.innerHTML = '';
    startingWeapons.forEach(w => {
      const chip = document.createElement('div');
      chip.className = 'chip' + (w.id === this.selectedWeapon ? ' selected' : '');
      chip.textContent = w.name;
      chip.style.background = w.id === this.selectedWeapon ? w.color : '';
      chip.onclick = () => {
        this.selectedWeapon = w.id;
        this._refreshChipSelection();
        this._pushLoadout();
      };
      this.weaponSelect.appendChild(chip);
    });

    this.powerSelect.innerHTML = '';
    Object.values(POWER_TYPES).forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'chip' + (p.id === this.selectedPower ? ' selected' : '');
      chip.textContent = p.name;
      chip.style.background = p.id === this.selectedPower ? p.color : '';
      chip.onclick = () => {
        this.selectedPower = p.id;
        this._refreshChipSelection();
        this._pushLoadout();
      };
      this.powerSelect.appendChild(chip);
    });

    // Feature 1: host chooses the kill target that ends the match
    this.killTargetSelect.innerHTML = '';
    [10, 30, 50].forEach(n => {
      const chip = document.createElement('div');
      chip.className = 'chip' + (n === this.selectedKillTarget ? ' selected' : '');
      chip.textContent = n + ' Kills';
      chip.style.background = n === this.selectedKillTarget ? 'var(--gold)' : '';
      chip.style.color = n === this.selectedKillTarget ? '#241a00' : '';
      chip.onclick = () => {
        this.selectedKillTarget = n;
        [...this.killTargetSelect.children].forEach(el => {
          const sel = el === chip;
          el.classList.toggle('selected', sel);
          el.style.background = sel ? 'var(--gold)' : '';
          el.style.color = sel ? '#241a00' : '';
        });
      };
      this.killTargetSelect.appendChild(chip);
    });
  }

  _refreshChipSelection() {
    const startingWeapons = Object.values(WEAPON_TYPES).filter(w => !w.isRanged);
    [...this.weaponSelect.children].forEach(el => {
      const w = startingWeapons.find(w => w.name === el.textContent);
      const sel = w.id === this.selectedWeapon;
      el.classList.toggle('selected', sel);
      el.style.background = sel ? w.color : '';
    });
    [...this.powerSelect.children].forEach(el => {
      const p = Object.values(POWER_TYPES).find(p => p.name === el.textContent);
      const sel = p.id === this.selectedPower;
      el.classList.toggle('selected', sel);
      el.style.background = sel ? p.color : '';
    });
  }

  _pushLoadout() {
    this.net && this.net.setLocalLoadout(this.localName, this.selectedWeapon, this.selectedPower);
  }

  // ---------------------------------------------------------
  showScreen(name) {
    Object.values(this.screens).forEach(s => s.classList.remove('active'));
    this.screens[name].classList.add('active');
    // Catch-all: whatever navigated us away from the winner screen (Restart,
    // Main Menu, Leave) stops its preview animation loop, so it never keeps
    // running invisibly in the background.
    if (name !== 'winner' && this._stopWinnerPreview) this._stopWinnerPreview();
  }

  setRoomCode(code) {
    this.roomCodeDisplay.textContent = code;
    this.lobbyRoomCode.textContent = code;
    this.createStatus.textContent = 'Room ready — waiting for players…';
  }

  goToLobby() {
    this.showScreen('lobby');
    this.localReady = false;
    this.btnReady.textContent = 'Ready';
  }

  updateLobby(rosterArray, isHost, localId) {
    this._lobbyRoster = rosterArray; // cached for refreshLobbyPreviews()'s instant local feedback
    this.lobbyPlayers.innerHTML = '';
    rosterArray.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'lobby-player-card' + (p.ready ? ' ready' : '');
      const wName = WEAPON_TYPES[p.weapon] ? WEAPON_TYPES[p.weapon].name : p.weapon;
      const pName = POWER_TYPES[p.power] ? POWER_TYPES[p.power].name : p.power;
      card.innerHTML = `<canvas class="lp-preview" width="64" height="80" id="lp-preview-${p.id}"></canvas>
        <div class="lp-name" style="color:${PLAYER_COLORS[i % 4]}"><span class="lp-dot"></span>${this._esc(p.name)}${p.isHost ? ' 👑' : ''}${p.id === localId ? ' (you)' : ''}</div>
        <div class="lp-meta">${wName} · ${pName}</div>
        <div class="lp-meta">${p.ready ? 'Ready' : 'Not ready'}</div>`;
      this.lobbyPlayers.appendChild(card);
      this._drawLobbyPreview(p, i);
    });

    this.btnStartMatch.style.display = isHost ? 'inline-block' : 'none';
    this.killTargetGroup.style.display = isHost ? 'block' : 'none';
    const allReady = rosterArray.length > 0 && rosterArray.every(p => p.ready);
    this.btnStartMatch.disabled = !allReady;
    this.lobbyHint.textContent = isHost
      ? (allReady ? 'Everyone is ready — start when you like!' : 'Waiting for all players to ready up…')
      : 'Waiting for the host to start the match…';
  }

  // Every player's equipped cosmetics rendered as a small static thumbnail
  // in their lobby card — reuses Player.draw() (same code path as the
  // Wardrobe preview and the actual match), so nobody's look ever drifts
  // between "what the lobby showed" and "what the match shows".
  _drawLobbyPreview(rosterEntry, colorIndex) {
    const canvas = document.getElementById('lp-preview-' + rosterEntry.id);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this._lobbyPreviewPlayer) this._lobbyPreviewPlayer = new Player('lobby-preview', '', 0, 0, PLAYER_COLORS[0], 'sword', 'fire');
    const p = this._lobbyPreviewPlayer;
    p.facing = 1; p.state = 'idle'; p.animPhase = 0; p.invulnTimer = 0; p.alive = true;
    p.color = PLAYER_COLORS[colorIndex % 4];
    p.weapon = new Weapon(rosterEntry.weapon);
    p.power = new Power(rosterEntry.power);
    p.cosmetics = rosterEntry.cosmetics || null;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height * 0.92);
    ctx.scale(0.58, 0.58);
    p.x = 0; p.y = 0;
    p.draw(ctx, { showHpBar: false });
    ctx.restore();
  }

  // Called by WardrobeUI right after an equip so the local player's own
  // lobby card updates instantly, without waiting on the network round-trip
  // that setLocalCosmetics's broadcast normally takes for everyone else.
  refreshLobbyPreviews() {
    if (!this._lobbyRoster) return;
    const localId = this.net && this.net.localId;
    this._lobbyRoster.forEach((p, i) => {
      if (p.id === localId) p.cosmetics = resolveEquippedCosmetics(this.profile);
      this._drawLobbyPreview(p, i);
    });
  }

  _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ---------------------------------------------------------
  buildHUD(players) {
    this.hudTop.innerHTML = '';
    this._hudRefs = new Map(); // cache per-player DOM refs so updateHUD (runs every frame) skips getElementById
    players.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'hud-hp-card';
      card.innerHTML = `<div class="hud-hp-name"><span style="color:${p.color}">${this._esc(p.name)}</span><span id="hp-val-${p.id}">100</span></div>
        <div class="hud-hp-bar-bg"><div class="hud-hp-bar-fill" id="hp-fill-${p.id}" style="background:${p.color}"></div></div>
        <div class="hud-weapon-row"><span id="hud-weapon-${p.id}">${this._esc(p.weapon.name)}</span><span id="hud-score-${p.id}">0 kills</span></div>
        <div class="hud-ult-bar-bg"><div class="hud-ult-bar-fill" id="hud-ult-${p.id}"></div></div>
        <div class="hud-buffs" id="hud-buffs-${p.id}"></div>`;
      this.hudTop.appendChild(card);
      this._hudRefs.set(p.id, {
        fill: card.querySelector('#hp-fill-' + p.id),
        val: card.querySelector('#hp-val-' + p.id),
        weapon: card.querySelector('#hud-weapon-' + p.id),
        score: card.querySelector('#hud-score-' + p.id),
        ult: card.querySelector('#hud-ult-' + p.id),
        buffs: card.querySelector('#hud-buffs-' + p.id),
        lastBuffsKey: '',
      });
    });
  }

  updateHUD(players) {
    if (!this._hudRefs) return;
    players.forEach(p => {
      const refs = this._hudRefs.get(p.id);
      if (!refs) return;
      if (refs.fill) refs.fill.style.width = Math.max(0, (p.health / p.maxHealth) * 100) + '%';
      if (refs.val) refs.val.textContent = Math.max(0, Math.round(p.health));
      if (refs.weapon) refs.weapon.textContent = p.weapon.name;
      if (refs.score) refs.score.textContent = `${p.score} kill${p.score === 1 ? '' : 's'}`;

      if (refs.ult) {
        const pct = p.power.ultCooldown > 0
          ? Math.max(0, Math.min(1, 1 - p.ultCooldown / p.power.ultCooldown)) * 100
          : 100;
        refs.ult.style.width = pct + '%';
      }

      if (refs.buffs) {
        const chips = [];
        if (p.shieldTimer > 0) chips.push(`Shield ${Math.ceil(p.shieldTimer / 1000)}s`);
        if (p.tempWeaponTimer > 0) chips.push(`${p.weapon.name} ${Math.ceil(p.tempWeaponTimer / 1000)}s`);
        const key = chips.join('|');
        if (key !== refs.lastBuffsKey) {
          refs.lastBuffsKey = key;
          refs.buffs.innerHTML = chips.map(c => `<span class="hud-buff-chip">${this._esc(c)}</span>`).join('');
        }
      }
    });
  }

  // Match HUD: "First to N Kills" + each player's K/D, visible to everyone
  // (host and clients alike render this from their own local Player state,
  // which is kept in sync via the host's broadcast snapshot).
  buildMatchHUD(killTarget) {
    if (!this.matchHud) return;
    this._matchHudKillTarget = killTarget;
    this._matchHudLastKey = '';
  }

  updateMatchHUD(players, killTarget) {
    if (!this.matchHud) return;
    const rows = players.map(p =>
      `<div class="match-hud-row"><span class="match-hud-name" style="color:${p.color}">${this._esc(p.name)}</span><span class="match-hud-kd">K/D: ${p.score}/${p.deaths}</span></div>`
    ).join('');
    const key = killTarget + '|' + players.map(p => `${p.id}:${p.score}:${p.deaths}:${p.name}`).join(',');
    if (key === this._matchHudLastKey) return;
    this._matchHudLastKey = key;
    this.matchHud.innerHTML = `<div class="match-hud-title">First to ${killTarget} Kills</div>${rows}`;
  }

  updateCooldowns(player) {
    if (!player) return;
    this._setCd(this.cdEls.attack, player.attackCooldown, player.weapon.speed, 'J');
    this._setCd(this.cdEls.heavy, player.heavyCooldown, player.weapon.heavySpeed, 'K');
    this._setCd(this.cdEls.skill, player.skillCooldown, player.power.skillCooldown, 'L');
    this._setCd(this.cdEls.ult, player.ultCooldown, player.power.ultCooldown, 'Q');
  }

  _setCd(el, remaining, total, letter) {
    const pct = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
    el.style.background = remaining > 0
      ? `linear-gradient(to top, #12142299 ${100 - pct * 100}%, #00000099 ${100 - pct * 100}%)`
      : '#12142299';
    const span = el.querySelector('span');
    if (span) span.textContent = remaining > 0 ? Math.ceil(remaining / 1000) : letter;
  }

  flashBanner(text, ms = 1400) {
    this.roundBanner.textContent = text;
    this.roundBanner.classList.add('show');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => this.roundBanner.classList.remove('show'), ms);
  }

  // Feature 1: large centered "X has been killed by Y" message
  showKillBanner(text, ms = 2200) {
    if (!this.killBanner) return;
    this.killBanner.textContent = text;
    this.killBanner.classList.add('show');
    clearTimeout(this._killBannerTimer);
    this._killBannerTimer = setTimeout(() => this.killBanner.classList.remove('show'), ms);
  }

  // Feature 3: small pickup confirmation toast + a short synthesized beep
  // (no external audio file needed, keeping the project dependency-free)
  showPickupToast(text, ms = 1800) {
    if (!this.pickupToast) return;
    this.pickupToast.textContent = text;
    this.pickupToast.classList.add('show');
    clearTimeout(this._pickupToastTimer);
    this._pickupToastTimer = setTimeout(() => this.pickupToast.classList.remove('show'), ms);
    this.playPickupSound();
  }

  // Match Coin Reward System: unlike the other toasts above (a single
  // reused element), this creates a brand-new element per call so several
  // can be visible and stacked at once when kills happen in quick
  // succession — the whole pop-in/hold/float-up-fade lifecycle is one CSS
  // animation (see style.css), so this just needs to append and later remove.
  showCoinReward(amount, ms = 2000) {
    if (!this.coinRewardStack) return;
    const toast = document.createElement('div');
    toast.className = 'coin-reward-toast';
    toast.innerHTML = `<span class="coin-reward-icon">\u{1FA99}</span><span class="coin-reward-text">+${amount} Coins</span>`;
    this.coinRewardStack.appendChild(toast);
    setTimeout(() => toast.remove(), ms);
  }

  playPickupSound() {
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(520, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(980, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    } catch (e) { /* audio not available — silently ignore */ }
  }

  // Takes the actual winning Player instance (or null for a draw), the full
  // list of Player instances for the Match Results summary, and the local
  // wallet balance from just before this match's rewards were deposited
  // (for the counting-up deposit animation) — reuses Player.draw() again
  // rather than a separate static graphic for every avatar involved.
  showWinner(winnerPlayer, allPlayers = [], walletBefore = null) {
    const name = winnerPlayer ? winnerPlayer.name : null;
    const color = winnerPlayer ? winnerPlayer.color : null;
    this.winnerName.textContent = name ? `${name} wins!` : 'Draw!';
    this.winnerName.style.color = color || '#ffce54';
    this.showScreen('winner');
    if (this.winnerPanel) {
      this.winnerPanel.classList.add('victory-pulse');
      setTimeout(() => this.winnerPanel.classList.remove('victory-pulse'), 4000);
    }
    this._startWinnerPreview(winnerPlayer);
    this._renderMatchSummary(allPlayers, winnerPlayer);
    this._runWalletDeposit(walletBefore);
  }

  // Match Results: one card per player (avatar reusing Player.draw(),
  // name, kills/deaths, coins earned this match, winner badge), sorted by
  // kills so the standings read top-to-bottom like a scoreboard.
  _renderMatchSummary(allPlayers, winnerPlayer) {
    if (!this.matchSummaryList) return;
    this.matchSummaryList.innerHTML = '';
    const medals = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
    [...allPlayers].sort((a, b) => b.score - a.score).forEach((p, i) => {
      const isWinner = !!(winnerPlayer && p.id === winnerPlayer.id);
      const card = document.createElement('div');
      card.className = 'match-summary-card' + (isWinner ? ' winner' : '');
      card.innerHTML = `
        <canvas class="match-summary-avatar" id="summary-avatar-${p.id}" width="52" height="64"></canvas>
        <div class="match-summary-info">
          <div class="match-summary-name" style="color:${p.color}">
            ${medals[i] || ''} ${this._esc(p.name)}
            ${isWinner ? '<span class="match-summary-badge">WINNER</span>' : ''}
          </div>
          <div class="match-summary-stats">Kills: ${p.score} &nbsp;·&nbsp; Deaths: ${p.deaths}</div>
        </div>
        <div class="match-summary-coins">\u{1FA99} +${p.matchCoins || 0}</div>
      `;
      this.matchSummaryList.appendChild(card);
      this._drawSummaryAvatar(p);
    });
  }

  // Draws the REAL Player instance directly (not a proxy like the lobby
  // preview needs, since these are already live Player objects from the
  // match) — temporarily repositions it to the small canvas's local origin
  // and restores it afterward so nothing about the actual match state leaks.
  _drawSummaryAvatar(p) {
    const canvas = document.getElementById('summary-avatar-' + p.id);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const savedX = p.x, savedY = p.y, savedState = p.state, savedAlive = p.alive, savedInvuln = p.invulnTimer;
    p.state = 'idle';
    p.alive = true;
    p.invulnTimer = 0;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height * 0.92);
    ctx.scale(0.55, 0.55);
    p.x = 0; p.y = 0;
    p.draw(ctx, { showHpBar: false });
    ctx.restore();
    p.x = savedX; p.y = savedY; p.state = savedState; p.alive = savedAlive; p.invulnTimer = savedInvuln;
  }

  // Coin Deposit Animation: counts the wallet up from its pre-match value to
  // its new value (already applied to this.profile.coins by the time this
  // runs), with a sparkle burst and a short synthesized "cha-ching" once it
  // lands. Restart/Main Menu stay disabled until it finishes, per spec.
  _runWalletDeposit(walletBefore) {
    if (!this.walletDepositValue) return;
    const after = this.profile.coins;
    if (typeof walletBefore !== 'number') {
      this.walletDepositValue.textContent = after;
      this._setWinnerButtonsDisabled(false);
      return;
    }
    const delta = after - walletBefore;
    this._setWinnerButtonsDisabled(true);
    this.walletDepositValue.textContent = walletBefore;
    if (this.walletDepositDelta) {
      this.walletDepositDelta.textContent = delta > 0 ? `+${delta}` : '';
      this.walletDepositDelta.classList.toggle('show', delta > 0);
    }

    if (delta <= 0) {
      this._setWinnerButtonsDisabled(false);
      return;
    }

    this.playCoinDepositSound();
    const durationMs = Math.min(1800, Math.max(500, delta * 25));
    const startTime = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic — starts fast, settles gently
      this.walletDepositValue.textContent = Math.round(walletBefore + delta * eased);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        this.walletDepositValue.textContent = after;
        this._spawnWalletSparkle();
        this._setWinnerButtonsDisabled(false);
      }
    };
    requestAnimationFrame(step);
  }

  _spawnWalletSparkle() {
    if (!this.walletDeposit) return;
    const count = 6;
    for (let i = 0; i < count; i++) {
      const sparkle = document.createElement('span');
      sparkle.className = 'wallet-sparkle';
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const dist = 22 + Math.random() * 16;
      sparkle.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(1) + 'px');
      sparkle.style.setProperty('--dy', (Math.sin(angle) * dist).toFixed(1) + 'px');
      sparkle.textContent = '✦';
      this.walletDeposit.appendChild(sparkle);
      setTimeout(() => sparkle.remove(), 700);
    }
  }

  _setWinnerButtonsDisabled(disabled) {
    if (this.btnRestart) this.btnRestart.disabled = disabled;
    if (this.btnToMenu) this.btnToMenu.disabled = disabled;
  }

  playCoinDepositSound() {
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audioCtx;
      [660, 880, 1180].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        const t0 = ctx.currentTime + i * 0.08;
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.16, t0);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.16);
      });
    } catch (e) { /* audio not available — silently ignore */ }
  }

  _startWinnerPreview(winnerPlayer) {
    this._stopWinnerPreview();
    const canvas = document.getElementById('winner-preview-canvas');
    if (!canvas || !winnerPlayer) return;
    const ctx = canvas.getContext('2d');
    if (!this._winnerPreviewPlayer) this._winnerPreviewPlayer = new Player('winner-preview', '', 0, 0, PLAYER_COLORS[0], 'sword', 'fire');
    const preview = this._winnerPreviewPlayer;
    preview.color = winnerPlayer.color;
    preview.weapon = winnerPlayer.weapon;
    preview.power = winnerPlayer.power;
    preview.cosmetics = winnerPlayer.cosmetics;
    preview.facing = 1;
    preview.state = winnerPlayer.victoryPoseId ? 'victory' : 'idle';
    preview.victoryPoseId = winnerPlayer.victoryPoseId;
    preview.animTimer = 0;
    preview.animPhase = 0;
    preview.invulnTimer = 0;
    preview.alive = true;

    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(50, now - last);
      last = now;
      preview.animTimer += dt;
      preview.animPhase += dt * 0.006;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height * 0.86);
      ctx.scale(1.5, 1.5);
      preview.x = 0; preview.y = 0;
      preview.draw(ctx, { showHpBar: false });
      ctx.restore();
      this._winnerPreviewRaf = requestAnimationFrame(loop);
    };
    this._winnerPreviewRaf = requestAnimationFrame(loop);
  }

  _stopWinnerPreview() {
    if (this._winnerPreviewRaf) { cancelAnimationFrame(this._winnerPreviewRaf); this._winnerPreviewRaf = null; }
  }
}
