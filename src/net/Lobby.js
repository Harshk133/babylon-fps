// Name / room entry shown after loading. Three modes: solo against the horde,
// co-op against the horde, or a battle royale (players against each other).
// Pick a mode card, then Play; the last mode is remembered.

import { IS_TOUCH } from "../input/TouchControls.js";
import "./lobby.css";

const NAME_KEY = "babylon-fps:name";
const ROOM_KEY = "babylon-fps:room";
const MODE_KEY = "babylon-fps:mode";
const MODES = { solo: "Solo", coop: "Co-op", br: "Battle Royale" };

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
    this.modeBtns = [...this.el.querySelectorAll("[data-mode]")];
    this.open = false;

    const params = new URLSearchParams(location.search);
    this.nameEl.value = load(NAME_KEY, "");
    this.roomEl.value = params.get("room") || load(ROOM_KEY, "horde");
    // An invite link (?room=) means a friend is waiting: start on co-op
    const saved = load(MODE_KEY, "solo");
    this.select(params.has("room") && saved === "solo" ? "coop" : MODES[saved] ? saved : "solo");

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
        this.setStatus(err.message || "Couldn't connect", true);
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
    for (const el of [this.nameEl, this.roomEl]) {
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
    this.playSubEl.textContent = MODES[mode];
    this.setStatus("");
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
