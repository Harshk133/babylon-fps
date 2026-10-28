// Uniform-grid spatial hash for "what is near this point?" questions over
// static things (houses, fields, plots, obstacles, terrain pads). An item is
// filed in every cell its bounds touch, grown by `reach`, so a point query
// within `reach` of an item only has to read the one cell the point is in:
// O(1) instead of a scan over every item. World generation asks these
// questions a few hundred thousand times (every terrain sample, every grass
// texel), which is where the scans used to go.

const EMPTY = [];

export class SpatialGrid {
  /** cell: cell size (m). reach: the largest pad / radius a query may ask about. */
  constructor(cell = 16, reach = 8) {
    this.cell = cell;
    this.reach = reach;
    this.cells = new Map();
    this.count = 0;
  }

  _key(ix, iz) { return ix * 65536 + iz; }

  /** Files `item` under the axis-aligned bounds [x0, x1] × [z0, z1] (+ reach). */
  insert(item, x0, z0, x1, z1) {
    const c = this.cell, r = this.reach;
    const ix0 = Math.floor((x0 - r) / c), ix1 = Math.floor((x1 + r) / c);
    const iz0 = Math.floor((z0 - r) / c), iz1 = Math.floor((z1 + r) / c);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = this._key(ix, iz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(item);
      }
    }
    this.count++;
  }

  /** Files an item by centre and radius. */
  insertCircle(item, x, z, r) { this.insert(item, x - r, z - r, x + r, z + r); }

  /** Everything that might be within `reach` of (x, z) (a superset: callers do the exact test). */
  near(x, z) {
    return this.cells.get(this._key(Math.floor(x / this.cell), Math.floor(z / this.cell))) ?? EMPTY;
  }

  clear() { this.cells.clear(); this.count = 0; }
}
