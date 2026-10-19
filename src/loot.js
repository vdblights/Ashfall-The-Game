/**
 * What was left behind in the buildings: a cache of ammunition, a medical
 * case or an armour plate, stashed in some of the shops and some of the
 * floors over them, against a wall or a fitting and away from the doors.
 *
 * Where each lies is worked out from the world and nothing else. It reads
 * the rooms and floors the city records, asks the footing for the floor
 * and `blocked` for room to stand, and decides which rooms hold one, how
 * many and of what by a hash of where the room is — never `Math.random`,
 * so stocking the caches at the start of a run moves neither the layout
 * nor a single spawn. Imports nothing, like `nav.js`, so it mints nothing.
 */
export const LOOT = {
  rooms: 0.6,           // the share of shops with a cache
  floors: 0.45,         // and of the floors over them
  big: 140,             // m² over which a room may hold two
  inset: 0.9,           // kept off the walls, which are inside the footprint
  door: 1.6,            // and clear of every doorway, so nobody trips on one
  apart: 3,             // two caches in a room are this far apart at least
  armour: 50,           // what a plate puts back on the carrier
  kinds: [['ammo', 0.45], ['health', 0.3], ['armour', 0.25]],
};

/** A number in [0, 1) off a place and a salt, the same every run. */
export function lootHash(x, z, salt) {
  let h = Math.imul(Math.round(x * 10) | 0, 73856093) ^ Math.imul(Math.round(z * 10) | 0, 19349663) ^ Math.imul(salt, 83492791);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Every cache in the city: `{ x, z, floor, kind, room }`, `floor` being the
 * height the footing finds under it and `room` the room or floor record it
 * lies in.
 */
export function cacheSpots(world) {
  const out = [];
  const shafts = (world.stairs || []).map((s) => s.shaft);
  const visit = (r, share, salt) => {
    const cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
    if (lootHash(cx, cz, salt) >= share) return;
    const area = (r.maxX - r.minX) * (r.maxZ - r.minZ);
    const count = area > LOOT.big && lootHash(cx, cz, salt + 1) < 0.5 ? 2 : 1;
    const cands = [];
    for (let x = r.minX + LOOT.inset; x <= r.maxX - LOOT.inset; x += 0.5) {
      for (let z = r.minZ + LOOT.inset; z <= r.maxZ - LOOT.inset; z += 0.5) {
        // not in a stairwell, nor on the landing in front of one
        if (shafts.some((q) => x > q.minX - 1.2 && x < q.maxX + 1.2 && z > q.minZ - 1.2 && z < q.maxZ + 1.2)) continue;
        let door = Infinity;
        for (const d of r.doors) door = Math.min(door, Math.hypot(d.x - x, d.z - z));
        if (door < LOOT.door) continue;
        // on this room's floor, with a body's room round it
        const y = world.groundHeight(x, z, 0.3, r.floor + 0.6);
        if (Math.abs(y - r.floor) > 0.08) continue;
        if (world.blocked(x, z, 0.45, r.floor + 0.3)) continue;
        // a stash is put down against something, at the back of the room
        const against = world.blocked(x, z, 1.0, r.floor + 0.3) ? 3 : 0;
        cands.push({ x, z, y, score: against + Math.min(door, 12) * 0.4 + lootHash(x, z, salt + 2) * 2 });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const taken = [];
    for (const c of cands) {
      if (taken.length >= count) break;
      if (taken.some((t) => Math.hypot(t.x - c.x, t.z - c.z) < LOOT.apart)) continue;
      taken.push(c);
    }
    for (const c of taken) {
      let roll = lootHash(c.x, c.z, salt + 3), kind = LOOT.kinds[0][0];
      for (const [k, p] of LOOT.kinds) { if (roll < p) { kind = k; break; } roll -= p; }
      out.push({ x: c.x, z: c.z, floor: c.y, kind, room: r });
    }
  };
  for (const r of world.rooms || []) visit(r, LOOT.rooms, 1);
  for (const f of world.floors || []) visit(f, LOOT.floors, 7);
  return out;
}
