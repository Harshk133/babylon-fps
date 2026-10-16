// App icon + splash for the Android app and the web manifest, drawn as SVG
// and rendered with sharp. Then: npx @capacitor/assets generate --android
//
//   node scripts/make-icons.mjs

import sharp from "sharp";
import { mkdirSync } from "node:fs";

const icon = (size, pad = 0) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="70%">
      <stop offset="0" stop-color="#3a0b08"/><stop offset="1" stop-color="#070303"/>
    </radialGradient>
  </defs>
  <rect width="100" height="100" fill="url(#bg)"/>
  <g transform="translate(50 41) scale(${0.8 * (1 - pad)})">
    <circle r="27" fill="none" stroke="#c4161c" stroke-width="5"/>
    <circle r="4.5" fill="#ff4b3a"/>
    <path d="M0-38v16M0 22v16M-38 0h16M22 0h16" stroke="#e8dccb" stroke-width="5" stroke-linecap="round"/>
  </g>
  <text x="50" y="93" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="14" letter-spacing="1" fill="#e2a42b">HORDE</text>
</svg>`;

const splash = `
<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732" viewBox="0 0 2732 2732">
  <rect width="2732" height="2732" fill="#050303"/>
  <g transform="translate(1366 1250) scale(9)">
    <circle r="27" fill="none" stroke="#c4161c" stroke-width="5"/>
    <circle r="4.5" fill="#ff4b3a"/>
    <path d="M0-38v16M0 22v16M-38 0h16M22 0h16" stroke="#e8dccb" stroke-width="5" stroke-linecap="round"/>
  </g>
  <text x="1366" y="1760" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="150" letter-spacing="12" fill="#c4161c">SURVIVE THE HORDE</text>
</svg>`;

mkdirSync("resources", { recursive: true });
mkdirSync("public/icons", { recursive: true });
await sharp(Buffer.from(icon(1024))).png().toFile("resources/icon.png");
// Adaptive icon layers: the crosshair inset so launchers can crop it to any shape
await sharp(Buffer.from(icon(1024, 0.3))).png().toFile("resources/icon-foreground.png");
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#1a0504" } }).png().toFile("resources/icon-background.png");
await sharp(Buffer.from(splash)).png().toFile("resources/splash.png");
await sharp(Buffer.from(splash)).png().toFile("resources/splash-dark.png");
for (const s of [192, 512]) await sharp(Buffer.from(icon(s))).png().toFile(`public/icons/icon-${s}.png`);
console.log("icons written to resources/ and public/icons/");
