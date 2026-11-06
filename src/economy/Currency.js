// The game's money: the Taara (✦), a made-up currency. It isn't modelled on any
// real one, so no real banknote or currency sign is reproduced anywhere in the
// game. Change the name or symbol here and every price, wallet and banner follows.

export const CURRENCY = {
  name: "Taara",        // singular and plural ("500 Taara")
  symbol: "✦",
};

/** 2000 → "✦2,000". */
export const fmtMoney = n => `${CURRENCY.symbol}${Math.round(n).toLocaleString("en-IN")}`;
