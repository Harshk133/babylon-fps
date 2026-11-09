// Your squad on the home screen: friends with the same room, team size and party
// code stand next to your character before anyone presses Play.
//
// While the lobby shows a Duo / Squad party, this keeps its own small connection
// (a second Net, so the match connection is untouched) to a presence room on the
// relay, named by Lobby.partyRoom. Everyone says what they look like (`look`:
// avatar code + name); the models go into the lobby's 3D preview (CharacterPreview
// setCrew), with name tags over them and a roster line that also works where the
// layout has no room for the 3D stage. Leaving the lobby closes the connection.

import { Net } from "./Net.js";
import { Soldier } from "../player/Soldier.js";
import { avatarFromId, encodeAvatar } from "../player/Avatar.js";

const TYPING_WAIT = 500;   // ms after the last keystroke before joining a party
const RETRY_WAIT = 8000;   // ms between tries while the relay can't be reached
const NAME_MAX = 16;

const elt = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class SquadLobby {
  /**
   * preview(): the CharacterPreview; loader: the game's GLTFLoader; avatar(): your
   * avatar code; name(): your name; stage: the 3D stage element; roster: the line
   * under it.
   */
  constructor({ preview, loader, avatar, name, stage, roster }) {
    this.preview = preview;
    this.loader = loader;
    this.avatar = avatar;
    this.name = name;
    this.stage = stage;
    this.roster = roster;
    this.net = new Net();
    this.room = null;        // the presence room we want (null: none)
    this.size = 2;
    this.members = new Map(); // id → { id, name, color, av, soldier }
    this._timer = 0;
    this._attempt = 0;
    this._said = "";         // the last look we told everyone
    this._dirty = false;     // the 3D preview needs the current crew
    this._layout = -1;       // which preview layout the name tags were placed for

    this.tags = elt("div", "lb-crew-tags");
    stage?.append(this.tags);

    const net = this.net;
    net.on("joined", msg => { this._add(msg.p); this._sayLook(msg.p.id); });
    net.on("left", msg => this._remove(msg.id));
    net.on("look", msg => this._onLook(msg));
    // Back after a drop: the relay's roster is the truth, and they may have missed our look
    const again = welcome => { this._reconcile(welcome); this._sayLook(); };
    net.on("resumed", again);
    net.on("rejoined", again);
  }

  /** room: Lobby.partyRoom (null: no party), size: 2 | 4. Also picks up a changed name or look. */
  set(room, size) {
    this.size = size;
    if (room === this.room) {
      if (room && this.net.connected) this._sayLook();
      this._draw();
      return;
    }
    this.room = room;
    this._leave();
    clearTimeout(this._timer);
    if (room) this._timer = setTimeout(() => this._join(), TYPING_WAIT);
    this._draw();
  }

  async _join() {
    const room = this.room, attempt = ++this._attempt;
    if (!room) return;
    try {
      const welcome = await this.net.connect(Net.defaultUrl(), this.name(), room);
      if (attempt !== this._attempt || room !== this.room) return; // the party changed meanwhile
      this._reconcile(welcome);
      this._sayLook();
    } catch {
      // The relay is asleep or unreachable: the lobby works without it, keep trying quietly
      if (attempt === this._attempt && room === this.room) this._timer = setTimeout(() => this._join(), RETRY_WAIT);
    }
  }

  _leave() {
    this._attempt++;
    this.net.close();
    for (const id of [...this.members.keys()]) this._remove(id);
    this._said = "";
  }

  _reconcile(welcome) {
    const here = new Set(welcome.players.map(p => p.id));
    for (const id of [...this.members.keys()]) if (!here.has(id)) this._remove(id);
    for (const p of welcome.players) if (p.id !== this.net.id) this._add(p);
    this._draw();
  }

  _add(p) {
    if (this.members.has(p.id) || p.id === this.net.id) return;
    this.members.set(p.id, { id: p.id, name: p.name, color: p.color, av: null, soldier: null });
    this._draw();
  }

  _remove(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    m.soldier?.release();
    this._dirty = true;
    this._draw();
  }

  /** to: one newcomer; otherwise everyone, if it changed. */
  _sayLook(to) {
    const av = this.avatar(), n = this.name().slice(0, NAME_MAX), said = `${av}|${n}`;
    if (to === undefined) {
      if (said === this._said) return;
      this._said = said;
      this.net.send({ t: "look", av, n });
    } else {
      this.net.send({ t: "look", to, av, n });
    }
  }

  _onLook({ from, av, n }) {
    const m = this.members.get(from);
    if (!m) return;
    if (typeof n === "string" && n.trim()) m.name = n.trim().slice(0, NAME_MAX);
    const code = Number.isInteger(av) && av >= 0 ? av : encodeAvatar(avatarFromId(from));
    this._build(m, code);
    this._draw();
  }

  /** Loads their model; the old one stays up until the new one is ready. */
  _build(m, code) {
    if (m.av === code) return;
    m.av = code;
    const soldier = new Soldier({ avatar: code });
    soldier.load(this.loader).then(() => {
      if (this.members.get(m.id) !== m || m.av !== code) { soldier.release(); return; }
      soldier.setCarried([]);
      soldier.setWeapon(null);
      m.soldier?.release();
      m.soldier = soldier;
      this._dirty = true;
    }).catch(err => console.warn(err));
  }

  /** Who's shown: the first ones to arrive, as many as fit the team. */
  _crew() {
    return [...this.members.values()].sort((a, b) => a.id - b.id).slice(0, this.size - 1);
  }

  /** The roster line (and the crew's places on the stage). Only on changes. */
  _draw() {
    this._dirty = true;
    const el = this.roster;
    if (!el) return;
    el.hidden = !this.room;
    if (!this.room) { el.replaceChildren(); return; }
    const crew = this._crew();
    const head = elt("span", "lb-crew-head", `${this.size === 2 ? "Duo" : "Squad"} ${crew.length + 1}/${this.size}`);
    const you = elt("span", "lb-crew-name me", `${this.name().slice(0, NAME_MAX)} (you)`);
    const rest = crew.map(m => {
      const n = elt("span", "lb-crew-name", m.name);
      n.style.setProperty("--who", m.color);
      return n;
    });
    const parts = [head, you, ...rest];
    if (!crew.length) parts.push(elt("span", "lb-crew-wait", "Send your invite link: friends appear here"));
    el.replaceChildren(...parts);
  }

  /** Every frame the lobby is up. Allocates nothing unless something changed. */
  update() {
    const preview = this.preview();
    if (!preview?.ready) return;
    if (this._dirty) {
      this._dirty = false;
      const crew = this._crew().filter(m => m.soldier);
      preview.setCrew(crew.map(m => m.soldier));
      this.stage?.classList.toggle("crew", crew.length > 0);
      this._crewShown = crew;
      this._layout = -1;
    }
    if (this._layout !== preview.layoutVersion) {
      this._layout = preview.layoutVersion;
      this._placeTags(preview);
    }
  }

  /** Name tags over the heads, as a share of the stage (the canvas fills it when there's a crew). */
  _placeTags(preview) {
    const crew = this._crewShown ?? [];
    if (!crew.length) { this.tags.replaceChildren(); return; }
    const you = { name: this.name().slice(0, NAME_MAX), color: "#fff", soldier: preview.soldier };
    this.tags.replaceChildren(...[you, ...crew].map(m => {
      const at = preview.headOnScreen(m.soldier);
      const t = elt("span", "lb-crew-tag", m.name);
      t.style.left = `${(at.x * 100).toFixed(2)}%`;
      t.style.top = `${Math.max(at.y * 100, 14).toFixed(2)}%`; // (never above the stage, it would be cut off)
      t.style.setProperty("--who", m.color);
      return t;
    }));
  }
}
