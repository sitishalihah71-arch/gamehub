/* ============================================================
   wardrobe.js
   The Wardrobe screen, opened from inside the multiplayer Lobby:
   category tabs, rarity filter, skin grid (locked/unlocked,
   unlock requirements), and a large idle-animated preview canvas
   with a Victory Animation preview button.

   Deliberately reuses existing classes instead of building a
   parallel rendering system:
     - The preview character is a real `Player` instance (player.js)
       drawn with Player.draw() — exactly the same code path used
       in an actual match, so the preview can never drift from how
       a skin really looks in-game (or in the lobby mini-previews,
       see ui.js buildLobbyPreview, which reuses the same method too).
     - `this.profile` is the SAME PlayerProfile instance owned by
       UIManager (ui.profile) — there is only ever one in-memory
       profile, so an equip here is instantly visible everywhere
       else that reads it (lobby cards, match start).
   ============================================================ */

class WardrobeUI {
  constructor(ui) {
    this.ui = ui; // UIManager — shared profile + selectedWeapon/selectedPower + net
    this.profile = ui.profile;

    this.activeCategory = SKIN_CATEGORIES[0].id;
    this.activeRarity = 'all';
    this.searchText = '';
    this.selectedId = null;          // currently highlighted card (may not be equipped yet — live preview)
    this.previewingVictoryId = null; // set by the Preview button on the Victory Animation tab

    this._cacheDom();
    this._buildTabs();
    this._buildRarityFilter();
    this._wireStaticEvents();

    // Preview scene — a real Player instance, reused verbatim from the
    // match code (see class comment above).
    this._previewPlayer = new Player('wardrobe-preview', '', 0, 0, PLAYER_COLORS[0], 'sword', 'fire');
    this._previewT = 0;
    this._rafHandle = null;
    this._lastFrameTime = 0;
  }

  _cacheDom() {
    this.screen = document.getElementById('screen-wardrobe');
    this.tabsEl = document.getElementById('wardrobe-tabs');
    this.rarityFilterEl = document.getElementById('wardrobe-rarity-filter');
    this.searchInput = document.getElementById('wardrobe-search');
    this.gridEl = document.getElementById('wardrobe-grid');
    this.canvas = document.getElementById('wardrobe-preview-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.zoomSlider = document.getElementById('wardrobe-zoom');
    this.coinDisplay = document.getElementById('wardrobe-coins');
    this.detailName = document.getElementById('wardrobe-detail-name');
    this.detailRarity = document.getElementById('wardrobe-detail-rarity');
    this.detailReq = document.getElementById('wardrobe-detail-req');
    this.btnEquip = document.getElementById('btn-wardrobe-equip');
    this.btnBuy = document.getElementById('btn-wardrobe-buy');
    this.btnPreviewVictory = document.getElementById('btn-wardrobe-preview-victory');
    this.btnLootbox = document.getElementById('btn-wardrobe-lootbox');
    this.lootboxResult = document.getElementById('wardrobe-lootbox-result');
    this.hairColorRow = document.getElementById('wardrobe-hair-color-row');
    this.hairColorSwatches = document.getElementById('wardrobe-hair-color-swatches');
    this.hairColorInput = document.getElementById('wardrobe-hair-color-input');
    this.btnHairColorReset = document.getElementById('btn-wardrobe-hair-color-reset');
  }

  _buildTabs() {
    this.tabsEl.innerHTML = '';
    SKIN_CATEGORIES.forEach(cat => {
      const btn = document.createElement('button');
      btn.className = 'wardrobe-tab' + (cat.id === this.activeCategory ? ' active' : '');
      btn.innerHTML = `<span class="wardrobe-tab-icon">${cat.icon}</span>${cat.label}`;
      btn.onclick = () => {
        this.activeCategory = cat.id;
        this.selectedId = this.profile.equipped[cat.id];
        this.previewingVictoryId = null; // leaving/entering a tab resets any live victory-pose preview
        this._buildTabs();
        this._renderGrid();
        this._renderDetail();
        this._updateHairColorPicker();
      };
      this.tabsEl.appendChild(btn);
    });
  }

  _buildRarityFilter() {
    this.rarityFilterEl.innerHTML = '';
    const makeChip = (id, label, color) => {
      const chip = document.createElement('div');
      chip.className = 'chip wardrobe-rarity-chip' + (id === this.activeRarity ? ' selected' : '');
      chip.textContent = label;
      if (id === this.activeRarity) { chip.style.background = color; chip.style.color = '#0d0f1a'; }
      chip.onclick = () => { this.activeRarity = id; this._buildRarityFilter(); this._renderGrid(); };
      this.rarityFilterEl.appendChild(chip);
    };
    makeChip('all', 'All', 'var(--text-dim)');
    RARITY_ORDER.forEach(r => makeChip(r, RARITY_TIERS[r].name, RARITY_TIERS[r].color));
  }

  _wireStaticEvents() {
    this.searchInput.oninput = () => { this.searchText = this.searchInput.value.trim().toLowerCase(); this._renderGrid(); };
    this.zoomSlider.oninput = () => { this._zoom = parseFloat(this.zoomSlider.value); };
    this.btnEquip.onclick = () => this._equipSelected();
    this.btnBuy.onclick = () => this._buySelected();
    this.btnPreviewVictory.onclick = () => this._previewVictory();
    this.btnLootbox.onclick = () => this._openLootbox();
    this.btnLootbox.textContent = `Open Loot Box (${LOOTBOX_COST})`;
    this._zoom = parseFloat(this.zoomSlider.value) || 1;
    this._buildHairColorPicker();
  }

  // Free hair-color customization (spec: "all players can choose their hair
  // colour") — a row of preset swatches plus a native color input for any
  // exact shade, shown only while the Hair tab is active.
  _buildHairColorPicker() {
    this.hairColorSwatches.innerHTML = '';
    HAIR_COLOR_PRESETS.forEach(color => {
      const swatch = document.createElement('div');
      swatch.className = 'hair-color-swatch';
      swatch.style.background = color;
      swatch.title = color;
      swatch.dataset.color = color; // plain string to compare against — el.style.background gets normalized to rgb() on read
      swatch.onclick = () => this._setHairColor(color);
      this.hairColorSwatches.appendChild(swatch);
    });
    this.hairColorInput.oninput = () => this._setHairColor(this.hairColorInput.value);
    this.btnHairColorReset.onclick = () => this._setHairColor(null);
  }

  _setHairColor(color) {
    this.profile.setHairColor(color);
    this._updateHairColorPicker();
    this._renderGrid();
    this._syncCosmetics();
  }

  _updateHairColorPicker() {
    const show = this.activeCategory === 'hair';
    this.hairColorRow.style.display = show ? 'flex' : 'none';
    if (!show) return;
    const current = this.profile.hairColor;
    [...this.hairColorSwatches.children].forEach(el => {
      el.classList.toggle('selected', !!current && current === el.dataset.color);
    });
    this.hairColorInput.value = current || '#ffffff';
    this.btnHairColorReset.disabled = !current;
  }

  // ---------------------------------------------------------- lifecycle
  // Opened only from inside the Lobby (see ui.js) — never reachable once a
  // match has started, which is what "prevents wardrobe changes once the
  // match has started" per spec: there is simply no path to it from there.
  open() {
    this.selectedId = this.profile.equipped[this.activeCategory];
    this.previewingVictoryId = null;
    this._renderGrid();
    this._renderDetail();
    this._updateCoinDisplay();
    this._updateHairColorPicker();
    if (!this._rafHandle) {
      this._lastFrameTime = performance.now();
      this._rafHandle = requestAnimationFrame((t) => this._previewLoop(t));
    }
  }

  close() {
    if (this._rafHandle) { cancelAnimationFrame(this._rafHandle); this._rafHandle = null; }
  }

  // Pushes the current equipped set to every other player in the lobby (a
  // no-op if we're not actually connected to a room yet) and refreshes the
  // lobby's own roster cards immediately for the local player.
  _syncCosmetics() {
    if (this.ui.net) this.ui.net.setLocalCosmetics(resolveEquippedCosmetics(this.profile));
    if (this.ui.refreshLobbyPreviews) this.ui.refreshLobbyPreviews();
  }

  // ---------------------------------------------------------- grid / cards
  _visibleSkins() {
    return SKIN_CATALOG.filter(s => {
      if (s.category !== this.activeCategory) return false;
      if (this.activeRarity !== 'all' && s.rarity !== this.activeRarity) return false;
      if (this.searchText && !s.name.toLowerCase().includes(this.searchText)) return false;
      return true;
    });
  }

  _renderGrid() {
    this.gridEl.innerHTML = '';
    const skins = this._visibleSkins();
    if (skins.length === 0) {
      this.gridEl.innerHTML = '<div class="wardrobe-empty">No skins match this filter.</div>';
      return;
    }
    skins.forEach(skin => {
      const unlocked = this.profile.isUnlocked(skin.id);
      const equipped = this.profile.equipped[skin.category] === skin.id;
      const tier = RARITY_TIERS[skin.rarity];
      const card = document.createElement('div');
      card.className = 'wardrobe-card' + (unlocked ? '' : ' locked') + (skin.id === this.selectedId ? ' selected' : '') + (equipped ? ' equipped' : '');
      card.style.setProperty('--rarity-color', tier.color);
      card.style.setProperty('--rarity-glow', tier.glow);
      card.innerHTML = `
        <div class="wardrobe-card-rarity">${tier.name}</div>
        ${!unlocked ? '<div class="wardrobe-card-lock">\u{1F512}</div>' : ''}
        <div class="wardrobe-card-name">${this._esc(skin.name)}</div>
        ${equipped ? '<div class="wardrobe-card-equipped-tag">\u{2713} Equipped</div>' : ''}
        ${!unlocked ? `<div class="wardrobe-card-req">${this._esc(this._unlockText(skin, true))}</div>` : ''}
      `;
      card.onclick = () => {
        this.selectedId = skin.id;
        this.previewingVictoryId = null; // selecting a different card stops any playing preview
        this._renderGrid();
        this._renderDetail();
      };
      this.gridEl.appendChild(card);
    });
  }

  // short=true is used on the compact card face; false gives the fuller
  // sentence shown in the detail panel.
  _unlockText(skin, short) {
    const u = skin.unlock;
    switch (u.type) {
      case 'coins': return short ? `\u{1F512} ${u.cost} coins` : `Unlock for ${u.cost} coins.`;
      case 'wins': return short ? `\u{1F512} Win ${u.count}` : `Win ${u.count} match${u.count === 1 ? '' : 'es'} to unlock.`;
      case 'killMilestone': return short ? `\u{1F512} ${u.count} kills` : `Reach ${u.count} lifetime kills to unlock.`;
      case 'achievement': return short ? '\u{1F512} Hidden' : 'Hidden achievement — keep playing to discover it.';
      case 'lootbox': return short ? '\u{1F512} Loot Box' : 'Only obtainable from a Loot Box.';
      default: return '';
    }
  }

  _renderDetail() {
    const skin = SKIN_BY_ID.get(this.selectedId);
    this.btnPreviewVictory.style.display = 'none';
    if (!skin) {
      this.detailName.textContent = 'Select a skin';
      this.detailRarity.textContent = '';
      this.detailReq.textContent = '';
      this.btnEquip.style.display = 'none';
      this.btnBuy.style.display = 'none';
      return;
    }
    const unlocked = this.profile.isUnlocked(skin.id);
    const equipped = this.profile.equipped[skin.category] === skin.id;
    const tier = RARITY_TIERS[skin.rarity];
    this.detailName.textContent = skin.name;
    this.detailRarity.textContent = tier.name;
    this.detailRarity.style.color = tier.color;
    this.detailReq.textContent = unlocked ? '' : this._unlockText(skin, false);

    this.btnEquip.style.display = unlocked ? 'inline-block' : 'none';
    this.btnEquip.textContent = equipped ? 'Equipped' : 'Equip';
    this.btnEquip.disabled = equipped;

    this.btnBuy.style.display = (!unlocked && skin.unlock.type === 'coins') ? 'inline-block' : 'none';
    if (this.btnBuy.style.display !== 'none') {
      const afford = this.profile.canAfford(skin);
      this.btnBuy.textContent = `Buy — ${skin.unlock.cost} coins`;
      this.btnBuy.disabled = !afford;
    }

    // Victory Animations get a dedicated Preview button (spec: "Clicking
    // Preview immediately plays the selected victory animation... Preview
    // should not require entering a match").
    if (skin.category === 'victory' && unlocked) {
      this.btnPreviewVictory.style.display = 'inline-block';
      this.btnPreviewVictory.textContent = this.previewingVictoryId === skin.id ? 'Playing…' : 'Preview';
    }
  }

  _equipSelected() {
    const skin = SKIN_BY_ID.get(this.selectedId);
    if (!skin) return;
    this.profile.equip(skin.category, skin.id);
    this._renderGrid();
    this._renderDetail();
    this._syncCosmetics();
  }

  _buySelected() {
    const skin = SKIN_BY_ID.get(this.selectedId);
    if (!skin) return;
    if (this.profile.purchase(skin.id)) {
      this.profile.equip(skin.category, skin.id); // equip immediately after purchase — expected UX
      this._updateCoinDisplay();
      this._renderGrid();
      this._renderDetail();
      this._syncCosmetics();
    }
  }

  _previewVictory() {
    const skin = SKIN_BY_ID.get(this.selectedId);
    if (!skin || skin.category !== 'victory') return;
    this.previewingVictoryId = skin.id;
    this._previewT = 0;
    this._renderDetail();
  }

  _openLootbox() {
    const won = this.profile.openLootbox();
    this._updateCoinDisplay();
    this._renderGrid();
    if (won) {
      const tier = RARITY_TIERS[won.rarity];
      this.lootboxResult.textContent = `You got: ${won.name} (${tier.name})!`;
      this.lootboxResult.style.color = tier.color;
      this._syncCosmetics(); // the won item isn't auto-equipped, but coins/unlocks changed and other players should still see an unchanged-but-current loadout
    } else {
      this.lootboxResult.textContent = this.profile.coins < LOOTBOX_COST ? 'Not enough coins.' : 'Nothing left to win!';
      this.lootboxResult.style.color = 'var(--text-dim)';
    }
    this.lootboxResult.classList.add('show');
    clearTimeout(this._lootboxToastTimer);
    this._lootboxToastTimer = setTimeout(() => this.lootboxResult.classList.remove('show'), 2600);
  }

  _updateCoinDisplay() {
    this.coinDisplay.textContent = this.profile.coins + ' coins';
  }

  _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ---------------------------------------------------------- preview canvas
  _previewLoop(now) {
    const dt = Math.min(50, now - this._lastFrameTime);
    this._lastFrameTime = now;
    this._previewT += dt;

    this._updatePreviewCosmetics();
    this._drawPreview(dt);

    this._rafHandle = requestAnimationFrame((t) => this._previewLoop(t));
  }

  // Live-previews whatever card is currently selected in the grid (not yet
  // equipped) layered on top of everything else the player has equipped —
  // the "preview before equipping" behavior requested.
  _updatePreviewCosmetics() {
    const resolved = resolveEquippedCosmetics(this.profile);
    const selectedSkin = SKIN_BY_ID.get(this.selectedId);
    if (selectedSkin) {
      resolved[selectedSkin.category] = selectedSkin.params;
      // Keep previewing the chosen hair color even on a not-yet-equipped
      // hairstyle, so switching styles doesn't lose your color choice.
      if (selectedSkin.category === 'hair' && this.profile.hairColor) {
        resolved.hair = Object.assign({}, resolved.hair, { color: this.profile.hairColor });
      }
    }
    this._previewPlayer.cosmetics = resolved;
    this._previewPlayer.weapon = new Weapon(this.ui.selectedWeapon || 'sword');
    this._previewPlayer.power = new Power(this.ui.selectedPower || 'fire');
    this._previewPlayer.color = PLAYER_COLORS[0];
  }

  _drawPreview(dt) {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#1b2038');
    grad.addColorStop(1, '#0a0c16');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const footX = w / 2, footY = h * 0.82;
    const p = this._previewPlayer;

    // Static, front-facing preview with a subtle idle bob/breathing motion
    // instead of a full rotation — reads as "alive" without ever looking
    // like a glitch at the edge-on frame a turntable spin would pass through.
    const idleAnim = this._equippedHasIdleAnim();
    const bobY = Math.sin(this._previewT / 450) * (idleAnim ? 4 : 2);

    // ground shadow
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(footX, footY + 4, 42 * this._zoom, 8 * this._zoom, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    p.x = 0; p.y = 0; p.facing = 1;
    p.animPhase += dt * 0.006;
    p.invulnTimer = 0;
    p.alive = true;

    if (this.previewingVictoryId) {
      const skin = SKIN_BY_ID.get(this.previewingVictoryId);
      p.state = 'victory';
      p.victoryPoseId = skin ? skin.params.style : null;
      p.animTimer = this._previewT;
    } else {
      p.state = 'idle';
    }

    ctx.save();
    ctx.translate(footX, footY + bobY);
    ctx.scale(this._zoom, this._zoom);
    p.draw(ctx, { showHpBar: false });
    ctx.restore();
  }

  _equippedHasIdleAnim() {
    for (const cat of SKIN_CATEGORIES) {
      const id = this.profile.equipped[cat.id];
      const skin = id ? SKIN_BY_ID.get(id) : null;
      if (skin && RARITY_TIERS[skin.rarity].idleAnim) return true;
    }
    const selected = SKIN_BY_ID.get(this.selectedId);
    return !!(selected && RARITY_TIERS[selected.rarity].idleAnim);
  }
}
