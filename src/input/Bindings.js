// Rebindable keyboard shortcuts. Every action the keyboard drives has an id, a
// label and a default key (the game's original layout); players can change any
// of them in Settings → Controls (src/ui/SettingsPanel.js), saved in
// localStorage. main.js asks `actionOf(code)` for each key press. A few keys
// are fixed on top: arrows move, the right Shift sprints, 1-5 pick guns, Esc
// pauses, Enter and "/" open chat.
//
// Touch buttons and the tappable prompts send the DEFAULT code of an action
// (they don't know about rebinding): `fromDefault(code)` turns that into the
// action, so a rebound key never breaks a touch button.

export const ACTIONS = [
  // Movement
  { id: "forward",  label: "Move forward",                  key: "KeyW",      group: "Movement" },
  { id: "back",     label: "Move back",                     key: "KeyS",      group: "Movement" },
  { id: "left",     label: "Move left",                     key: "KeyA",      group: "Movement" },
  { id: "right",    label: "Move right",                    key: "KeyD",      group: "Movement" },
  { id: "jump",     label: "Jump / stand up / parachute",   key: "Space",     group: "Movement" },
  { id: "sprint",   label: "Sprint (hold breath when scoped)", key: "ShiftLeft", group: "Movement" },
  { id: "crouch",   label: "Crouch",                        key: "KeyC",      group: "Movement" },
  { id: "prone",    label: "Go prone",                      key: "KeyZ",      group: "Movement" },
  // Combat
  { id: "reload",   label: "Reload",                        key: "KeyR",      group: "Combat" },
  { id: "throw",    label: "Throw (hold to aim)",           key: "KeyG",      group: "Combat" },
  { id: "cycleThrow", label: "Switch throwable",            key: "KeyQ",      group: "Combat" },
  { id: "heal",     label: "Heal (medkit / biscuit)",       key: "KeyH",      group: "Combat" },
  { id: "torch",    label: "Flashlight",                    key: "KeyN",      group: "Combat" },
  { id: "grapple",  label: "Rope gun (fire / let go)",      key: "KeyU",      group: "Movement" },
  // Interact
  { id: "interact", label: "Pick up",                       key: "KeyE",      group: "Interact" },
  { id: "use",      label: "Doors, gates / kick a crate",   key: "KeyF",      group: "Interact" },
  { id: "light",    label: "Light switch",                  key: "KeyL",      group: "Interact" },
  { id: "shop",     label: "Shop (at a dukaan)",            key: "KeyB",      group: "Interact" },
  // Vehicles
  { id: "vehicle",  label: "Drive / ride / get out",        key: "KeyV",      group: "Vehicles" },
  { id: "pillionFront", label: "Sit behind, facing front",  key: "KeyX",      group: "Vehicles" },
  // Was Y, which also opened the chat: now J by default
  { id: "pillionBack",  label: "Sit behind, facing back",   key: "KeyJ",      group: "Vehicles" },
  { id: "refuel",   label: "Refuel (petrol can)",           key: "KeyT",      group: "Vehicles" },
  { id: "repair",   label: "Repair (toolkit)",              key: "KeyK",      group: "Vehicles" },
  // Menus
  { id: "inventory", label: "Inventory",                    key: "Tab",       group: "Menus" },
  { id: "map",      label: "Map",                           key: "KeyM",      group: "Menus" },
  { id: "chat",     label: "Chat (Enter works too)",        key: "KeyY",      group: "Menus" },
];
export const GROUPS = ["Movement", "Combat", "Interact", "Vehicles", "Menus"];

const KEY = "babylon-fps:keys";
const BY_ID = new Map(ACTIONS.map(a => [a.id, a]));
const BY_DEFAULT = new Map(ACTIONS.map(a => [a.key, a.id]));
/** Keys a player can't take: they do something already (pause, weapon slots, chat). */
const RESERVED = new Set(["Escape", "Enter", "NumpadEnter", "Slash", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "F5", "F11", "F12", "MetaLeft", "MetaRight"]);

const NAMES = {
  Space: "Space", Tab: "Tab", ShiftLeft: "Shift", ShiftRight: "R-Shift", ControlLeft: "Ctrl", ControlRight: "R-Ctrl",
  AltLeft: "Alt", AltRight: "R-Alt", CapsLock: "Caps", Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[",
  BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Backspace: "Bksp",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Insert: "Ins", Delete: "Del", Home: "Home",
  End: "End", PageUp: "PgUp", PageDown: "PgDn",
};

/** "KeyF" → "F", "Digit7" → "7", "Numpad4" → "Num 4", "ShiftLeft" → "Shift". */
export function keyName(code) {
  if (!code) return "—";
  if (NAMES[code]) return NAMES[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

export class Bindings {
  constructor() {
    this.map = {};
    for (const a of ACTIONS) this.map[a.id] = a.key;
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      for (const [id, code] of Object.entries(saved)) if (BY_ID.has(id) && typeof code === "string") this.map[id] = code;
    } catch { /* storage blocked: defaults */ }
    this.onChange = null;
    this._index();
  }

  _index() {
    this.byCode = new Map();
    for (const [id, code] of Object.entries(this.map)) this.byCode.set(code, id);
    this.version = (this.version ?? 0) + 1;
  }

  _save() {
    const out = {};
    for (const a of ACTIONS) if (this.map[a.id] !== a.key) out[a.id] = this.map[a.id];
    try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* private mode */ }
  }

  /** The action a key press means, or null. */
  actionOf(code) { return this.byCode.get(code) ?? null; }
  /** The key an action is on. */
  code(id) { return this.map[id]; }
  /** Its key as shown in the HUD ("F", "Space"). */
  label(id) { return keyName(this.map[id]); }
  /** A touch button / prompt sent an action's original key: which action. */
  fromDefault(code) { return BY_DEFAULT.get(code) ?? null; }
  isDefault(id) { return this.map[id] === BY_ID.get(id)?.key; }
  reserved(code) { return RESERVED.has(code); }

  /**
   * Puts action id on code. If another action had that key, the two swap (so
   * nothing is ever left on two keys). Returns the action that moved, or null.
   */
  set(id, code) {
    if (!BY_ID.has(id) || RESERVED.has(code)) return null;
    const other = this.byCode.get(code);
    const old = this.map[id];
    if (other === id) return null;
    this.map[id] = code;
    if (other) this.map[other] = old;
    this._index();
    this._save();
    this.onChange?.();
    return other ?? null;
  }

  reset() {
    for (const a of ACTIONS) this.map[a.id] = a.key;
    this._index();
    this._save();
    this.onChange?.();
  }
}
