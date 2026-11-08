// Room chat (co-op and battle royale): a message log bottom left and a text
// box that opens on Enter / Y (or the touch chat button). Messages travel as
// `chat { m }` through the relay; the sender's name and colour come from the
// relay's player list, so nobody can type as someone else.
//
// While the box is open its key events stop at the input, so typing never
// moves the player. Lines fade out after a while; opening the box shows the
// recent history again.

const MAX_LEN = 120;        // characters per message (the relay cuts at the same length)
const MAX_LINES = 40;       // history kept in the log
const SHOW_FOR = 9000;      // ms a new line stays up while the box is closed
const SEND_GAP = 700;       // ms between your messages

export class Chat {
  /**
   * @param {{ send: (text: string) => void, onOpen?: () => void, onClose?: () => void }} cb
   */
  constructor(cb) {
    this.cb = cb;
    this.isOpen = false;
    this.enabled = false;
    this._lastSent = 0;

    const root = this.el = document.createElement("div");
    root.id = "chat";
    root.innerHTML = `
      <div class="chat-log"></div>
      <form class="chat-form" autocomplete="off">
        <button type="button" class="chat-to">ALL</button>
        <input class="chat-input" type="text" maxlength="${MAX_LEN}" enterkeyhint="send" spellcheck="false" placeholder="Say something…" />
        <span class="chat-hint"><kbd>Enter</kbd> send <kbd>Esc</kbd> close</span>
      </form>`;
    document.body.append(root);
    this.log = root.querySelector(".chat-log");
    this.form = root.querySelector(".chat-form");
    this.input = root.querySelector(".chat-input");
    this.toEl = root.querySelector(".chat-to");
    this.hasTeam = false;     // in a Duo / Squad match: the box can talk to the team
    this.toTeam = false;
    // (pointerdown, so the input doesn't lose focus and close the box)
    this.toEl.addEventListener("pointerdown", e => { e.preventDefault(); this._switchTo(); });

    this.form.addEventListener("submit", e => {
      e.preventDefault();
      this._submit();
    });
    // Keep the game's key handlers out of it while typing
    const stop = e => {
      e.stopPropagation();
      if (e.type === "keydown" && e.code === "Escape") { e.preventDefault(); this.close(); }
      if (e.type === "keydown" && e.code === "Tab") { e.preventDefault(); this._switchTo(); }
    };
    this.input.addEventListener("keydown", stop);
    this.input.addEventListener("keyup", stop);
    // Tapping / clicking elsewhere closes it (the draft stays)
    this.input.addEventListener("blur", () => this.close());
  }

  /** Shown only in a multiplayer room. */
  setEnabled(on) {
    this.enabled = on;
    this.el.classList.toggle("on", on);
    document.body.classList.toggle("chat-on", on);
    if (!on) this.close();
  }

  /** A Duo / Squad match started or ended: the box defaults to the team while there is one. */
  setTeam(on) {
    this.hasTeam = on;
    this.toTeam = on;
    this._showTo();
  }

  _switchTo() {
    if (!this.hasTeam) return;
    this.toTeam = !this.toTeam;
    this._showTo();
  }

  _showTo() {
    this.toEl.textContent = this.toTeam ? "TEAM" : "ALL";
    this.toEl.classList.toggle("team", this.toTeam);
    this.toEl.title = this.hasTeam ? "Tab: switch between team and everyone" : "";
  }

  open() {
    if (!this.enabled || this.isOpen) return;
    this.isOpen = true;
    this.el.classList.add("open");
    this.input.focus({ preventScroll: true });
    this.log.scrollTop = this.log.scrollHeight;
    this.cb.onOpen?.();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.remove("open");
    if (document.activeElement === this.input) this.input.blur();
    this.cb.onClose?.();
  }

  _submit() {
    const text = this.input.value.replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
    if (text) {
      const now = performance.now();
      if (now - this._lastSent < SEND_GAP) return; // keep the draft, try again in a moment
      this._lastSent = now;
      this.cb.send(text, this.hasTeam && this.toTeam);
      this.input.value = "";
    }
    this.close();
  }

  /** A player's message. `self` marks your own; `team`: only your team saw it. */
  add(name, color, text, self = false, team = false) {
    const line = document.createElement("div");
    line.className = `chat-line${self ? " self" : ""}${team ? " team" : ""}`;
    const who = document.createElement("span");
    who.className = "chat-name";
    who.style.color = color || "#e8dccb";
    who.textContent = name;
    const msg = document.createElement("span");
    msg.className = "chat-text";
    msg.textContent = text;
    line.append(who, msg);
    this._push(line);
  }

  /** A grey line: someone joined, left, … */
  system(text) {
    const line = document.createElement("div");
    line.className = "chat-line sys";
    line.textContent = text;
    this._push(line);
  }

  clear() {
    this.log.textContent = "";
  }

  _push(line) {
    this.log.append(line);
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
    // Fresh lines show over the game for a while, then fade (the open box shows them all)
    line.classList.add("fresh");
    setTimeout(() => line.classList.remove("fresh"), SHOW_FOR);
  }
}

Chat.MAX_LEN = MAX_LEN;
