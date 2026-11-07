// Render interpolation for a body that game code also nudges between physics
// steps (ground snap, bounds, unsticking).
//
// Physics runs at a fixed 60 Hz, but frames don't line up with it: a 144 Hz
// screen gets 0 or 1 steps per frame, an uneven 45-55 FPS gets 1 or 2. Drawing
// body.position directly then moves the character (and the camera that follows
// it) in uneven stair-steps, which reads as "laggy movement". This keeps the
// body's state after each of the last two steps and draws a blend of them by
// how far the clock has run into the next step (the accumulator fraction), so
// the picture moves evenly at any frame rate. It trails physics by under one
// step (16.7 ms); gameplay (hits, rays, network) keeps reading body.position.
//
// The two step states are recorded *after* the frame's fixups, so a ground
// snap is part of the state instead of being blended through.

const SNAP_SQ = 2 * 2;   // a jump this far between steps is a teleport: don't blend across it

export class RenderInterp {
  constructor() {
    this.prev = { x: 0, y: 0, z: 0 };
    this.curr = { x: 0, y: 0, z: 0 };
    this.rawY = 0;         // the last recorded y before smoothing
    this.valid = false;
  }

  /** Forget the history: the next record() starts fresh (teleports, scripted moves). */
  snap() { this.valid = false; }

  /**
   * Once per frame, after the step and every fixup. steps: physics steps taken
   * this frame. smoothY: the contact settles a centimetre up and down on
   * alternate steps; averaging consecutive steps cancels that without lagging
   * on slopes (jumps and stairs pass straight through).
   */
  record(pos, steps, smoothY = 0) {
    const p = this.prev, c = this.curr;
    if (!this.valid) {
      p.x = c.x = pos.x; p.y = c.y = pos.y; p.z = c.z = pos.z;
      this.rawY = pos.y;
      this.valid = true;
      return;
    }
    if (steps > 0) {
      // The blend runs from one step before the latest. Several steps this frame:
      // that state is part of the way along (the body moved evenly through them)
      const f = (steps - 1) / steps;
      const ny = smoothY > 0 && Math.abs(pos.y - this.rawY) < smoothY ? (pos.y + this.rawY) / 2 : pos.y;
      p.x = c.x + (pos.x - c.x) * f; p.y = c.y + (ny - c.y) * f; p.z = c.z + (pos.z - c.z) * f;
      // (y: the average of this step and the last, raw, so a steady slope lags only half a step)
      c.x = pos.x; c.y = ny; c.z = pos.z;
      this.rawY = pos.y;
    } else if (Math.abs(pos.y - this.rawY) >= smoothY || pos.x !== c.x || pos.z !== c.z) {
      // No step this frame: only a fixup moved it; take that as it is
      c.x = pos.x; c.z = pos.z;
      if (Math.abs(pos.y - this.rawY) >= smoothY) { c.y = pos.y; this.rawY = pos.y; }
    }
    const dx = c.x - p.x, dy = c.y - p.y, dz = c.z - p.z;
    if (dx * dx + dy * dy + dz * dz > SNAP_SQ) { p.x = c.x; p.y = c.y; p.z = c.z; }
  }

  /** The drawn position at alpha (0 = the previous step, 1 = the latest) into out. */
  at(alpha, out) {
    const p = this.prev, c = this.curr;
    out.x = p.x + (c.x - p.x) * alpha;
    out.y = p.y + (c.y - p.y) * alpha;
    out.z = p.z + (c.z - p.z) * alpha;
    return out;
  }
}
