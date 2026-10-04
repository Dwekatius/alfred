// Builds project icon assets from owner-supplied source PNGs.
//
//   node scripts/make-icon.mjs <light.png> [light flags] [--dark <dark.png> [dark flags]]
//
// Flags (apply to the variant they follow):
//   --remove-white   make near-white pixels transparent (logos on white)
//   --remove-black   make near-black pixels transparent (logos on black)
//   --plate          bake a rounded white tile behind the mark
//
// Outputs:
//   resources/logo.png (512, light)   resources/logo-dark.png (512, dark)
//   resources/favicon.png / favicon-dark.png (64)
//   resources/logo.ico (light, 16..256) for shortcuts and the tray
//   dashboard/ copies of all four
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "resources"), { recursive: true });
mkdirSync(join(root, "dashboard"), { recursive: true });

const argv = process.argv.slice(2);
const light = { source: undefined, removeWhite: false, removeBlack: false, plate: false };
const dark = { source: undefined, removeWhite: false, removeBlack: false, plate: false };
let target = light;
for (let i = 0; i < argv.length; i += 1) {
  const value = argv[i];
  if (value === "--dark") {
    target = dark;
    target.source = argv[++i];
  } else if (value === "--remove-white") target.removeWhite = true;
  else if (value === "--remove-black") target.removeBlack = true;
  else if (value === "--plate") target.plate = true;
  else if (value.startsWith("--")) {
    console.error(`unknown flag ${value}`);
    process.exit(2);
  } else light.source = light.source ?? value;
}
if (!light.source) {
  console.error("usage: node scripts/make-icon.mjs <light.png> [flags] [--dark <dark.png> [flags]]");
  process.exit(2);
}

/** Fade out near-neutral pixels of the chosen extreme (white or black). */
async function stripBackground(buffer, mode) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min > 24) continue;
    if (mode === "white" && max > 236) {
      const alpha = Math.round(Math.max(0, Math.min(1, (250 - max) / 14)) * 255);
      data[i + 3] = Math.min(data[i + 3], alpha);
    } else if (mode === "black" && max < 30) {
      const alpha = Math.round(Math.max(0, Math.min(1, (max - 4) / 26)) * 255);
      data[i + 3] = Math.min(data[i + 3], alpha);
    }
  }
  return await sharp(data, { raw: info }).png().toBuffer();
}

/** Square, centered, transparent margins trimmed. */
async function normalize(buffer) {
  return await sharp(buffer)
    .ensureAlpha()
    .trim({ threshold: 1 })
    .resize(880, 880, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toBuffer();
}

async function plateBehind(buffer, size = 820) {
  const plate = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } } })
    .composite([{ input: Buffer.from('<svg width="1024" height="1024"><rect width="1024" height="1024" rx="228" ry="228" fill="#ffffff"/></svg>'), blend: "dest-in" }])
    .png()
    .toBuffer();
  return await sharp(plate).composite([{ input: await sharp(buffer).resize(size, size).png().toBuffer(), gravity: "center" }]).png().toBuffer();
}

async function prepare(variant) {
  let buffer = await sharp(variant.source).png().toBuffer();
  if (variant.removeWhite) buffer = await stripBackground(buffer, "white");
  if (variant.removeBlack) buffer = await stripBackground(buffer, "black");
  buffer = await normalize(buffer);
  if (variant.plate) buffer = await plateBehind(buffer);
  return buffer;
}

const lightBuffer = await prepare(light);
const darkBuffer = dark.source ? await prepare(dark) : undefined;

const png = (buffer, size) => sharp(buffer).resize(size, size, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(join(root, "resources", "logo.png"), await png(lightBuffer, 512));
writeFileSync(join(root, "resources", "favicon.png"), await png(lightBuffer, 64));
writeFileSync(join(root, "dashboard", "logo.png"), await png(lightBuffer, 512));
writeFileSync(join(root, "dashboard", "favicon.png"), await png(lightBuffer, 64));
if (darkBuffer) {
  writeFileSync(join(root, "resources", "logo-dark.png"), await png(darkBuffer, 512));
  writeFileSync(join(root, "resources", "favicon-dark.png"), await png(darkBuffer, 64));
  writeFileSync(join(root, "dashboard", "logo-dark.png"), await png(darkBuffer, 512));
  writeFileSync(join(root, "dashboard", "favicon-dark.png"), await png(darkBuffer, 64));
}

// ICO from the light variant (shortcuts + tray), PNG-compressed entries.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const size of sizes) images.push({ size, data: await png(lightBuffer, size) });
const headerSize = 6 + images.length * 16;
let offset = headerSize;
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  header.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
  header.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
  header.writeUInt8(0, entry + 2);
  header.writeUInt8(0, entry + 3);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.data.length;
});
writeFileSync(join(root, "resources", "logo.ico"), Buffer.concat([header, ...images.map((image) => image.data)]));

console.log(`light: ${light.source} (white=${light.removeWhite}, black=${light.removeBlack}, plate=${light.plate})`);
if (dark.source) console.log(`dark:  ${dark.source} (white=${dark.removeWhite}, black=${dark.removeBlack}, plate=${dark.plate})`);
console.log("wrote resources/logo.png, resources/logo.ico" + (darkBuffer ? ", resources/logo-dark.png" : "") + ", favicons, and dashboard copies");
