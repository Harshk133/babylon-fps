// Name / room entry shown after loading. Three modes: solo against the horde,
// co-op against the horde, or a battle royale (players against each other).

import { IS_TOUCH } from "../input/TouchControls.js";

const NAME_KEY = "babylon-fps:name";
const ROOM_KEY = "babylon-fps:room";

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
    this.coopBtn = document.getElementById("lobby-coop");
    this.soloBtn = document.getElementById("lobby-solo");
    this.brBtn = document.getElementById("lobby-br");
    this.open = false;

    const params = new URLSearchParams(location.search);
    this.nameEl.value = load(NAME_KEY, "");
    this.roomEl.value = params.get("room") || load(ROOM_KEY, "horde");

    const name = () => {
      const n = this.nameEl.value.trim().slice(0, 16) || `Survivor${Math.floor(Math.random() * 900 + 100)}`;
      save(NAME_KEY, n);
      return n;
    };
    this.soloBtn.addEventListener("click", () => onSolo(name()));
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
        this.setBusy(false);
      } finally {
        clearTimeout(slow);
      }
    };
    this.coopBtn.addEventListener("click", () => join(onCoop));
    this.brBtn.addEventListener("click", () => join(onBattleRoyale));
    for (const el of [this.nameEl, this.roomEl]) {
      el.addEventListener("keydown", e => {
        e.stopPropagation(); // typing WASD here shouldn't move the player
        if (e.key === "Enter") this.coopBtn.click();
      });
      el.addEventListener("keyup", e => e.stopPropagation());
    }
  }

  setStatus(text, error = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", error);
  }

  setBusy(busy) {
    this.coopBtn.disabled = busy;
    this.soloBtn.disabled = busy;
    this.brBtn.disabled = busy;
  }

  show() {
    this.open = true;
    this.el.classList.add("visible");
    // Phones would pop the keyboard up over the whole lobby
    if (!IS_TOUCH) setTimeout(() => this.nameEl.focus(), 50);
  }

  hide() {
    this.open = false;
    this.el.classList.remove("visible");
  }
}
