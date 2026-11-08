// Battle royale teams: pure data and rules (no DOM, no three.js).
//
// A queue is a room: Solo plays in "br-<code>", Duo in "br-<code>.2", Squad in
// "br-<code>.4" (relayRoomName), so everybody in a room plays the same team size
// and friends only need the same code and queue. The host deals the teams when
// the match starts: parties (same party code) stay together, players with Fill
// on are put in teams with room, and bots take the free seats of Fill teams.

export const TEAM_NAMES = { 1: "Solo", 2: "Duo", 4: "Squad" };
export const TEAM_WORDS = { 1: "players", 2: "duos", 4: "squads" };

export const TEAM = {
  knockHp: 100,           // the bleed-out bar: playerHealth while you're knocked
  bleedTimes: [70, 40, 22, 12], // s to bleed out: 1st knock, 2nd, … (the last one repeats)
  reviveTime: 5,          // s holding the revive
  reviveRange: 2.4,       // m
  reviveHp: 30,           // health you get up with
  cardTime: 90,           // s a dead player's recall card lies on the ground
  cardHeldTime: 150,      // s a teammate has to get it to a recall tower
  cardDropTime: 45,       // s it lies there again if whoever held it dies
  cardRange: 2.6,         // m to pick it up
  towerRange: 8,          // m from a recall tower
  recallTime: 6,          // s of calling
  recallHp: 100,
};

export const QUICK_CHAT = [
  { text: "Enemy ahead!", ping: "enemy" },
  { text: "Need medkit" },
  { text: "Follow me", ping: "self" },
  { text: "I'm down" },
  { text: "Need ammo" },
  { text: "Get in the vehicle" },
  { text: "Hold this position", ping: "self" },
  { text: "On my way" },
  { text: "Thanks!" },
];

/** What a ping on each kind of thing says, and its colour. */
export const PING_LOOK = {
  enemy: { color: "#ff4b3a", label: "ENEMY" },
  loot: { color: "#ffc23d", label: "LOOT" },
  vehicle: { color: "#6affd8", label: "VEHICLE" },
  go: { color: "#4dd2ff", label: "GO HERE" },
  map: { color: "#4dd2ff", label: "MARKED" },
};

export const bleedTime = n => TEAM.bleedTimes[Math.min(Math.max(1, n), TEAM.bleedTimes.length) - 1];

/** The relay room of a code in a queue. The code can't hold the "." that marks the queue. */
export function relayRoomName(code, size) {
  const clean = String(code).replace(/\./g, "-");
  return size > 1 ? `br-${clean}`.slice(0, 22) + `.${size}` : `br-${clean}`.slice(0, 24);
}

/** "br-horde.4" → { code: "horde", size: 4 }. */
export function parseRoomName(room) {
  const m = /^br-(.*?)(?:\.(2|4))?$/.exec(room) ?? [];
  return { code: m[1] ?? room, size: Number(m[2]) || 1 };
}

/**
 * Deals the teams. humans: [{ id, party, fill }] (party "" = none), bots: ids,
 * size: 1 | 2 | 4. Returns [[ids], …].
 *  - a party stays together (one bigger than a team is cut into full teams);
 *  - with Fill on, parties and lone players share teams that have room,
 *    biggest parties first so they aren't split up by the small ones;
 *  - with Fill off (anyone in the group), the group plays alone, short-handed;
 *  - bots take the empty seats of Fill teams, then form teams of their own.
 */
export function assignTeams(humans, bots, size) {
  if (size <= 1) return [...humans.map(h => [h.id]), ...bots.map(id => [id])];
  const groups = new Map();
  let lone = 0;
  for (const h of humans) {
    const key = h.party ? `p:${h.party}` : `s:${lone++}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  const parts = [];
  for (const members of groups.values()) {
    for (let i = 0; i < members.length; i += size) {
      const chunk = members.slice(i, i + size);
      parts.push({ ids: chunk.map(h => h.id), fill: chunk.every(h => h.fill) });
    }
  }
  parts.sort((a, b) => b.ids.length - a.ids.length);
  const teams = [];
  for (const part of parts) {
    const seat = part.fill ? teams.find(t => t.fill && t.ids.length + part.ids.length <= size) : null;
    if (seat) seat.ids.push(...part.ids);
    else teams.push({ ids: [...part.ids], fill: part.fill });
  }
  const queue = [...bots];
  for (const t of teams) while (t.fill && t.ids.length < size && queue.length) t.ids.push(queue.shift());
  const out = teams.map(t => t.ids);
  while (queue.length) out.push(queue.splice(0, size));
  return out;
}

/**
 * A late joiner's seat (teams is changed in place): with their party if there's
 * room, else (Fill on) any team with a free seat, else a team of their own.
 * partyOf(id) gives the party of a player already in a team.
 */
export function seatLate(teams, human, size, partyOf) {
  if (size <= 1) { teams.push([human.id]); return; }
  const free = t => t.length < size;
  let seat = human.party ? teams.find(t => free(t) && t.some(id => partyOf(id) === human.party)) : null;
  if (!seat && human.fill) seat = teams.find(free);
  if (seat) seat.push(human.id);
  else teams.push([human.id]);
}
