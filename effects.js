/* ============================================================
   effects.js
   Particle effects, hit sparks, elemental visuals and the
   Projectile class used by skill/ultimate attacks.
   ============================================================ */

class Particle {
  constructor(x, y, vx, vy, life, color, size, gravity = 0, fade = true) {
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.life = life; this.maxLife = life;
    this.color = color;
    this.size = size;
    this.gravity = gravity;
    this.fade = fade;
  }
  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vy += this.gravity * dt;
    this.life -= dt;
    return this.life > 0;
  }
  draw(ctx) {
    const t = Math.max(0, this.life / this.maxLife);
    ctx.globalAlpha = this.fade ? t : 1;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size * t + this.size * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// Projectile fired by a skill attack. Travels in a straight line.
class Projectile {
  constructor(ownerId, x, y, dir, power, isUltimate = false) {
    this.ownerId = ownerId;
    this.x = x; this.y = y;
    this.dir = dir; // 1 or -1
    this.power = power;
    this.vx = power.skillSpeed * dir;
    this.vy = 0;
    this.radius = power.skillRadius;
    this.damage = power.skillDamage;
    this.life = 1.4; // seconds
    this.dead = false;
    this.isUltimate = isUltimate;
    this.trailTimer = 0;
  }
  update(dt, effects) {
    this.x += this.vx * dt * 60;
    this.y += this.vy * dt * 60;
    this.life -= dt;
    this.trailTimer -= dt;
    if (this.trailTimer <= 0) {
      effects.spawnTrail(this.x, this.y, this.power);
      this.trailTimer = 0.02;
    }
    if (this.life <= 0) this.dead = true;
  }
  draw(ctx) {
    const p = this.power;
    ctx.save();
    ctx.shadowBlur = 18;
    ctx.shadowColor = p.glow;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

class EffectsManager {
  constructor() {
    this.particles = [];
    this.floatingTexts = [];
    this.screenFlash = 0;
    this.flashColor = '#ffffff';
  }

  update(dt) {
    this.particles = this.particles.filter(p => p.update(dt));
    this.floatingTexts = this.floatingTexts.filter(t => {
      t.y += t.vy * dt;
      t.life -= dt;
      return t.life > 0;
    });
    if (this.screenFlash > 0) this.screenFlash -= dt * 2.4;
  }

  draw(ctx) {
    for (const p of this.particles) p.draw(ctx);
    ctx.textAlign = 'center';
    for (const t of this.floatingTexts) {
      const a = Math.max(0, Math.min(1, t.life / t.maxLife));
      ctx.globalAlpha = a;
      ctx.fillStyle = t.color;
      ctx.font = `bold ${t.size}px Segoe UI, sans-serif`;
      ctx.fillText(t.text, t.x, t.y);
      ctx.globalAlpha = 1;
    }
  }

  drawScreenFlash(ctx, w, h) {
    if (this.screenFlash > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.35, this.screenFlash);
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  flash(color = '#ffffff', amount = 0.4) {
    this.flashColor = color;
    this.screenFlash = amount;
  }

  spawnTrail(x, y, power) {
    this.particles.push(new Particle(
      x + (Math.random() - 0.5) * 6, y + (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5,
      0.3, power.color, 4 + Math.random() * 3
    ));
  }

  // Weapon swing spark
  spawnHitSpark(x, y, color = '#ffe27a', count = 10) {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 2 + Math.random() * 4;
      this.particles.push(new Particle(
        x, y, Math.cos(ang) * spd, Math.sin(ang) * spd,
        0.35 + Math.random() * 0.2, color, 3 + Math.random() * 3, 6
      ));
    }
  }

  // Elemental burst used for skill impact / ultimate cast
  spawnElementalBurst(x, y, power, radius = 60, count = 26) {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = (0.5 + Math.random() * 1.5) * (radius / 60);
      this.particles.push(new Particle(
        x, y, Math.cos(ang) * spd * 3, Math.sin(ang) * spd * 3,
        0.5 + Math.random() * 0.5, Math.random() < 0.5 ? power.color : power.glow,
        4 + Math.random() * 5, power.id === 'wind' ? -2 : 2
      ));
    }
  }

  spawnDust(x, y) {
    for (let i = 0; i < 4; i++) {
      this.particles.push(new Particle(
        x + (Math.random() - 0.5) * 10, y,
        (Math.random() - 0.5) * 1.5, -Math.random() * 1.2,
        0.4, '#8a8a8a', 3 + Math.random() * 2, 4
      ));
    }
  }

  spawnDamageNumber(x, y, amount, crit = false) {
    this.floatingTexts.push({
      x, y, vy: -30, life: 0.8, maxLife: 0.8,
      text: (crit ? '!' : '') + Math.round(amount),
      color: crit ? '#ffce54' : '#ff8f8f',
      size: crit ? 22 : 16,
    });
  }
}
