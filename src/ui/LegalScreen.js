import "./legal.css";
import { CREDIT_GROUPS, DISCLAIMER, LICENCES, LEGAL_CONTACT } from "../legal/credits.js";

// Credits & Legal: the game's disclaimer and the full attribution for every
// third-party asset (src/legal/credits.js). Opened from the lobby's top bar and
// the start / pause screen; shown once on the first visit, until it's accepted.

// Bump the version when the disclaimer changes, so everyone reads and accepts it again
const ACK_KEY = "babylon-fps:legal-ack-v3";

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const SHIELD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 4 5.6v6.1c0 4.7 3.3 8.8 8 9.8 4.7-1 8-5.1 8-9.8V5.6z"/><path d="m8.6 12 2.4 2.4 4.6-4.8"/></svg>`;

export class LegalScreen {
  constructor() {
    this.el = document.createElement("div");
    this.el.id = "legal";
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "true");
    this.el.setAttribute("aria-labelledby", "legal-title");
    this.el.innerHTML = this._markup();
    document.body.append(this.el);
    this.body = this.el.querySelector(".lg-body");
    this.acceptBtn = this.el.querySelector(".lg-accept");
    this.el.addEventListener("click", e => {
      const tab = e.target.closest("[data-tab]");
      if (tab) { this.tab(tab.dataset.tab); return; }
      if (e.target.closest(".lg-close") || e.target === this.el) this.close();
      if (e.target.closest(".lg-accept")) this.accept();
    });
    // Nothing here should reach the game (pointer lock, keys)
    for (const t of ["pointerdown", "mousedown", "wheel", "touchstart"]) this.el.addEventListener(t, e => e.stopPropagation(), { passive: true });
    window.addEventListener("keydown", e => {
      if (!this.isOpen) return;
      e.stopPropagation();
      if (e.key === "Escape" && this.accepted) this.close();
    }, true);
    this.tab("disclaimer");
  }

  get accepted() {
    try { return localStorage.getItem(ACK_KEY) === "1"; } catch { return true; }
  }

  get isOpen() { return this.el.classList.contains("open"); }

  /** First visit: the disclaimer, until it's accepted. */
  showFirstTime() {
    if (!this.accepted) this.open("disclaimer");
  }

  open(tab = "credits") {
    this.tab(tab);
    this.el.classList.toggle("must-accept", !this.accepted);
    this.el.classList.add("open");
    if (document.pointerLockElement) document.exitPointerLock();
    this.el.querySelector(".lg-card").focus({ preventScroll: true });
  }

  close() {
    if (!this.accepted) return;
    this.el.classList.remove("open");
  }

  accept() {
    try { localStorage.setItem(ACK_KEY, "1"); } catch { /* private mode: asked again next time */ }
    this.el.classList.remove("must-accept");
    this.el.classList.remove("open");
  }

  tab(name) {
    for (const b of this.el.querySelectorAll("[data-tab]")) b.classList.toggle("on", b.dataset.tab === name);
    for (const p of this.el.querySelectorAll(".lg-panel")) p.hidden = p.dataset.panel !== name;
    if (this.body) this.body.scrollTop = 0;
  }

  _markup() {
    const year = new Date().getFullYear();
    const licence = name => LICENCES[name]
      ? `<a class="lg-chip" href="${LICENCES[name]}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`
      : `<span class="lg-chip lg-chip-plain">${esc(name)}</span>`;
    const groups = CREDIT_GROUPS.map(g => `
      <section class="lg-group">
        <h3>${esc(g.title)}</h3>
        ${g.note ? `<p class="lg-note">${esc(g.note)}</p>` : ""}
        ${g.items.length ? `<ul>${g.items.map(it => `
          <li>
            <div class="lg-item-top">
              <span class="lg-what">${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.what)}</a>` : esc(it.what)}</span>
              ${licence(it.licence)}
            </div>
            <div class="lg-who">by ${esc(it.who)}</div>
            ${it.changes ? `<div class="lg-changes">${esc(it.changes)}</div>` : ""}
          </li>`).join("")}</ul>` : ""}
      </section>`).join("");
    const disclaimer = DISCLAIMER.map(p => `
      <section class="lg-clause">
        <h3>${esc(p.heading)}</h3>
        <p>${esc(p.text)}${p.heading === "Rights holders" && LEGAL_CONTACT ? ` Contact: <b>${esc(LEGAL_CONTACT)}</b>.` : ""}</p>
      </section>`).join("");
    return `
      <div class="lg-card" tabindex="-1">
        <header class="lg-head">
          <div class="lg-crest">${SHIELD}</div>
          <div class="lg-titles">
            <span class="lg-eyebrow">Survive the Horde</span>
            <h2 id="legal-title">Credits &amp; Legal</h2>
          </div>
          <button class="lg-close" aria-label="Close">✕</button>
        </header>
        <nav class="lg-tabs" role="tablist">
          <button data-tab="disclaimer" role="tab">Disclaimer</button>
          <button data-tab="credits" role="tab">Credits</button>
        </nav>
        <div class="lg-body">
          <div class="lg-panel" data-panel="disclaimer">
            <p class="lg-lead">Please read before you play. By playing you accept these terms.</p>
            ${disclaimer}
          </div>
          <div class="lg-panel" data-panel="credits" hidden>
            <p class="lg-lead">This game stands on the work of many generous creators. Thank you.</p>
            ${groups}
          </div>
        </div>
        <footer class="lg-foot">
          <span class="lg-copy">© ${year} Survive the Horde. Third-party content © its owners, used under the licences above.</span>
          <button class="lg-accept">I understand · Continue</button>
        </footer>
      </div>`;
  }
}

/** The small "Credits & Legal" button (lobby top bar, start screen). */
export function legalButton(screen, cls = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `lg-open ${cls}`.trim();
  b.innerHTML = `${SHIELD}<span>Credits &amp; Legal</span>`;
  b.addEventListener("click", e => { e.stopPropagation(); screen.open("credits"); });
  b.addEventListener("pointerdown", e => e.stopPropagation());
  return b;
}
