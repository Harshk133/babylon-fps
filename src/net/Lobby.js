// Name / room entry shown after loading. Three modes: solo against the horde,
// co-op against the horde, or a battle royale (players against each other).
// Pick a mode card, then Play; the last mode is remembered.
//
// Invite links (?room=<code>&mode=coop|br, see Net.inviteUrl) join straight in
// once the game has loaded (autoJoin). While you're in a room the address bar
// shows its link (setRoomUrl), so a reload puts you back in the same room.

import { IS_TOUCH } from "../input/TouchControls.js";
import { Net } from "./Net.js";
import "./lobby.css";

const NAME_KEY = "babylon-fps:name";
const ROOM_KEY = "babylon-fps:room";
const MODE_KEY = "babylon-fps:mode";
const TEAM_KEY = "babylon-fps:teamsize";
const FILL_KEY = "babylon-fps:fill";
const PARTY_KEY = "babylon-fps:party";
const MODES = { solo: "Solo", coop: "Co-op", br: "Battle Royale" };
const TEAM_LABELS = { 1: "Solo", 2: "Duo", 4: "Squad" };
const cleanParty = s => s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 12);

function load(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export class Lobby {
  /** onSolo(name); onCoop(name, room) / onBattleRoyale(name, room) → Promise (rejects with an Error to show). */
  constructor({ onSolo, onCoop, onBattleRoyale }) {
    this.el = document.getElementById("lobby");
    this.nameEl = document.getElementById("lobby-name");
    this.roomEl = document.getElementById("lobby-room");
    this.statusEl = document.getElementById("lobby-status");
    this.playBtn = document.getElementById("lobby-play");
    this.playSubEl = document.getElementById("lobby-play-sub");
    this.copyBtn = document.getElementById("lobby-copy");
    this.modeBtns = [...this.el.querySelectorAll("[data-mode]")];
    this.teamBtns = [...this.el.querySelectorAll("[data-team]")];
    this.fillEl = document.getElementById("lobby-fill");
    this.partyEl = document.getElementById("lobby-party");
    this.open = false;

    const params = new URLSearchParams(location.search);
    // An invite link says which queue and party; otherwise what you played last
    this.teamSize = Number(params.get("team")) || Number(load(TEAM_KEY, "1"));
    if (!TEAM_LABELS[this.teamSize]) this.teamSize = 1;
    this.fillEl.checked = load(FILL_KEY, "1") === "1";
    this.partyEl.value = cleanParty(params.get("party") ?? load(PARTY_KEY, ""));
    for (const btn of this.teamBtns) btn.addEventListener("click", () => this.selectTeam(Number(btn.dataset.team)));
    this.fillEl.addEventListener("change", () => save(FILL_KEY, this.fillEl.checked ? "1" : "0"));
    this.nameEl.value = load(NAME_KEY, "");
    this.roomEl.value = (params.get("room") || load(ROOM_KEY, "horde")).replace(/^br-/, "");
    // An invite link (?room=, ?mode=) means a friend is waiting: that mode (co-op if it doesn't say)
    const saved = load(MODE_KEY, "solo");
    const linked = params.get("mode");
    this.invite = params.has("room") && params.get("room").trim() ? (linked === "br" ? "br" : "coop") : null;
    this.select(this.invite ?? (MODES[saved] ? saved : "solo"));
    this.selectTeam(this.teamSize);

    this.copyBtn?.addEventListener("click", () => {
      const room = this.roomEl.value.trim().toLowerCase() || "horde";
      copyText(Net.inviteUrl(this.mode === "br" ? "br" : "coop", room, this.linkExtras(true)))
        .then(ok => this.setStatus(ok ? "Invite link copied: send it to your friends" : "Couldn't copy: copy the address bar after you join", !ok));
    });

    const name = () => {
      const n = this.nameEl.value.trim().slice(0, 16) || `Survivor${Math.floor(Math.random() * 900 + 100)}`;
      save(NAME_KEY, n);
      return n;
    };
    const join = async connect => {
      const room = this.roomEl.value.trim().toLowerCase() || "horde";
      save(ROOM_KEY, room);
      this.setBusy(true);
      this.setStatus("Connecting…");
      const slow = setTimeout(() => this.setStatus("Waking up the server… free hosts can take up to a minute"), 5000);
      try {
        await connect(name(), room);
        this.setStatus("");
      } catch (err) {
        // A battle royale down to its last few players takes nobody new until the match ends
        this.setStatus(err.closed ? `${err.message}. Try again when it ends.` : err.message || "Couldn't connect", true);
      } finally {
        clearTimeout(slow);
        this.setBusy(false);
      }
    };

    for (const btn of this.modeBtns) btn.addEventListener("click", () => this.select(btn.dataset.mode));
    this.playBtn.addEventListener("click", () => {
      save(MODE_KEY, this.mode);
      if (this.mode === "solo") onSolo(name());
      else join(this.mode === "coop" ? onCoop : onBattleRoyale);
    });
    for (const el of [this.nameEl, this.roomEl, this.partyEl]) {
      el.addEventListener("keydown", e => {
        e.stopPropagation(); // typing WASD here shouldn't move the player
        if (e.key === "Enter") this.playBtn.click();
      });
      el.addEventListener("keyup", e => e.stopPropagation());
    }
  }

  /** mode: "solo" | "coop" | "br". Colours the screen and the Play button. */
  select(mode) {
    this.mode = mode;
    for (const btn of this.modeBtns) {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle("selected", on);
      btn.setAttribute("aria-checked", on);
      if (on) this.el.style.setProperty("--mode", btn.style.getPropertyValue("--mode"));
    }
    this.el.dataset.mode = mode;
    if (this.copyBtn) this.copyBtn.hidden = mode === "solo";
    this._showPlaySub();
    this.setStatus("");
  }

  /** The battle royale queue: 1 | 2 | 4. Each is its own set of rooms. */
  selectTeam(size) {
    this.teamSize = size;
    save(TEAM_KEY, String(size));
    this.el.dataset.team = String(size);
    for (const btn of this.teamBtns) {
      const on = Number(btn.dataset.team) === size;
      btn.classList.toggle("selected", on);
      btn.setAttribute("aria-checked", on);
    }
    this._showPlaySub();
  }

  _showPlaySub() {
    this.playSubEl.textContent = this.mode === "br" && this.teamSize > 1 ? `Battle Royale · ${TEAM_LABELS[this.teamSize]}` : MODES[this.mode];
  }

  /** What you picked for the battle royale: { size, fill, party }. */
  get teamChoice() {
    const party = cleanParty(this.partyEl.value);
    save(PARTY_KEY, party);
    return { size: this.teamSize, fill: this.fillEl.checked, party: this.teamSize > 1 ? party : "" };
  }

  /**
   * The team= / party= part of an invite link. invite: it's for friends, so a
   * Duo / Squad without a party code gets one now (they land on your team).
   */
  linkExtras(invite = false) {
    if (this.mode !== "br" || this.teamSize <= 1) return {};
    if (invite && !cleanParty(this.partyEl.value)) this.partyEl.value = Math.random().toString(36).slice(2, 8);
    return { team: String(this.teamSize), party: this.teamChoice.party };
  }

  setStatus(text, error = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", error);
  }

  setBusy(busy) {
    this.playBtn.disabled = busy;
    for (const btn of this.modeBtns) btn.disabled = busy;
    this.el.classList.toggle("busy", busy);
  }

  /** Opened from an invite link (or reloaded inside a room): join it right away, once. */
  autoJoin() {
    if (!this.invite || this._autoJoined) return;
    this._autoJoined = true;
    this.playBtn.click();
  }

  /** The address bar shows the room's invite link while you're in it (a reload rejoins); null clears it. */
  static setRoomUrl(mode, room, extra = {}) {
    try {
      const url = new URL(location.href);
      for (const k of ["team", "party"]) url.searchParams.delete(k);
      if (mode) {
        url.searchParams.set("room", room); url.searchParams.set("mode", mode);
        for (const [k, v] of Object.entries(extra)) if (v) url.searchParams.set(k, v);
      } else { url.searchParams.delete("room"); url.searchParams.delete("mode"); }
      history.replaceState(history.state, "", url);
    } catch { /* sandboxed */ }
  }

  show() {
    this.open = true;
    this.el.classList.add("visible");
    // Phones would pop the keyboard up over the whole lobby
    if (!IS_TOUCH && !this.nameEl.value) setTimeout(() => this.nameEl.focus(), 50);
  }

  hide() {
    this.open = false;
    this.el.classList.remove("visible");
  }
}

/** Copies text to the clipboard (with the old execCommand fallback for plain-http LAN pages). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* not allowed */ }
    ta.remove();
    return ok;
  }
}
