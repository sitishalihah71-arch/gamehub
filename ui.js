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

    this._cacheDom();
    this._wireEvents();
    this._buildLoadoutChips();
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
    this.winnerName = document.getElementById('winner-name');
    this.winnerPanel = this.winnerName ? this.winnerName.closest('.panel') : null;
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
    this.lobbyPlayers.innerHTML = '';
    rosterArray.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'lobby-player-card' + (p.ready ? ' ready' : '');
      const wName = WEAPON_TYPES[p.weapon] ? WEAPON_TYPES[p.weapon].name : p.weapon;
      const pName = POWER_TYPES[p.power] ? POWER_TYPES[p.power].name : p.power;
      card.innerHTML = `<div class="lp-name" style="color:${PLAYER_COLORS[i % 4]}"><span class="lp-dot"></span>${this._esc(p.name)}${p.isHost ? ' 👑' : ''}${p.id === localId ? ' (you)' : ''}</div>
        <div class="lp-meta">${wName} · ${pName}</div>
        <div class="lp-meta">${p.ready ? 'Ready' : 'Not ready'}</div>`;
      this.lobbyPlayers.appendChild(card);
    });

    this.btnStartMatch.style.display = isHost ? 'inline-block' : 'none';
    this.killTargetGroup.style.display = isHost ? 'block' : 'none';
    const allReady = rosterArray.length > 0 && rosterArray.every(p => p.ready);
    this.btnStartMatch.disabled = !allReady;
    this.lobbyHint.textContent = isHost
      ? (allReady ? 'Everyone is ready — start when you like!' : 'Waiting for all players to ready up…')
      : 'Waiting for the host to start the match…';
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

  showWinner(name, color) {
    this.winnerName.textContent = name ? `${name} wins!` : 'Draw!';
    this.winnerName.style.color = color || '#ffce54';
    this.showScreen('winner');
    if (this.winnerPanel) {
      this.winnerPanel.classList.add('victory-pulse');
      setTimeout(() => this.winnerPanel.classList.remove('victory-pulse'), 4000);
    }
  }
}
