// 隐墨 / Inkveil app-icon pipeline — "07 雾中光标".
//
// No rsvg/ImageMagick/Inkscape on this box, but Electron is already a
// devDependency, so we rasterize the source SVGs with an offscreen Chromium
// canvas (exact pixel size, transparent corners, no baked shadow — macOS
// composites its own) and assemble an Apple .iconset → Inkveil.icns.
//
//   npm run icon         (= electron scripts/gen-icon.mjs)
//
// Inputs : build/icon/inkveil-fog-cursor.svg        (full,  size >= 48)
//          build/icon/inkveil-fog-cursor-small.svg  (adapt, size <  48)
// Outputs: build/Inkveil.icns, build/icon.png (1024 master), public/favicon.svg

import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_DIR = join(ROOT, "build", "icon");
const ISET_DIR = join(ROOT, "build", "Inkveil.iconset");

const FULL_SVG = readFileSync(join(ICON_DIR, "inkveil-fog-cursor.svg"), "utf8");
const SMALL_SVG = readFileSync(
  join(ICON_DIR, "inkveil-fog-cursor-small.svg"),
  "utf8"
);

// Apple .iconset manifest: [filename, pixel size, use small-adaptation?].
// Anything that renders < 48px uses the adapted (fat-cursor) art.
const ICONSET = [
  ["icon_16x16.png", 16, true],
  ["icon_16x16@2x.png", 32, true],
  ["icon_32x32.png", 32, true],
  ["icon_32x32@2x.png", 64, false],
  ["icon_128x128.png", 128, false],
  ["icon_128x128@2x.png", 256, false],
  ["icon_256x256.png", 256, false],
  ["icon_256x256@2x.png", 512, false],
  ["icon_512x512.png", 512, false],
  ["icon_512x512@2x.png", 1024, false],
];

// CPU-only canvas raster → deterministic across machines.
app.disableHardwareAcceleration();

function rasterize(win, svg, size) {
  const b64 = Buffer.from(svg, "utf8").toString("base64");
  // data: SVG into an <img> is same-origin → canvas stays untainted.
  return win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64,${b64}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = ${size}; c.height = ${size};
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, ${size}, ${size});
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL("image/png").split(",")[1];
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { offscreen: true },
  });
  await win.loadURL("data:text/html,<!doctype html><meta charset=utf-8><body>");

  rmSync(ISET_DIR, { recursive: true, force: true });
  mkdirSync(ISET_DIR, { recursive: true });

  for (const [name, size, small] of ICONSET) {
    const png = await rasterize(win, small ? SMALL_SVG : FULL_SVG, size);
    writeFileSync(join(ISET_DIR, name), Buffer.from(png, "base64"));
    console.log(`  ✓ ${name}  ${size}px${small ? "  (adapted)" : ""}`);
  }

  const master = await rasterize(win, FULL_SVG, 1024);
  writeFileSync(join(ROOT, "build", "icon.png"), Buffer.from(master, "base64"));
  console.log("  ✓ build/icon.png  1024px (master)");

  mkdirSync(join(ROOT, "public"), { recursive: true });
  writeFileSync(join(ROOT, "public", "favicon.svg"), SMALL_SVG);
  console.log("  ✓ public/favicon.svg  (adapted art — reads at tab size)");

  execFileSync(
    "iconutil",
    ["-c", "icns", ISET_DIR, "-o", join(ROOT, "build", "Inkveil.icns")],
    { stdio: "inherit" }
  );
  console.log("  ✓ build/Inkveil.icns");

  app.quit();
});

app.on("window-all-closed", () => app.quit());
