import * as CANNON from "cannon-es";

// Physics broadphase for a world that is mostly static. Of ~600 bodies,
// ~520 never move (terrain tiles, houses, trees, rocks, poles, props) and
// static-against-static pairs can never collide, yet cannon's SAPBroadphase
// sorts every body along an axis each step and walks every overlap on that
// axis: on this map that was 5+ ms per physics step.
//
// Here the static bodies go into a uniform grid once (rebuilt only when a
// static body is added, removed or flagged with aabbNeedsUpdate; not
// `dirty`, which cannon sets on the broadphase every step). Each step,
// every awake dynamic body is tested against the static bodies in the cells
// its AABB touches, and the moving bodies (dynamic + kinematic) against each
// other (pairs where neither is dynamic are skipped: nothing would happen).
// aabbQuery (every raycast: bullets, the camera boom, monster sight) uses the
// same grid.
//
// Static bodies are also kept *out of* world.bodies. cannon walks that list
// several times every step (gravity, the solver's reset and apply passes,
// integration, clearing forces, sleep, interpolation), and for a static body
// every one of those passes does nothing: with ~520 of ~600 bodies static that
// was most of the physics time while nothing moved (measured: the solver's own
// loop alone was 4 % of the main thread in an empty scene). They live here
// instead; world.addBody / removeBody are wrapped so the rest of the game adds
// and removes them as before, the addBody / removeBody events still fire, and
// world.idToBodyMap still knows them (contact events look bodies up there).
// Collisions, contacts and raycasts find them through the grid, exactly as
// before. Static bodies keep invMassSolve 0, so the solver never needs them.

const CELL = 16;           // m
const HUGE_CELLS = 600;    // a static body spanning more cells than this is tested every time instead
const OFFSET = 1 << 12;    // cell index bias, so keys stay positive

const STATIC = CANNON.Body.STATIC;
const DYNAMIC = CANNON.Body.DYNAMIC;
const SLEEPING = CANNON.Body.SLEEPING;

const key = (ix, iz) => (ix + OFFSET) * (OFFSET * 2) + (iz + OFFSET);

export class StaticGridBroadphase extends CANNON.Broadphase {
  constructor(world) {
    super();
    this.world = world;
    this.useBoundingBoxes = true;
    this.cells = new Map();   // key → static bodies overlapping that cell
    this.huge = [];           // static bodies too large for the grid
    this.statics = [];
    this._gridDirty = true;
    this.dynamics = [];
    this.kinematics = [];
    this._stamp = 0;

    // Static bodies: here, not in world.bodies
    const addBody = world.addBody.bind(world), removeBody = world.removeBody.bind(world);
    world.addBody = body => {
      if (body.type !== STATIC) return addBody(body);
      if (body._inGrid) return;
      body._inGrid = true;
      body.world = world;
      body.index = -1;
      body.initPosition.copy(body.position);
      body.initQuaternion.copy(body.quaternion);
      world.idToBodyMap[body.id] = body;
      this.statics.push(body);
      this._gridDirty = true;
      world.dispatchEvent({ type: "addBody", body });
    };
    world.removeBody = body => {
      if (!body._inGrid) return removeBody(body);
      body._inGrid = false;
      body.world = null;
      const i = this.statics.indexOf(body);
      if (i >= 0) { this.statics[i] = this.statics[this.statics.length - 1]; this.statics.pop(); }
      delete world.idToBodyMap[body.id];
      this._gridDirty = true;
      world.dispatchEvent({ type: "removeBody", body });
    };
    // Any added before this broadphase was installed move over
    for (const b of [...world.bodies]) if (b.type === STATIC) { removeBody(b); world.addBody(b); }
  }

  /** Every static body (they aren't in world.bodies). */
  get staticBodies() { return this.statics; }

  _rebuild() {
    this._gridDirty = false;
    this.cells.clear();
    this.huge.length = 0;
    for (const b of this.statics) {
      if (!b.shapes.length) continue;
      if (b.aabbNeedsUpdate) b.updateAABB();
      b._gridStamp = 0;
      const { lowerBound: lo, upperBound: hi } = b.aabb;
      const x0 = Math.floor(lo.x / CELL), x1 = Math.floor(hi.x / CELL);
      const z0 = Math.floor(lo.z / CELL), z1 = Math.floor(hi.z / CELL);
      if (!isFinite(x0 + x1 + z0 + z1) || (x1 - x0 + 1) * (z1 - z0 + 1) > HUGE_CELLS) { this.huge.push(b); continue; }
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const k = key(ix, iz);
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, list = []);
          list.push(b);
        }
      }
    }
  }

  /** A static body was moved or reshaped in code (it set aabbNeedsUpdate): re-grid. */
  _checkStatics() {
    for (const b of this.statics) if (b.aabbNeedsUpdate) { this._gridDirty = true; return; }
  }

  /** Calls visit(staticBody) once for every static body whose cells overlap aabb. */
  _forStatics(aabb, visit) {
    const stamp = ++this._stamp;
    const { lowerBound: lo, upperBound: hi } = aabb;
    const x0 = Math.floor(lo.x / CELL), x1 = Math.floor(hi.x / CELL);
    const z0 = Math.floor(lo.z / CELL), z1 = Math.floor(hi.z / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells.get(key(ix, iz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          if (s._gridStamp === stamp) continue;
          s._gridStamp = stamp;
          visit(s);
        }
      }
    }
    for (let i = 0; i < this.huge.length; i++) visit(this.huge[i]);
  }

  collisionPairs(world, pairs1, pairs2) {
    this._checkStatics();
    if (this._gridDirty) this._rebuild();
    // world.bodies holds only moving bodies now
    const dyn = this.dynamics, kin = this.kinematics;
    dyn.length = 0;
    kin.length = 0;
    for (const b of world.bodies) {
      if (b.type === DYNAMIC) dyn.push(b);
      else if (b.type !== STATIC) kin.push(b);
    }

    // Awake dynamic bodies against the static world
    this._p1 = pairs1; this._p2 = pairs2;
    for (let i = 0; i < dyn.length; i++) {
      const a = dyn[i];
      if (a.sleepState === SLEEPING) continue;
      if (a.aabbNeedsUpdate) a.updateAABB();
      this._a = a;
      this._forStatics(a.aabb, this._visitPair);
    }
    // Moving bodies against each other, when at least one is dynamic (kinematic
    // against kinematic, the ~100 house doors and the vehicles, can't do anything)
    for (let i = 0; i < dyn.length; i++) {
      const a = dyn[i];
      for (let j = i + 1; j < dyn.length; j++) {
        const b = dyn[j];
        if (this.needBroadphaseCollision(a, b)) this.intersectionTest(a, b, pairs1, pairs2);
      }
      for (let j = 0; j < kin.length; j++) {
        const b = kin[j];
        if (this.needBroadphaseCollision(a, b)) this.intersectionTest(a, b, pairs1, pairs2);
      }
    }
  }

  _visitPair = s => {
    if (this.needBroadphaseCollision(this._a, s)) this.intersectionTest(this._a, s, this._p1, this._p2);
  };

  aabbQuery(world, aabb, result = []) {
    if (this._gridDirty) this._rebuild();
    this._q = aabb; this._r = result;
    this._forStatics(aabb, this._visitQuery);
    for (const b of world.bodies) {
      if (b.aabbNeedsUpdate) b.updateAABB();
      if (b.aabb.overlaps(aabb)) result.push(b);
    }
    return result;
  }

  _visitQuery = s => {
    if (s.aabb.overlaps(this._q)) this._r.push(s);
  };
}
