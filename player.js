/* ============================================================
   player.js
   Player entity: physics, state machine, combat resolution and
   procedural stickman rendering (no sprite assets required).
   ============================================================ */

const PHYSICS = {
  GRAVITY: 0.62,
  MOVE_SPEED: 4.6,
  AIR_SPEED: 3.6,
  FRICTION: 0.78,
  JUMP_VELOCITY: -15,
  DASH_SPEED: 15,
  DASH_TIME: 0.14,       // seconds
  DASH_COOLDOWN: 900,    // ms
  MAX_FALL: 22,
  HITSTUN_KNOCKUP: -4,
};

const MAX_HEALTH = 100;
const COMBO_WINDOW = 650; // ms to chain another light attack

class Player {
  constructor(id, name, x, y, color, weaponId, powerId) {
    this.id = id;
    this.name = name || 'Fighter';
    this.color = color;

    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.width = 34; this.height = 82;
    this.facing = 1;
    this.grounded = false;

    this.weapon = new Weapon(weaponId);
    this.power = new Power(powerId);
    this.baseWeaponId = weaponId || 'sword'; // original lobby loadout, restored on Restart Match

    // --- item pickup buffs (Feature 2/3) ---
    this.previousWeapon = null;   // weapon to revert to when a temp weapon (gun/rocket) expires
    this.tempWeaponTimer = 0;     // ms remaining on a temporary weapon pickup
    this.shieldTimer = 0;         // ms remaining of 50% damage reduction
    this.ultTelegraph = null;     // {radius, color} while an ultimate's AoE indicator is showing (Feature 4)

    this.health = MAX_HEALTH;
    this.maxHealth = MAX_HEALTH;
    this.alive = true;
    this.disconnected = false; // host-side: true while this peer's connection is down (see multiplayer.js)
    this.respawnTimer = 0;
    this.invulnTimer = 0;

    this.state = 'idle'; // idle, run, jump, fall, dash, attack1, attack2, skill, ult, hit, dead
    this.animTimer = 0;
    this.animPhase = 0; // used for leg cycle etc.

    // cooldown timers, in ms, counted down externally
    this.attackCooldown = 0;
    this.heavyCooldown = 0;
    this.dashCooldown = 0;
    this.skillCooldown = 0;
    this.ultCooldown = 0;

    this.hitstunTimer = 0;
    this.dashTimer = 0;

    this.comboCount = 0;
    this.comboResetTimer = 0;

    this.currentAttack = null; // {type,duration,hitFrom,hitTo,hasHit,dmg,range,knockback}
    this.score = 0; // kills
    this.deaths = 0;
    this.matchCoins = 0; // coins earned THIS match only (kills, participation, victory bonus, etc.) — separate from the permanent wallet (PlayerProfile.coins in cosmetics.js)

    // Wardrobe cosmetics — resolved params keyed by category (see
    // cosmetics.js: resolveEquippedCosmetics()), or null for "no cosmetics
    // applied" so existing gameplay/rendering is byte-for-byte unaffected
    // until something actually equips a skin.
    this.cosmetics = null;

    // Victory Animation cosmetic playback — set when a match ends (game.js
    // _onKill) or when previewed in the Wardrobe. Reuses state/animTimer
    // (state='victory') instead of adding a parallel animation clock.
    this.victoryPoseId = null;

    this.spawnX = x; this.spawnY = y;

    // input snapshot applied each tick (edge-triggered booleans consumed once)
    this.input = {
      left: false, right: false,
      jump: false, dash: false,
      attack: false, heavy: false, skill: false, ult: false,
      pickup: false,
    };
  }

  isBusyState() {
    return ['attack1', 'attack2', 'skill', 'ult', 'hit', 'dead'].includes(this.state);
  }

  canAct() {
    return this.alive && this.hitstunTimer <= 0 && this.state !== 'dead';
  }

  // ---------------------------------------------------------------
  requestSkill() {
    if (this.canAct() && this.skillCooldown <= 0 && this.state !== 'skill' && this.state !== 'ult') {
      this.skillCooldown = this.power.skillCooldown;
      this.state = 'skill';
      this.animTimer = 0;
      return true;
    }
    return false;
  }

  requestUltimate() {
    if (this.canAct() && this.ultCooldown <= 0 && this.state !== 'skill' && this.state !== 'ult') {
      this.ultCooldown = this.power.ultCooldown;
      this.state = 'ult';
      this.animTimer = 0;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------
  update(dtMs, platforms, arenaWidth) {
    const dt = dtMs / 1000;

    // --- countdown timers ---
    this.attackCooldown = Math.max(0, this.attackCooldown - dtMs);
    this.heavyCooldown = Math.max(0, this.heavyCooldown - dtMs);
    this.dashCooldown = Math.max(0, this.dashCooldown - dtMs);
    this.skillCooldown = Math.max(0, this.skillCooldown - dtMs);
    this.ultCooldown = Math.max(0, this.ultCooldown - dtMs);
    this.invulnTimer = Math.max(0, this.invulnTimer - dtMs);
    if (this.hitstunTimer > 0) this.hitstunTimer = Math.max(0, this.hitstunTimer - dtMs);
    if (this.comboResetTimer > 0) {
      this.comboResetTimer -= dtMs;
      if (this.comboResetTimer <= 0) this.comboCount = 0;
    }

    // --- item buff timers (Feature 2/3) ---
    if (this.shieldTimer > 0) this.shieldTimer = Math.max(0, this.shieldTimer - dtMs);
    if (this.tempWeaponTimer > 0) {
      this.tempWeaponTimer -= dtMs;
      if (this.tempWeaponTimer <= 0) {
        this.tempWeaponTimer = 0;
        this.weapon = this.previousWeapon || new Weapon(this.baseWeaponId);
        this.previousWeapon = null;
      }
    }

    if (!this.alive) {
      this.respawnTimer -= dtMs;
      this.animTimer += dtMs;
      if (this.respawnTimer <= 0) this._respawn();
      return;
    }

    const inp = this.input;

    // --- start actions (only when free) ---
    if (this.canAct() && !this.isBusyState()) {
      if (inp.dash && this.dashCooldown <= 0) {
        this.state = 'dash';
        this.dashTimer = PHYSICS.DASH_TIME;
        this.dashCooldown = PHYSICS.DASH_COOLDOWN;
        this.vx = PHYSICS.DASH_SPEED * this.facing;
        this.vy = 0;
      } else if (inp.attack && this.attackCooldown <= 0) {
        this._startAttack('attack1');
      } else if (inp.heavy && this.heavyCooldown <= 0) {
        this._startAttack('attack2');
      }
    }
    // combo continuation mid recovery window is allowed via cooldown gate above.

    // --- horizontal movement (allowed unless dashing/attacking/hit/dead) ---
    const lockedMove = ['dash', 'hit', 'dead'].includes(this.state);
    if (!lockedMove) {
      const speed = this.grounded ? PHYSICS.MOVE_SPEED : PHYSICS.AIR_SPEED;
      if (inp.left && !inp.right) { this.vx = -speed; this.facing = -1; }
      else if (inp.right && !inp.left) { this.vx = speed; this.facing = 1; }
      else { this.vx *= PHYSICS.FRICTION; if (Math.abs(this.vx) < 0.05) this.vx = 0; }

      if (inp.jump && this.grounded && this.state !== 'attack1' && this.state !== 'attack2') {
        this.vy = PHYSICS.JUMP_VELOCITY;
        this.grounded = false;
      }
    }

    // --- dash timer ---
    if (this.state === 'dash') {
      this.dashTimer -= dt;
      if (this.dashTimer <= 0) {
        this.state = this.grounded ? 'idle' : 'fall';
        this.vx *= 0.4;
      }
    }

    // --- gravity ---
    if (!this.grounded) {
      this.vy += PHYSICS.GRAVITY;
      if (this.vy > PHYSICS.MAX_FALL) this.vy = PHYSICS.MAX_FALL;
    }

    // --- integrate position ---
    this.x += this.vx;
    this.y += this.vy;

    // --- world bounds ---
    if (this.x < this.width / 2) this.x = this.width / 2;
    if (this.x > arenaWidth - this.width / 2) this.x = arenaWidth - this.width / 2;

    // --- platform collision (AABB, land on top only) ---
    this.grounded = false;
    for (const plat of platforms) {
      const feetPrev = this.y - this.vy;
      const withinX = this.x + this.width / 2 - 6 > plat.x && this.x - this.width / 2 + 6 < plat.x + plat.w;
      // only snap to the platform if we were at/above its surface last
      // frame and have now reached or crossed it while falling — avoids
      // snapping onto platforms far below or side-clipping through edges.
      const crossedSurface = this.vy >= 0 && feetPrev <= plat.y + 1 && this.y >= plat.y;
      if (withinX && crossedSurface) {
        this.y = plat.y;
        this.vy = 0;
        this.grounded = true;
      }
    }
    // floor fallback (respawn if falls off world)
    if (this.y > 900) {
      this.takeDamage(9999, this.x, 0, null); // fall death
    }

    // --- attack lifecycle ---
    if (this.currentAttack) {
      this.animTimer += dtMs;
      const a = this.currentAttack;
      if (!a.hasHit && this.animTimer >= a.activeStart && this.animTimer <= a.activeEnd) {
        a.hitboxLive = true;
      } else {
        a.hitboxLive = false;
      }
      if (this.animTimer >= a.duration) {
        this.currentAttack = null;
        this.state = this.grounded ? 'idle' : 'fall';
      }
    } else if (this.state === 'skill' || this.state === 'ult') {
      this.animTimer += dtMs;
      const dur = this.state === 'skill' ? 380 : 700;
      if (this.animTimer >= dur) {
        this.state = this.grounded ? 'idle' : 'fall';
      }
    } else if (this.state === 'hit') {
      this.animTimer += dtMs;
      if (this.hitstunTimer <= 0) this.state = this.grounded ? 'idle' : 'fall';
    }

    // --- idle/run/fall/jump state resolution when free ---
    if (!this.currentAttack && !['dash', 'skill', 'ult', 'hit', 'dead'].includes(this.state)) {
      if (!this.grounded) this.state = this.vy < 0 ? 'jump' : 'fall';
      else this.state = Math.abs(this.vx) > 0.4 ? 'run' : 'idle';
    }

    // walking animation phase
    if (this.state === 'run') this.animPhase += dtMs * 0.02;
    else this.animPhase += dtMs * 0.006;

    // reset one-shot input flags (edge-triggered)
    // NOTE: 'pickup' is intentionally NOT reset here — game.js resolves
    // pickups *after* this physics update runs, using the current tick's
    // p.input.pickup value. It's safe to leave alone since both the local
    // and remote input paths fully overwrite it every tick anyway.
    inp.dash = false; inp.attack = false; inp.heavy = false; inp.skill = false; inp.ult = false; inp.jump = false;
  }

  _startAttack(type) {
    const w = this.weapon;
    const heavy = type === 'attack2';
    const duration = heavy ? w.heavySpeed : w.speed;
    this.state = type;
    this.animTimer = 0;
    if (!heavy) {
      this.comboCount = (this.comboResetTimer > 0) ? Math.min(this.comboCount + 1, 2) : 0;
      this.comboResetTimer = COMBO_WINDOW;
    } else {
      this.comboCount = 0;
      this.comboResetTimer = 0;
    }
    const dmgMult = 1 + this.comboCount * 0.18;
    this.currentAttack = {
      type,
      duration,
      activeStart: duration * 0.28,
      activeEnd: duration * 0.62,
      hitboxLive: false,
      hasHit: false,
      damage: (heavy ? w.heavyDamage : w.damage) * dmgMult,
      range: heavy ? w.heavyRange : w.range,
      knockback: heavy ? w.heavyKnockback : w.knockback,
      rangedSpawned: false, // consumed by game.js for isRanged weapons (gun/rocket pickups)
    };
    if (heavy) this.heavyCooldown = duration + 80;
    else this.attackCooldown = duration + 40;
  }

  // Returns an active melee hitbox rectangle, or null.
  getActiveHitbox() {
    const a = this.currentAttack;
    if (!a || !a.hitboxLive || a.hasHit) return null;
    const reach = a.range;
    const x = this.facing === 1 ? this.x : this.x - reach;
    return { x, y: this.y - this.height * 0.75, w: reach, h: this.height * 0.6, dmg: a.damage, kb: a.knockback };
  }

  markAttackHit() {
    if (this.currentAttack) this.currentAttack.hasHit = true;
  }

  getBounds() {
    return { x: this.x - this.width / 2, y: this.y - this.height, w: this.width, h: this.height };
  }

  takeDamage(amount, sourceX, knockback, status) {
    if (!this.alive || this.invulnTimer > 0) return false;
    if (this.shieldTimer > 0) amount *= 0.5; // Shield pickup: 50% damage reduction (Feature 2)
    this.health -= amount;
    this.hitstunTimer = Math.min(500, 120 + amount * 4);
    this.state = 'hit';
    this.animTimer = 0;
    const dir = this.x >= sourceX ? 1 : -1;
    this.vx = dir * (knockback || 4);
    this.vy = PHYSICS.HITSTUN_KNOCKUP - (knockback || 0) * 0.15;
    this.grounded = false;

    if (status === 'stun') this.hitstunTimer += 220;
    if (status === 'slow') this._slowUntil = Date.now() + 1200;
    if (status === 'knockback') this.vx *= 1.8;

    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.state = 'dead';
      this.respawnTimer = 3000;
      return true; // died
    }
    return false;
  }

  _respawn() {
    this.alive = true;
    this.health = this.maxHealth;
    this.x = this.spawnX; this.y = this.spawnY;
    this.vx = 0; this.vy = 0;
    this.state = 'idle';
    this.invulnTimer = 1500;
    this.currentAttack = null;
    this.comboCount = 0;
    this.victoryPoseId = null; // cosmetics themselves (this.cosmetics) are untouched by respawn
  }

  // =========================== RENDER ===========================
  // opts.showHpBar=false is used by the Wardrobe preview canvas (see
  // wardrobe.js), which reuses this exact method so the preview can never
  // visually drift from how the player actually looks in a real match.
  draw(ctx, opts = {}) {
    const showHpBar = opts.showHpBar !== false;
    if (!this.alive) return;
    ctx.save();
    ctx.translate(this.x, this.y);

    if (this.invulnTimer > 0 && Math.floor(this.invulnTimer / 100) % 2 === 0) {
      ctx.globalAlpha = 0.4;
    }

    // Character Skin cosmetic recolors the whole figure (a 'rainbow' primary
    // cycles hue over time for Mythic skins). Falls back to the player's
    // chosen color when no cosmetic is equipped — zero behavior change.
    const charSkin = this.cosmetics && this.cosmetics.character;
    const c = charSkin && charSkin.primary
      ? (charSkin.primary === 'rainbow' ? rainbowColor(Date.now() / 1000) : charSkin.primary)
      : this.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = 5;

    const H = this.height;
    const bob = this.state === 'idle' ? Math.sin(this.animPhase) * 2 : 0;
    const headR = 9;
    const hipY = -H * 0.5 + bob;
    const headY = -H + headR + 2 + bob;
    const shoulderY = -H * 0.78 + bob;

    let legSwing = 0, armSwing = 0.3, lean = 0;
    if (this.state === 'run') legSwing = Math.sin(this.animPhase) * 0.7;
    if (this.state === 'jump') { legSwing = -0.4; armSwing = -0.6; }
    if (this.state === 'fall') { legSwing = 0.3; armSwing = 0.5; }
    if (this.state === 'dash') { lean = this.facing * 0.5; legSwing = 0.5; }
    if (this.state === 'hit') { lean = -this.facing * 0.3; }
    if (this.state === 'victory') legSwing = -0.15; // slightly widened, confident stance

    ctx.save();
    ctx.rotate(lean * 0.15);

    // legs
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(-8 + legSwing * 12, 0);
    ctx.moveTo(0, hipY);
    ctx.lineTo(8 - legSwing * 12, 0);
    ctx.stroke();

    // torso
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(0, shoulderY);
    ctx.stroke();

    // arms + weapon (drawn by attack-state / victory-pose logic)
    this._drawArmsAndWeapon(ctx, shoulderY, armSwing);

    // head
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, Math.PI * 2);
    ctx.fill();

    // Hair -> Face Expression -> Helmet, in that order, so a helmet always
    // layers above hair (per spec) while the expression stays visible
    // rather than being covered by a hairstyle.
    if (this.cosmetics) {
      this._drawHair(ctx, headY, headR, c);
      this._drawFaceExpression(ctx, headY, headR);
      this._drawHelmet(ctx, headY, headR);
    }

    ctx.restore();

    ctx.globalAlpha = 1;
    ctx.restore();

    if (showHpBar) this._drawNamePlate(ctx);
  }

  // ---- Wardrobe cosmetic overlays -------------------------------------
  // Each is a small, self-contained procedural shape keyed by the equipped
  // skin's `style` id (see cosmetics.js SKIN_CATALOG). Unknown/null styles
  // draw nothing, so adding new catalog entries never requires touching
  // gameplay code beyond adding a case here.
  _drawHelmet(ctx, headY, headR) {
    const helm = this.cosmetics.helmet;
    if (!helm || !helm.style) return;
    ctx.save();
    ctx.fillStyle = helm.color;
    ctx.strokeStyle = helm.color;
    ctx.lineWidth = 3;
    switch (helm.style) {
      case 'cap':
        ctx.beginPath();
        ctx.arc(0, headY - 2, headR + 1, Math.PI, Math.PI * 2);
        ctx.fill();
        break;
      case 'horns':
        ctx.beginPath();
        ctx.moveTo(-headR * 0.7, headY - headR * 0.4); ctx.lineTo(-headR * 1.6, headY - headR * 1.8);
        ctx.moveTo(headR * 0.7, headY - headR * 0.4); ctx.lineTo(headR * 1.6, headY - headR * 1.8);
        ctx.stroke();
        break;
      case 'crown':
        ctx.beginPath();
        ctx.moveTo(-headR, headY - headR); ctx.lineTo(-headR * 0.5, headY - headR * 2);
        ctx.lineTo(0, headY - headR * 1.3); ctx.lineTo(headR * 0.5, headY - headR * 2);
        ctx.lineTo(headR, headY - headR);
        ctx.stroke();
        break;
      case 'halo': {
        const t = Date.now() / 1000;
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.shadowBlur = 14;
        ctx.shadowColor = helm.color;
        ctx.beginPath();
        ctx.ellipse(0, headY - headR * 2.4 - Math.sin(t * 2) * 2, headR * 1.1, headR * 0.35, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        break;
      }
    }
    ctx.restore();
  }

  // Eyes + mouth, keyed by the equipped expression's `style` id. Drawn in a
  // bright color with a soft dark halo (shadowBlur) so it reads clearly
  // against any Character Skin color, light or dark, without per-skin logic.
  _drawFaceExpression(ctx, headY, headR) {
    const expr = this.cosmetics.expression;
    if (!expr || !expr.style) return;
    ctx.save();
    ctx.shadowBlur = 2.5;
    ctx.shadowColor = '#000000';
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';

    const eyeY = headY - headR * 0.15;
    const eyeDX = headR * 0.42;
    const mouthY = headY + headR * 0.4;

    const dotEyes = () => {
      ctx.beginPath();
      ctx.arc(-eyeDX, eyeY, 1.1, 0, Math.PI * 2);
      ctx.arc(eyeDX, eyeY, 1.1, 0, Math.PI * 2);
      ctx.fill();
    };
    const browsAngled = (inward) => {
      // inward=true: eyebrows angle down toward the nose (angry/determined);
      // inward=false: angle up toward the nose (sad).
      const d = inward ? 1.6 : -1.6;
      ctx.beginPath();
      ctx.moveTo(-eyeDX - 2.2, eyeY - 2.2 + d); ctx.lineTo(-eyeDX + 2.2, eyeY - 2.2 - d);
      ctx.moveTo(eyeDX - 2.2, eyeY - 2.2 - d); ctx.lineTo(eyeDX + 2.2, eyeY - 2.2 + d);
      ctx.stroke();
    };

    switch (expr.style) {
      case 'neutral':
        dotEyes();
        ctx.beginPath(); ctx.moveTo(-2.5, mouthY); ctx.lineTo(2.5, mouthY); ctx.stroke();
        break;
      case 'smile':
        dotEyes();
        ctx.beginPath(); ctx.arc(0, mouthY - 1.5, 3, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
        break;
      case 'happy':
        // closed, upward-curved "^ ^" eyes + a big open smile
        ctx.beginPath();
        ctx.arc(-eyeDX, eyeY + 1, 2, Math.PI, 0); ctx.arc(eyeDX, eyeY + 1, 2, Math.PI, 0);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(0, mouthY - 2, 3.6, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();
        break;
      case 'angry':
        dotEyes();
        browsAngled(true);
        ctx.beginPath(); ctx.moveTo(-2.5, mouthY); ctx.lineTo(2.5, mouthY - 1); ctx.stroke();
        break;
      case 'sad':
        dotEyes();
        browsAngled(false);
        ctx.beginPath(); ctx.arc(0, mouthY + 2.5, 3, 1.15 * Math.PI, 1.85 * Math.PI); ctx.stroke();
        break;
      case 'cool':
        // sunglasses bar instead of eyes
        ctx.fillRect(-eyeDX - 2.5, eyeY - 1.5, eyeDX * 2 + 5, 3);
        ctx.beginPath(); ctx.moveTo(-2, mouthY); ctx.lineTo(2.5, mouthY - 1); ctx.stroke();
        break;
      case 'surprised':
        ctx.beginPath();
        ctx.arc(-eyeDX, eyeY, 1.8, 0, Math.PI * 2); ctx.arc(eyeDX, eyeY, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath(); ctx.arc(0, mouthY + 1, 2, 0, Math.PI * 2); ctx.stroke();
        break;
      case 'determined':
        dotEyes();
        browsAngled(true);
        ctx.beginPath(); ctx.moveTo(-2.5, mouthY); ctx.lineTo(2.5, mouthY); ctx.stroke();
        break;
    }
    ctx.restore();
  }

  // Hairstyles framing the head. `baseColor` is the player's resolved
  // display color (Character Skin, or the default color) — used whenever
  // the equipped hair's own color is null, i.e. "inherit the character
  // palette" per spec. Drawn before the Helmet so a helmet always layers
  // above hair.
  _drawHair(ctx, headY, headR, baseColor) {
    const hair = this.cosmetics.hair;
    if (!hair || !hair.style) return;
    const f = this.facing;
    const sway = Math.sin(this.animPhase) * 2; // subtle idle movement for flowing styles
    ctx.save();
    const color = hair.color || baseColor;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    switch (hair.style) {
      case 'short':
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, headY - 1, headR + 0.5, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
        break;
      case 'messy':
        ctx.lineWidth = 2.5;
        for (let i = -2; i <= 2; i++) {
          ctx.beginPath();
          ctx.moveTo(i * headR * 0.35, headY - headR * 0.75);
          ctx.lineTo(i * headR * 0.4, headY - headR * 1.35 - Math.abs(i) * 1.2);
          ctx.stroke();
        }
        break;
      case 'ponytail':
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, headY - 1, headR + 0.5, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(-f * headR * 0.7, headY - headR * 0.6);
        ctx.quadraticCurveTo(-f * headR * 1.8, headY, -f * headR * 1.4 + sway, headY + headR * 1.6);
        ctx.stroke();
        break;
      case 'bobcut':
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, headY - 1, headR + 1, Math.PI * 0.95, Math.PI * 2.05); ctx.stroke();
        break;
      case 'mullet':
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, headY - 1, headR + 0.5, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-headR * 0.3, headY + headR * 0.5);
        ctx.quadraticCurveTo(-headR * 0.6, headY + headR * 1.4, -headR * 0.3 + sway * 0.5, headY + headR * 2);
        ctx.stroke();
        break;
      case 'long':
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(-headR * 0.9, headY - headR * 0.3);
        ctx.quadraticCurveTo(-headR * 1.5 + sway, headY + headR * 1.2, -headR * 0.6 + sway, headY + headR * 2.6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(headR * 0.9, headY - headR * 0.3);
        ctx.quadraticCurveTo(headR * 1.5 - sway, headY + headR * 1.2, headR * 0.6 - sway, headY + headR * 2.6);
        ctx.stroke();
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, headY - 1, headR + 0.5, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
        break;
      case 'bun':
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, headY - 1, headR + 0.5, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, headY - headR * 1.5, headR * 0.5, 0, Math.PI * 2); ctx.fill();
        break;
      case 'spiky':
        ctx.lineWidth = 3;
        for (let i = -2; i <= 2; i++) {
          ctx.beginPath();
          ctx.moveTo(i * headR * 0.4, headY - headR * 0.7);
          ctx.lineTo(i * headR * 0.4, headY - headR * 1.7);
          ctx.stroke();
        }
        break;
      case 'twintail':
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(-headR * 0.8, headY - headR * 0.4);
        ctx.quadraticCurveTo(-headR * 1.9, headY - headR * 0.2, -headR * 1.5 + sway, headY + headR * 1.2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(headR * 0.8, headY - headR * 0.4);
        ctx.quadraticCurveTo(headR * 1.9, headY - headR * 0.2, headR * 1.5 - sway, headY + headR * 1.2);
        ctx.stroke();
        break;
      case 'mohawk':
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(0, headY - headR * 0.9);
        ctx.lineTo(0, headY - headR * 2.6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-2.5, headY - headR * 0.9); ctx.lineTo(0, headY - headR * 2.1);
        ctx.moveTo(2.5, headY - headR * 0.9); ctx.lineTo(0, headY - headR * 2.1);
        ctx.stroke();
        break;
    }
    ctx.restore();
  }

  _drawArmsAndWeapon(ctx, shoulderY, armSwing) {
    const f = this.facing;
    const w = this.weapon;
    ctx.lineWidth = 5;

    let handX = f * 14, handY = shoulderY + 14;
    let backArmX = -f * 10, backArmY = shoulderY + 18;
    let weaponAngle = f * 0.9; // relative angle of weapon line
    let hideWeapon = false;

    if (this.currentAttack) {
      const a = this.currentAttack;
      const t = Math.min(1, this.animTimer / a.duration);
      const arc = w.swingArc;
      const swing = (t < 0.5 ? t * 2 : 1) * arc - arc / 2;
      weaponAngle = f * (0.2 + swing);
      handX = f * (16 + t * 8);
      handY = shoulderY + 10 - Math.sin(t * Math.PI) * 6;
    } else if (this.state === 'skill' || this.state === 'ult') {
      const dur = this.state === 'skill' ? 380 : 700;
      const t = Math.min(1, this.animTimer / dur);
      handX = f * (16 + Math.sin(t * Math.PI) * 10);
      handY = shoulderY + 6;
      weaponAngle = f * (0.6 + Math.sin(t * Math.PI) * 0.8);
      // glow ring for casting
      ctx.save();
      ctx.globalAlpha = 0.55 * Math.sin(Math.min(1, t) * Math.PI);
      ctx.fillStyle = this.power.color;
      ctx.beginPath();
      ctx.arc(handX, handY, 16 + t * 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (this.state === 'victory' && this.victoryPoseId) {
      const t = (this.animTimer % 1200) / 1200; // 0..1, loops every 1.2s
      const pose = this._computeVictoryPose(this.victoryPoseId, t, f, shoulderY);
      handX = pose.handX; handY = pose.handY;
      backArmX = pose.backArmX; backArmY = pose.backArmY;
      weaponAngle = pose.weaponAngle;
      hideWeapon = pose.hideWeapon;
    }

    // back arm
    ctx.beginPath();
    ctx.moveTo(0, shoulderY);
    ctx.lineTo(backArmX, backArmY);
    ctx.stroke();

    // front arm to hand
    ctx.beginPath();
    ctx.moveTo(0, shoulderY);
    ctx.lineTo(handX, handY);
    ctx.stroke();

    if (hideWeapon) { ctx.strokeStyle = this.color; return; }

    // weapon line from hand — a Weapon Skin cosmetic overrides color/accent
    // display only; damage/range/speed stay whatever the equipped Weapon
    // instance defines, so cosmetics can never affect balance.
    const wSkin = this.cosmetics && this.cosmetics.weaponSkin;
    const weaponColor = (wSkin && wSkin.color) || w.color;
    const weaponAccent = (wSkin && wSkin.accent) || w.accent;
    ctx.strokeStyle = weaponColor;
    ctx.lineWidth = w.id === 'hammer' ? 7 : w.id === 'spear' ? 3 : 5;
    ctx.beginPath();
    ctx.moveTo(handX, handY);
    const len = w.id === 'spear' ? 46 : w.id === 'hammer' ? 30 : 34;
    ctx.lineTo(handX + Math.cos(weaponAngle) * len, handY + Math.sin(weaponAngle) * len - 8);
    ctx.stroke();
    if (w.id === 'hammer') {
      ctx.fillStyle = weaponAccent;
      ctx.beginPath();
      ctx.arc(handX + Math.cos(weaponAngle) * len, handY + Math.sin(weaponAngle) * len - 8, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = this.color;
  }

  // Distinct arm/weapon parametrization per Victory Animation style — the
  // stick-figure equivalent of a full-body animation clip. `t` loops 0..1.
  _computeVictoryPose(styleId, t, f, shoulderY) {
    const wave = Math.sin(t * Math.PI * 2);
    switch (styleId) {
      case 'wave':
        return { handX: f * (6 + wave * 16), handY: shoulderY - 22, backArmX: -f * 10, backArmY: shoulderY + 18, weaponAngle: f * 0.9, hideWeapon: false };
      case 'thumbsup':
        return { handX: f * 20, handY: shoulderY - 4 + wave * 2, backArmX: -f * 10, backArmY: shoulderY + 18, weaponAngle: f * 0.9, hideWeapon: false };
      case 'peace':
        return { handX: f * 14, handY: shoulderY - 20, backArmX: -f * 10, backArmY: shoulderY + 18, weaponAngle: f * 0.9, hideWeapon: false };
      case 'salute':
        return { handX: f * 10, handY: shoulderY - 24, backArmX: -f * 10, backArmY: shoulderY + 18, weaponAngle: f * 0.9, hideWeapon: false };
      case 'flex':
        return { handX: f * 22, handY: shoulderY + 4, backArmX: -f * 22, backArmY: shoulderY + 4, weaponAngle: f * 0.9, hideWeapon: true };
      case 'hero':
        return { handX: f * 10, handY: shoulderY - 26, backArmX: -f * 6, backArmY: shoulderY + 16, weaponAngle: f * 0.9, hideWeapon: true };
      case 'swordspin':
        return { handX: f * 16, handY: shoulderY + 10, backArmX: -f * 10, backArmY: shoulderY + 18, weaponAngle: t * Math.PI * 4, hideWeapon: false };
      case 'celebrate':
        return {
          handX: f * (14 + Math.sin(t * Math.PI * 4) * 4), handY: shoulderY - 24 + wave * 3,
          backArmX: -f * (14 + Math.cos(t * Math.PI * 4) * 4), backArmY: shoulderY - 22 + Math.cos(t * Math.PI * 2) * 3,
          weaponAngle: f * 0.9, hideWeapon: true,
        };
      default:
        return { handX: f * 14, handY: shoulderY + 14, backArmX: -f * 10, backArmY: shoulderY + 18, weaponAngle: f * 0.9, hideWeapon: false };
    }
  }

  _drawNamePlate(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y - this.height - 14);
    ctx.textAlign = 'center';
    ctx.font = 'bold 12px Segoe UI, sans-serif';
    ctx.fillStyle = this.color;
    ctx.fillText(this.name, 0, 0);
    // mini hp bar
    const w = 46, h = 5;
    ctx.fillStyle = '#00000088';
    ctx.fillRect(-w / 2, 4, w, h);
    ctx.fillStyle = this.health > 40 ? '#7dff8f' : '#ff5c5c';
    ctx.fillRect(-w / 2, 4, w * Math.max(0, this.health / this.maxHealth), h);
    ctx.restore();
  }
}
