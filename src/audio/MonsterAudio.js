// Every monster sound, from what a monster is visibly doing: spotting you
// (state turns to chase), attacking / flinching (animation), dying, walking
// (distance covered) and, for the dragon, flying. Because it only reads state
// that MonsterSync also replicates, host and co-op clients hear the same thing,
// each from their own position: the sounds are placed in 3D (Sfx panners), so
// a hound coming from your left is in your left ear.

const HEAR = 75;          // m: vocals farther than this are skipped
const STEP_HEAR = 24;     // m: footsteps
const ALERT_GAP = 0.18;   // s between two alert calls anywhere (a pack doesn't bark in unison)
const HOWL_GAP = 6;       // s between pack howls

const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Per type: sample groups for each moment, pitch (rate), how far it carries
 * (ref), footstep group / stride (m between footfalls) / loudness.
 */
const VOICES = {
  walker:   { alert: "z_alert", idle: "z_groan", attack: "z_attack", pain: "z_pain", death: "z_death", rate: 0.92, ref: 4, step: "step_dirt", stride: 1.0, stepVol: 0.55 },
  runner:   { alert: "z_alert", idle: "z_groan", attack: "z_attack", pain: "z_pain", death: "z_death", rate: 1.2, ref: 4, step: "step_dirt", stride: 1.5, stepVol: 0.7 },
  listener: { alert: "z_attack", idle: "z_groan", attack: "z_attack", pain: "z_pain", death: "z_death", rate: 1.08, ref: 4, step: "step_dirt", stride: 1.2, stepVol: 0.45 },
  gunner:   { alert: "z_alert", idle: "z_groan", attack: "z_attack", pain: "z_pain", death: "z_death", rate: 0.82, ref: 5, step: "step_dirt", stride: 1.2, stepVol: 0.6 },
  brute:    { alert: "brute_roar", idle: "brute_grunt", attack: "brute_grunt", pain: "brute_grunt", death: "brute_roar", rate: 0.82, ref: 8, step: "stomp", stride: 2.0, stepVol: 0.9 },
  boss:     { alert: "boss_roar", idle: "brute_grunt", attack: "brute_roar", pain: "brute_grunt", death: "boss_roar", rate: 0.8, ref: 12, step: "stomp", stride: 2.3, stepVol: 1.1 },
  hound:    { alert: "hound_bark", idle: "hound_growl", attack: "hound_snarl", pain: "hound_yelp", death: "hound_yelp", rate: 0.78, ref: 5, step: "paw", stride: 0.85, stepVol: 0.7 },
  dragon:   { alert: "dragon_roar", idle: null, attack: null, pain: null, death: "dragon_roar", rate: 0.9, ref: 25 },
};

export class MonsterAudio {
  constructor(sfx) {
    this.sfx = sfx;
    this._lastAlert = -99;
    this._lastHowl = -99;
    this.t = 0;
    this._at = { x: 0, y: 0, z: 0 };
  }

  /** monsters: the active list (real ones on the host, puppets on clients). dt: game seconds. */
  update(monsters, dt) {
    const sfx = this.sfx;
    if (!sfx.ctx || dt <= 0) return;
    this.t += dt;
    const L = sfx.listener;
    for (const m of monsters) {
      const v = VOICES[m.type] ?? VOICES.walker;
      const p = m.root.position;
      const s = m.snd ??= { x: p.x, z: p.z, acc: 0, chase: false, anim: "", dead: false, idle: rand(2, 8), cd: 0, wing: 0 };
      const at = this._at;
      at.x = p.x; at.y = p.y + (m.def.height ?? 1.8) * 0.75; at.z = p.z;
      const d = Math.hypot(at.x - L.x, at.y - L.y, at.z - L.z);
      s.cd -= dt;

      if (m.dying) {
        if (!s.dead) {
          s.dead = true;
          if (d < HEAR) {
            if (m.type === "dragon") sfx.dragonRoar(at, true);
            else sfx.voice(v.death, at, { rate: v.rate, ref: v.ref });
          }
        }
        s.x = p.x; s.z = p.z;
        continue;
      }
      if (s.dead) {
        // Back from the pool as a new monster: start fresh, no sound for the spawn
        s.dead = false; s.chase = false; s.anim = m.currentAnim; s.acc = 0; s.idle = rand(3, 9);
        s.x = p.x; s.z = p.z;
      }

      // Spotted you: growl / bark / roar (hounds: one howl for the pack now and then)
      const chase = m.state === "chase" || m.state === "alert";
      if (chase && !s.chase && d < HEAR && this.t - this._lastAlert > ALERT_GAP) {
        this._lastAlert = this.t;
        if (m.type === "hound" && this.t - this._lastHowl > HOWL_GAP) {
          this._lastHowl = this.t;
          sfx.howl(at);
        } else if (m.type === "dragon") {
          sfx.dragonRoar(at);
        } else {
          sfx.voice(v.alert, at, { rate: v.rate, ref: v.ref, vol: 1.1, delay: m.type === "hound" ? rand(0, 0.25) : 0 });
        }
        s.idle = rand(2, 4);
      }
      s.chase = chase;

      // Attacks and flinches, from the animation
      const a = m.currentAnim;
      if (a !== s.anim) {
        if (a === "attack" && v.attack && s.cd <= 0 && d < HEAR) {
          sfx.voice(v.attack, at, { rate: v.rate, ref: v.ref });
          s.cd = 0.9;
        } else if (a?.startsWith("pain") && v.pain && d < HEAR) {
          sfx.voice(v.pain, at, { rate: v.rate, ref: v.ref, vol: 0.9 });
          s.cd = 0.5;
        } else if (a === "jump" && m.type === "hound" && d < HEAR) {
          sfx.snarl(at);
        }
        s.anim = a;
      }

      // Idle groans / growls / grunts: more often while hunting you
      s.idle -= dt;
      if (s.idle <= 0) {
        s.idle = chase ? rand(2.5, 5) : rand(6, 14);
        if (v.idle && d < HEAR * 0.6) sfx.voice(v.idle, at, { rate: v.rate * rand(0.95, 1.05), ref: v.ref, vol: chase ? 0.85 : 0.6, low: true });
      }

      // Footsteps on the ground, wing beats in the air
      if (m.def.flying) {
        s.wing -= dt;
        if (s.wing <= 0) {
          s.wing = rand(0.75, 1.05);
          if (d < 160) sfx.wingBeat(at, 1);
        }
      } else if (v.step) {
        s.acc += Math.hypot(p.x - s.x, p.z - s.z);
        if (s.acc >= v.stride) {
          s.acc = s.acc > v.stride * 3 ? 0 : s.acc - v.stride; // a teleport (pool, recycle) isn't a step
          if (d < STEP_HEAR) {
            at.y = p.y + 0.1;
            sfx.play(v.step, { at, vol: v.stepVol, rate: v.step === "step_dirt" ? 0.85 : 1, jitter: 0.1, ref: 2.5, rolloff: 1.3, wet: 0.08, low: true });
          }
        }
      }
      s.x = p.x; s.z = p.z;
    }
  }
}
