// Taking one building out of a merged mesh. Give each source geometry
// userData.owner before merging, call claimVertices() on the list that was merged,
// and the owner gets `ranges`. Collapsing a range's vertices to a point removes
// those triangles; saving them first lets a new match put the building back.

export function claimVertices(list, mesh) {
  let start = 0;
  for (const g of list) {
    const count = g.attributes.position.count;
    const o = g.userData.owner;
    if (o) (o.ranges ??= []).push({ mesh, start, count, saved: null });
    start += count;
  }
}

export function eraseRanges(ranges) {
  for (const r of ranges) {
    const a = r.mesh.geometry.attributes.position;
    r.saved = a.array.slice(r.start * 3, (r.start + r.count) * 3);
    a.array.fill(0, r.start * 3, (r.start + r.count) * 3);
    a.needsUpdate = true;
  }
}

export function restoreRanges(ranges) {
  for (const r of ranges) {
    if (!r.saved) continue;
    const a = r.mesh.geometry.attributes.position;
    a.array.set(r.saved, r.start * 3);
    a.needsUpdate = true;
    r.saved = null;
  }
}

/** World-space bounds of what an owner drew: { x, z, hw, hd, base, h }. */
export function rangesBounds(ranges) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of ranges) {
    const a = r.mesh.geometry.attributes.position.array;
    for (let i = r.start; i < r.start + r.count; i++) {
      const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
  }
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, base: y0, h: y1 - y0 };
}
