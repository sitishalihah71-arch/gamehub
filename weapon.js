/* ============================================================
   weapon.js
   Defines the 4 weapon types and 5 elemental powers, plus a
   lightweight Weapon class that a Player instance owns.
   ============================================================ */

// ---- Weapon archetypes -------------------------------------------------
// range   : reach of a light attack, in pixels, from the player's center
// speed   : cooldown between light attacks, in ms (lower = faster)
// damage  : light attack damage
// heavyDamage / heavyRange / heavySpeed : stats for the K attack
const WEAPON_TYPES = {
  sword: {
    id: 'sword', name: 'Sword', color: '#d7dbe4', accent: '#9aa3c0',
    damage: 8, range: 70, speed: 260, knockback: 6,
    heavyDamage: 17, heavyRange: 78, heavySpeed: 520, heavyKnockback: 11,
    swingArc: Math.PI * 0.9,
  },
  katana: {
    id: 'katana', name: 'Katana', color: '#eaf1ff', accent: '#8fd3ff',
    damage: 6, range: 62, speed: 160, knockback: 4,
    heavyDamage: 13, heavyRange: 72, heavySpeed: 380, heavyKnockback: 8,
    swingArc: Math.PI * 1.2,
  },
  spear: {
    id: 'spear', name: 'Spear', color: '#c99a5b', accent: '#8a5a2b',
    damage: 10, range: 112, speed: 360, knockback: 7,
    heavyDamage: 20, heavyRange: 130, heavySpeed: 620, heavyKnockback: 13,
    swingArc: Math.PI * 0.35,
  },
  hammer: {
    id: 'hammer', name: 'Hammer', color: '#9b9b9b', accent: '#5b5b5b',
    damage: 14, range: 66, speed: 520, knockback: 13,
    heavyDamage: 28, heavyRange: 80, heavySpeed: 820, heavyKnockback: 20,
    swingArc: Math.PI * 1.4,
  },

  // ---- Pickup-only ranged weapons (Feature 2/3 item drops) -------------
  // isRanged weapons fire a Projectile (same class used by skills/ults)
  // instead of resolving a melee hitbox — see game.js `_spawnWeaponProjectile`.
  gun: {
    id: 'gun', name: 'Gun', color: '#ffe27a', accent: '#c9a227',
    damage: 9, range: 40, speed: 260, knockback: 3, isRanged: true,
    projectileSpeed: 18, projectileRadius: 7, splashRadius: 0,
    heavyDamage: 9, heavyRange: 40, heavySpeed: 260, heavyKnockback: 3,
    swingArc: Math.PI * 0.4,
  },
  rocket: {
    id: 'rocket', name: 'Rocket Launcher', color: '#ff8f5c', accent: '#a3401b',
    damage: 22, range: 40, speed: 900, knockback: 10, isRanged: true,
    projectileSpeed: 11, projectileRadius: 15, splashRadius: 75,
    heavyDamage: 22, heavyRange: 40, heavySpeed: 900, heavyKnockback: 10,
    swingArc: Math.PI * 0.4,
  },
};

// ---- Elemental powers ---------------------------------------------------
// Skill (L) = fast projectile / burst. Ultimate (U) = big AoE around caster.
const POWER_TYPES = {
  fire: {
    id: 'fire', name: 'Fire', color: '#ff7a3c', glow: '#ffb066',
    skillDamage: 15, skillCooldown: 6000, skillSpeed: 11, skillRadius: 14,
    ultDamage: 42, ultCooldown: 24000, ultRadius: 190,
    statusOnHit: 'burn',
  },
  ice: {
    id: 'ice', name: 'Ice', color: '#69d9ff', glow: '#bff2ff',
    skillDamage: 10, skillCooldown: 6000, skillSpeed: 9, skillRadius: 13,
    ultDamage: 34, ultCooldown: 24000, ultRadius: 180,
    statusOnHit: 'slow',
  },
  lightning: {
    id: 'lightning', name: 'Lightning', color: '#fff066', glow: '#fffbc2',
    skillDamage: 12, skillCooldown: 5000, skillSpeed: 16, skillRadius: 10,
    ultDamage: 38, ultCooldown: 24000, ultRadius: 210,
    statusOnHit: 'stun',
  },
  wind: {
    id: 'wind', name: 'Wind', color: '#bdf5c9', glow: '#eafff0',
    skillDamage: 8, skillCooldown: 5000, skillSpeed: 13, skillRadius: 16,
    ultDamage: 28, ultCooldown: 22000, ultRadius: 220,
    statusOnHit: 'knockback',
  },
  shadow: {
    id: 'shadow', name: 'Shadow', color: '#b56bff', glow: '#e6c8ff',
    skillDamage: 14, skillCooldown: 6500, skillSpeed: 14, skillRadius: 12,
    ultDamage: 44, ultCooldown: 26000, ultRadius: 170,
    statusOnHit: 'weaken',
  },
};

class Weapon {
  constructor(typeId) {
    const def = WEAPON_TYPES[typeId] || WEAPON_TYPES.sword;
    Object.assign(this, def);
  }

  // Cosmetic-only color override (Wardrobe weapon skins) — never touches
  // damage/range/speed, so equipping a skin can't affect balance.
  applySkin(skinParams) {
    if (!skinParams) return;
    if (skinParams.color) this.color = skinParams.color;
    if (skinParams.accent) this.accent = skinParams.accent;
  }
}

class Power {
  constructor(typeId) {
    const def = POWER_TYPES[typeId] || POWER_TYPES.fire;
    Object.assign(this, def);
  }
}

// Builds a boosted Sword by reusing the Weapon class and scaling its
// numbers, instead of duplicating a whole new weapon definition.
// Used by the "Sword Upgrade" item pickup (Feature 2/3).
function makeUpgradedSword(mult = 1.2) {
  const w = new Weapon('sword');
  w.name = 'Sword+';
  w.damage = Math.round(w.damage * mult);
  w.heavyDamage = Math.round(w.heavyDamage * mult);
  return w;
}
