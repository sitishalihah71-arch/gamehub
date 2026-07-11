/* ============================================================
   cosmetics.js
   Data model for the Wardrobe / progression system: rarity
   tiers, the skin catalog, and the localStorage-backed player
   profile (coins, unlocks, equipped loadout, lifetime stats).

   This file has no dependency on game.js/player.js — it's pure
   data + persistence, reused by wardrobe.js (the menu UI),
   player.js (actual rendering), and multiplayer.js (roster sync
   carries the *resolved* params object produced by
   resolveEquippedCosmetics() below, so every peer renders
   identically without needing its own catalog lookup).
   ============================================================ */

// ---- Rarity tiers --------------------------------------------------------
const RARITY_TIERS = {
  common:    { id: 'common',    name: 'Common',    color: '#9aa3c0', glow: '#c7ccd9', idleAnim: false },
  rare:      { id: 'rare',      name: 'Rare',      color: '#5cc8ff', glow: '#a8e6ff', idleAnim: false },
  epic:      { id: 'epic',      name: 'Epic',      color: '#b56bff', glow: '#e6c8ff', idleAnim: false },
  legendary: { id: 'legendary', name: 'Legendary', color: '#ffce54', glow: '#fff2b8', idleAnim: true },
  mythic:    { id: 'mythic',    name: 'Mythic',    color: '#ff5cf1', glow: '#fff066', idleAnim: true },
};
const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary', 'mythic'];

// ---- Hair color customization ---------------------------------------------
// Free (no unlock needed) — every player can pick their own hair color,
// independent of which hairstyle or Character Skin they've equipped. Applies
// to whichever hairstyle is currently equipped; see resolveEquippedCosmetics().
const HAIR_COLOR_PRESETS = [
  '#1a1a1a', '#5b3a24', '#a13a1f', '#e8c477', '#c4c9d4',
  '#f5f5f5', '#5cc8ff', '#ff8fd6', '#b56bff', '#7dff8f',
];

// ---- Cosmetic categories --------------------------------------------------
// Aura/Glow and Emote were removed per design direction — fewer, more
// visible categories that every player can immediately tell apart on a
// small stick figure, rather than subtle effects that don't read well.
const SKIN_CATEGORIES = [
  { id: 'character',  label: 'Character Skin', icon: '\u{1F9CD}' },
  { id: 'hair',        label: 'Hair',           icon: '\u{1F487}' },
  { id: 'expression',  label: 'Face Expression', icon: '\u{1F60A}' },
  { id: 'helmet',      label: 'Helmet / Hat',   icon: '\u{1FA96}' },
  { id: 'weaponSkin',  label: 'Weapon Skin',    icon: '\u{2694}\u{FE0F}' },
  { id: 'victory',     label: 'Victory Animation', icon: '\u{1F3C6}' },
];

// ---- Skin catalog ---------------------------------------------------------
// Each entry: { id, category, name, rarity, unlock, params }
//   unlock.type: 'default' | 'coins' | 'wins' | 'killMilestone' | 'achievement' | 'lootbox'
//   params: category-specific render data consumed by Player.draw() (player.js)
//           and every preview surface (wardrobe, lobby cards, winner screen).
const SKIN_CATALOG = [
  // ---- Character Skin: recolors the base stick figure (primary + accent) ----
  { id: 'char_default',   category: 'character', name: 'Fighter',         rarity: 'common',    unlock: { type: 'default' },                          params: { primary: null, accent: null } },
  { id: 'char_crimson',   category: 'character', name: 'Crimson Blade',   rarity: 'common',    unlock: { type: 'coins', cost: 150 },                  params: { primary: '#c72c2c', accent: '#7a1f1f' } },
  { id: 'char_shadow',    category: 'character', name: 'Shadow Walker',   rarity: 'epic',       unlock: { type: 'wins', count: 5 },                    params: { primary: '#2b2f45', accent: '#b56bff' } },
  { id: 'char_golden',    category: 'character', name: 'Golden Champion', rarity: 'legendary',  unlock: { type: 'wins', count: 20 },                   params: { primary: '#ffce54', accent: '#a3791b' } },
  { id: 'char_prismatic', category: 'character', name: 'Prismatic',       rarity: 'mythic',     unlock: { type: 'achievement', id: 'flawless_victory' }, params: { primary: 'rainbow', accent: '#ffffff' } },

  // ---- Hair: color inherits the equipped Character Skin unless specified ----
  { id: 'hair_short',    category: 'hair', name: 'Short Hair',  rarity: 'common',    unlock: { type: 'default' },                params: { style: 'short', color: null } },
  { id: 'hair_none',     category: 'hair', name: 'Bald',        rarity: 'common',    unlock: { type: 'default' },                params: { style: null } },
  { id: 'hair_messy',    category: 'hair', name: 'Messy Hair',  rarity: 'common',    unlock: { type: 'coins', cost: 50 },         params: { style: 'messy', color: null } },
  { id: 'hair_ponytail', category: 'hair', name: 'Ponytail',    rarity: 'common',    unlock: { type: 'coins', cost: 60 },         params: { style: 'ponytail', color: null } },
  { id: 'hair_bobcut',   category: 'hair', name: 'Bob Cut',     rarity: 'common',    unlock: { type: 'coins', cost: 60 },         params: { style: 'bobcut', color: null } },
  { id: 'hair_mullet',   category: 'hair', name: 'Mullet',      rarity: 'rare',       unlock: { type: 'coins', cost: 100 },        params: { style: 'mullet', color: null } },
  { id: 'hair_long',     category: 'hair', name: 'Long Hair',   rarity: 'rare',       unlock: { type: 'wins', count: 3 },          params: { style: 'long', color: null } },
  { id: 'hair_bun',      category: 'hair', name: 'Bun',         rarity: 'rare',       unlock: { type: 'killMilestone', count: 30 }, params: { style: 'bun', color: null } },
  { id: 'hair_spiky',    category: 'hair', name: 'Spiky Hair',  rarity: 'epic',       unlock: { type: 'killMilestone', count: 80 }, params: { style: 'spiky', color: null } },
  { id: 'hair_twintail', category: 'hair', name: 'Twin Tail',   rarity: 'epic',       unlock: { type: 'lootbox' },                 params: { style: 'twintail', color: '#5cc8ff' } },
  { id: 'hair_mohawk',   category: 'hair', name: 'Mohawk',      rarity: 'legendary',  unlock: { type: 'wins', count: 15 },         params: { style: 'mohawk', color: '#ff5cf1' } },

  // ---- Face Expression: eyes + mouth, always visible on any character skin ----
  { id: 'expr_neutral',     category: 'expression', name: 'Neutral',     rarity: 'common', unlock: { type: 'default' },                        params: { style: 'neutral' } },
  { id: 'expr_smile',       category: 'expression', name: 'Smile',       rarity: 'common', unlock: { type: 'default' },                        params: { style: 'smile' } },
  { id: 'expr_happy',       category: 'expression', name: 'Happy',       rarity: 'common', unlock: { type: 'coins', cost: 40 },                 params: { style: 'happy' } },
  { id: 'expr_angry',       category: 'expression', name: 'Angry',       rarity: 'common', unlock: { type: 'coins', cost: 40 },                 params: { style: 'angry' } },
  { id: 'expr_sad',         category: 'expression', name: 'Sad',         rarity: 'rare',    unlock: { type: 'coins', cost: 80 },                 params: { style: 'sad' } },
  { id: 'expr_cool',        category: 'expression', name: 'Cool',        rarity: 'rare',    unlock: { type: 'wins', count: 5 },                  params: { style: 'cool' } },
  { id: 'expr_surprised',   category: 'expression', name: 'Surprised',   rarity: 'epic',    unlock: { type: 'killMilestone', count: 60 },        params: { style: 'surprised' } },
  { id: 'expr_determined',  category: 'expression', name: 'Determined',  rarity: 'epic',    unlock: { type: 'achievement', id: 'no_death_win' }, params: { style: 'determined' } },

  // ---- Helmet / Hat: extra shape drawn above the hair ----
  { id: 'helm_none',  category: 'helmet', name: 'None',              rarity: 'common',   unlock: { type: 'default' },                 params: { style: null } },
  { id: 'helm_cap',   category: 'helmet', name: 'Scout Cap',         rarity: 'common',   unlock: { type: 'coins', cost: 80 },          params: { style: 'cap', color: '#5cc8ff' } },
  { id: 'helm_horns', category: 'helmet', name: 'Demon Horns',       rarity: 'rare',      unlock: { type: 'killMilestone', count: 50 }, params: { style: 'horns', color: '#ff5c5c' } },
  { id: 'helm_crown', category: 'helmet', name: "Champion's Crown",  rarity: 'legendary', unlock: { type: 'wins', count: 15 },          params: { style: 'crown', color: '#ffce54' } },
  { id: 'helm_halo',  category: 'helmet', name: 'Mythic Halo',       rarity: 'mythic',    unlock: { type: 'lootbox' },                  params: { style: 'halo', color: '#fff066' } },

  // ---- Weapon Skin: cosmetic-only color override (no stat changes) ----
  { id: 'wskin_none',    category: 'weaponSkin', name: 'Default',      rarity: 'common',   unlock: { type: 'default' },                 params: { color: null, accent: null } },
  { id: 'wskin_frost',   category: 'weaponSkin', name: 'Frostbite',    rarity: 'rare',      unlock: { type: 'coins', cost: 120 },         params: { color: '#69d9ff', accent: '#bff2ff' } },
  { id: 'wskin_venom',   category: 'weaponSkin', name: 'Venomstrike',  rarity: 'epic',      unlock: { type: 'killMilestone', count: 150 }, params: { color: '#bdf5c9', accent: '#3fae5a' } },
  { id: 'wskin_inferno', category: 'weaponSkin', name: 'Inferno Edge', rarity: 'legendary', unlock: { type: 'wins', count: 25 },          params: { color: '#ff7a3c', accent: '#ffce54' } },

  // ---- Victory Animation: played on the winner's victory freeze + winner screen ----
  { id: 'vic_wave',      category: 'victory', name: 'Wave',       rarity: 'common',    unlock: { type: 'default' },                 params: { style: 'wave' } },
  { id: 'vic_thumbsup',  category: 'victory', name: 'Thumbs Up',  rarity: 'common',    unlock: { type: 'coins', cost: 50 },          params: { style: 'thumbsup' } },
  { id: 'vic_peace',     category: 'victory', name: 'Peace Sign', rarity: 'common',    unlock: { type: 'coins', cost: 50 },          params: { style: 'peace' } },
  { id: 'vic_salute',    category: 'victory', name: 'Salute',     rarity: 'rare',      unlock: { type: 'coins', cost: 100 },         params: { style: 'salute' } },
  { id: 'vic_flex',      category: 'victory', name: 'Flex',       rarity: 'rare',      unlock: { type: 'wins', count: 3 },           params: { style: 'flex' } },
  { id: 'vic_hero',      category: 'victory', name: 'Hero Pose',  rarity: 'epic',      unlock: { type: 'killMilestone', count: 50 }, params: { style: 'hero' } },
  { id: 'vic_swordspin', category: 'victory', name: 'Sword Spin', rarity: 'epic',      unlock: { type: 'wins', count: 10 },          params: { style: 'swordspin' } },
  { id: 'vic_celebrate', category: 'victory', name: 'Celebrate',  rarity: 'legendary', unlock: { type: 'lootbox' },                  params: { style: 'celebrate' } },
];

const SKIN_BY_ID = new Map(SKIN_CATALOG.map(s => [s.id, s]));

// Hidden achievements: id -> display copy shown once the requirement is
// discovered (locked cards just show "Hidden" for these, per spec).
const ACHIEVEMENTS = {
  first_win:        { name: 'First Blood',      hint: 'Win your first match.' },
  flawless_victory: { name: 'Flawless Victory', hint: 'Win a match without dying.' },
  no_death_win:     { name: 'Untouchable',      hint: 'Win a match without dying.' },
};

// ---- Player profile (localStorage-backed) --------------------------------
const PROFILE_STORAGE_KEY = 'stickduel_profile_v1';
const LOOTBOX_COST = 150;
// Rarity weighting for loot boxes — rarer cosmetics are drawn less often.
const LOOTBOX_WEIGHTS = { common: 45, rare: 30, epic: 16, legendary: 7, mythic: 2 };

class PlayerProfile {
  constructor() {
    // No starter grant — coins are earned only by playing/winning matches
    // (see awardMatchResult, called from game.js at match end).
    this.coins = 0;
    this.unlocked = new Set();
    this.equipped = {};
    for (const cat of SKIN_CATEGORIES) this.equipped[cat.id] = null;
    this.stats = { matchesPlayed: 0, wins: 0, totalKills: 0, deathlessWins: 0 };
    this.achievements = new Set();
    this.hairColor = null; // null = use the equipped hairstyle's own default (inherit character skin, or a signature color)
    this._grantDefaults();
  }

  _grantDefaults() {
    for (const s of SKIN_CATALOG) {
      if (s.unlock.type === 'default') {
        this.unlocked.add(s.id);
        if (!this.equipped[s.category]) this.equipped[s.category] = s.id;
      }
    }
  }

  static load() {
    let raw = null;
    try { raw = localStorage.getItem(PROFILE_STORAGE_KEY); } catch (e) { /* localStorage unavailable */ }
    const profile = new PlayerProfile();
    if (!raw) return profile;
    try {
      const data = JSON.parse(raw);
      profile.coins = typeof data.coins === 'number' ? data.coins : profile.coins;
      profile.unlocked = new Set(data.unlocked || []);
      profile.equipped = Object.assign(profile.equipped, data.equipped || {});
      profile.stats = Object.assign(profile.stats, data.stats || {});
      profile.achievements = new Set(data.achievements || []);
      profile.hairColor = typeof data.hairColor === 'string' ? data.hairColor : null;
      profile._pruneRemovedCategories(); // drop stale aura/emote data from older saves
      profile._grantDefaults(); // in case new default items shipped since last save
    } catch (e) { /* corrupt save — fall back to a fresh profile */ }
    return profile;
  }

  // Older saves may still reference categories/ids that no longer exist
  // (Aura/Glow and Emote were removed) — strip them so the profile object
  // stays clean instead of carrying dead data forever.
  _pruneRemovedCategories() {
    const validCategoryIds = new Set(SKIN_CATEGORIES.map(c => c.id));
    for (const key of Object.keys(this.equipped)) {
      if (!validCategoryIds.has(key)) delete this.equipped[key];
      else if (this.equipped[key] && !SKIN_BY_ID.has(this.equipped[key])) this.equipped[key] = null;
    }
    for (const id of Array.from(this.unlocked)) {
      if (!SKIN_BY_ID.has(id)) this.unlocked.delete(id);
    }
  }

  save() {
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({
        coins: this.coins,
        unlocked: Array.from(this.unlocked),
        equipped: this.equipped,
        stats: this.stats,
        achievements: Array.from(this.achievements),
        hairColor: this.hairColor,
      }));
    } catch (e) { /* storage full/unavailable — equip/unlock still works for this session */ }
  }

  // Free customization, no unlock required — pass null to reset back to
  // whatever the equipped hairstyle's own default color is.
  setHairColor(color) {
    this.hairColor = color;
    this.save();
  }

  isUnlocked(id) { return this.unlocked.has(id); }

  canAfford(skin) { return skin.unlock.type === 'coins' && this.coins >= skin.unlock.cost; }

  // Spends coins to unlock a coins-gated skin. Returns true on success.
  purchase(skinId) {
    const skin = SKIN_BY_ID.get(skinId);
    if (!skin || skin.unlock.type !== 'coins' || this.isUnlocked(skinId) || !this.canAfford(skin)) return false;
    this.coins -= skin.unlock.cost;
    this.unlocked.add(skinId);
    this.save();
    return true;
  }

  equip(category, id) {
    if (id !== null && !this.isUnlocked(id)) return false;
    this.equipped[category] = id;
    this.save();
    return true;
  }

  // Called at match end with the local player's result. `matchCoins` is the
  // single source of truth for "coins earned this match" — everything the
  // Match Coin Reward System tallied during play (kills, participation,
  // victory bonus, and any future source; see game.js _awardCoins) — so the
  // wallet deposit always matches exactly what the Match Results screen
  // showed the player, instead of this method computing its own amounts.
  awardMatchResult({ won, kills = 0, deaths = 0, matchCoins = 0 }) {
    this.stats.matchesPlayed += 1;
    this.coins += matchCoins;
    this.stats.totalKills += kills;
    if (won) {
      this.stats.wins += 1;
      if (deaths === 0) {
        this.stats.deathlessWins += 1;
        this._unlockAchievement('flawless_victory');
        this._unlockAchievement('no_death_win');
      }
      if (this.stats.wins === 1) this._unlockAchievement('first_win');
    }
    this._checkMilestones();
    this.save();
  }

  _unlockAchievement(achId) {
    if (this.achievements.has(achId)) return;
    this.achievements.add(achId);
    for (const s of SKIN_CATALOG) {
      if (s.unlock.type === 'achievement' && s.unlock.id === achId) this.unlocked.add(s.id);
    }
  }

  _checkMilestones() {
    for (const s of SKIN_CATALOG) {
      if (this.unlocked.has(s.id)) continue;
      if (s.unlock.type === 'wins' && this.stats.wins >= s.unlock.count) this.unlocked.add(s.id);
      else if (s.unlock.type === 'killMilestone' && this.stats.totalKills >= s.unlock.count) this.unlocked.add(s.id);
    }
  }

  // Opens a loot box: spends LOOTBOX_COST coins, returns the unlocked skin
  // (weighted-random by rarity, only among not-yet-owned lootbox items), or
  // null if the player can't afford it or has already unlocked everything.
  openLootbox() {
    if (this.coins < LOOTBOX_COST) return null;
    const pool = SKIN_CATALOG.filter(s => s.unlock.type === 'lootbox' && !this.unlocked.has(s.id));
    if (pool.length === 0) return null;
    this.coins -= LOOTBOX_COST;
    const totalWeight = pool.reduce((sum, s) => sum + (LOOTBOX_WEIGHTS[s.rarity] || 1), 0);
    let roll = Math.random() * totalWeight;
    let picked = pool[pool.length - 1];
    for (const s of pool) {
      roll -= (LOOTBOX_WEIGHTS[s.rarity] || 1);
      if (roll <= 0) { picked = s; break; }
    }
    this.unlocked.add(picked.id);
    this.save();
    return picked;
  }
}

// Expands a profile's equipped skin ids into the params objects Player.draw()
// (and every preview surface) actually consume, keyed by category. This is
// exactly what travels over the wire in the lobby roster (see
// NetworkManager.setLocalCosmetics in multiplayer.js) — every peer renders
// from the same resolved data instead of re-deriving it from ids.
function resolveEquippedCosmetics(profile) {
  const resolved = {};
  for (const cat of SKIN_CATEGORIES) {
    const id = profile.equipped[cat.id];
    const skin = id ? SKIN_BY_ID.get(id) : null;
    resolved[cat.id] = skin ? skin.params : null;
  }
  // Custom hair color overrides whatever the equipped hairstyle's own
  // default is — applied via a shallow copy so we never mutate the shared
  // SKIN_CATALOG params object that `resolved.hair` currently points at.
  if (profile.hairColor && resolved.hair) {
    resolved.hair = Object.assign({}, resolved.hair, { color: profile.hairColor });
  }
  return resolved;
}

// A rotating "rainbow" color used by mythic cosmetics with params.color/primary === 'rainbow'.
function rainbowColor(t) {
  return `hsl(${(t * 60) % 360}, 85%, 65%)`;
}
