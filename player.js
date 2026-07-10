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
  }

  // =========================== RENDER ===========================
  draw(ctx) {
    if (!this.alive) return;
    ctx.save();
    ctx.translate(this.x, this.y);

    if (this.invulnTimer > 0 && Math.floor(this.invulnTimer / 100) % 2 === 0) {
      ctx.globalAlpha = 0.4;
    }

    const c = this.color;
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

    // arms + weapon (drawn by attack-state logic)
    this._drawArmsAndWeapon(ctx, shoulderY, armSwing);

    // head
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    ctx.globalAlpha = 1;
    ctx.restore();

    this._drawNamePlate(ctx);
  }

  _drawArmsAndWeapon(ctx, shoulderY, armSwing) {
    const f = this.facing;
    const w = this.weapon;
    ctx.lineWidth = 5;

    let handX = f * 14, handY = shoulderY + 14;
    let weaponAngle = f * 0.9; // relative angle of weapon line

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
    }

    // back arm
    ctx.beginPath();
    ctx.moveTo(0, shoulderY);
    ctx.lineTo(-f * 10, shoulderY + 18);
    ctx.stroke();

    // front arm to hand
    ctx.beginPath();
    ctx.moveTo(0, shoulderY);
    ctx.lineTo(handX, handY);
    ctx.stroke();

    // weapon line from hand
    const wx = handX + Math.cos(weaponAngle) * w.range * 0.55 * f * 0 + Math.cos(weaponAngle) * 30;
    const wy = handY + Math.sin(weaponAngle) * 30 - 10;
    ctx.strokeStyle = w.color;
    ctx.lineWidth = w.id === 'hammer' ? 7 : w.id === 'spear' ? 3 : 5;
    ctx.beginPath();
    ctx.moveTo(handX, handY);
    const len = w.id === 'spear' ? 46 : w.id === 'hammer' ? 30 : 34;
    ctx.lineTo(handX + Math.cos(weaponAngle) * len, handY + Math.sin(weaponAngle) * len - 8);
    ctx.stroke();
    if (w.id === 'hammer') {
      ctx.fillStyle = w.accent;
      ctx.beginPath();
      ctx.arc(handX + Math.cos(weaponAngle) * len, handY + Math.sin(weaponAngle) * len - 8, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = this.color;
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
