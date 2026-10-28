// The dukaan: what the town stalls sell and the buy screen. Pure catalog +
// DOM; main.js decides whether a purchase fits (buy(id) → { ok, msg }).
//
// Prices are in rupees. A ₹2000 note bundle lies around the map; monsters pay
// ₹100-₹500 a kill (bosses far more), so a couple of notes buy a medkit or a
// grenade and a good gun takes a while.

/** give: "stack" (n of a backpack kind) | "ammo" (an ammo crate) | "gun" | "gear" | "attachment". */
export const SHOP_ITEMS = [
  { id: "biscuit",  give: "stack", n: 2, price: 200,  label: "Parle-G ×2",      note: "+20 health each" },
  { id: "medkit",   give: "stack", n: 1, price: 1000, label: "Medkit",          note: "+50 health" },
  { id: "ammo",     give: "ammo",        price: 600,  label: "Ammo Crate",      note: "Refills every gun" },
  { id: "grenade",  give: "stack", n: 1, price: 800,  label: "Frag Grenade" },
  { id: "molotov",  give: "stack", n: 1, price: 700,  label: "Molotov" },
  { id: "smoke",    give: "stack", n: 1, price: 500,  label: "Smoke Grenade" },
  { id: "fuel",     give: "stack", n: 1, price: 600,  label: "Petrol Can",      note: "For the rickshaw / Thar" },
  { id: "helmet2",  give: "gear",        price: 2500, label: "Helmet Lv. 2" },
  { id: "vest2",    give: "gear",        price: 3000, label: "Vest Lv. 2" },
  { id: "backpack2", give: "gear",       price: 2000, label: "Backpack Lv. 2" },
  { id: "scope4x",  give: "attachment",  price: 3000, label: "4x Scope" },
  { id: "rifle",    give: "gun",         price: 4000, label: "Assault Rifle" },
  { id: "sniper",   give: "gun",         price: 8000, label: "Sniper Rifle" },
];

export const fmtRupees = n => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * The buy screen: a grid of item cards with prices. Opens over the game (the
 * world keeps running, like the map). icons: item id → image URL.
 * buy(id) → { ok, msg }; canBuy(item) → "" (fine) or why not; onClose().
 */
export class ShopUI {
  constructor({ icons, buy, canBuy, onClose }) {
    this.buy = buy;
    this.canBuy = canBuy;
    this.onClose = onClose;
    this.open = false;
    this._sig = "";

    const root = this.root = document.createElement("div");
    root.id = "shop";
    root.innerHTML = `
      <div class="shop-panel" role="dialog" aria-label="Shop">
        <header class="shop-head">
          <div><h2>DUKAAN</h2><span class="shop-sub">Everything you need to survive</span></div>
          <div class="shop-wallet"><span class="shop-wallet-label">Wallet</span><b data-ref="cash">₹0</b></div>
          <button class="shop-close" data-ref="close" aria-label="Close">✕</button>
        </header>
        <div class="shop-grid" data-ref="grid"></div>
        <p class="shop-msg" data-ref="msg"></p>
      </div>`;
    this.el = {};
    for (const n of root.querySelectorAll("[data-ref]")) this.el[n.dataset.ref] = n;

    this.cards = SHOP_ITEMS.map(item => {
      const card = document.createElement("button");
      card.className = "shop-card";
      card.dataset.id = item.id;
      card.innerHTML = `
        <img src="${icons[item.id] ?? ""}" alt="">
        <span class="shop-name">${item.label}</span>
        ${item.note ? `<span class="shop-note">${item.note}</span>` : ""}
        <span class="shop-price">${fmtRupees(item.price)}</span>
        <span class="shop-why"></span>`;
      card.addEventListener("click", () => {
        const r = this.buy(item.id);
        this._flash(r.msg, r.ok);
        this._sig = "";
        this.update(this._cash, true);
      });
      this.el.grid.append(card);
      return { item, card, why: card.querySelector(".shop-why") };
    });
    this.el.close.addEventListener("click", () => this.onClose());
    // Clicks on the dim backdrop close it; nothing reaches the game underneath
    root.addEventListener("pointerdown", e => { if (e.target === root) this.onClose(); e.stopPropagation(); });
    root.addEventListener("click", e => e.stopPropagation());
    document.body.append(root);
  }

  setOpen(open) {
    this.open = open;
    this.root.classList.toggle("open", open);
    this.el.msg.textContent = "";
    this._sig = "";
  }

  /** Refreshes the wallet and which cards are affordable; touches the DOM only when something changed. */
  update(cash, force = false) {
    this._cash = cash;
    if (!this.open && !force) return;
    let sig = `${cash}|`;
    const why = this.cards.map(c => this.canBuy(c.item));
    for (const w of why) sig += `${w}|`;
    if (sig === this._sig) return;
    this._sig = sig;
    this.el.cash.textContent = fmtRupees(cash);
    this.cards.forEach((c, i) => {
      c.card.classList.toggle("off", !!why[i]);
      c.why.textContent = why[i];
    });
  }

  _flash(msg, ok) {
    if (!msg) return;
    this.el.msg.textContent = msg;
    this.el.msg.className = `shop-msg show ${ok ? "ok" : "bad"}`;
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => { this.el.msg.className = "shop-msg"; }, 1800);
  }
}
