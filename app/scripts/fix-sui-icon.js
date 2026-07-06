// @kunalabs-io/sui-snap-wallet ships raw TS source at src/icon.ts. Next.js's
// app-router build treats ANY resolved file literally named icon.* as a
// static-metadata route (matched on filename only, not directory — see
// next/dist/lib/metadata/is-metadata-route.js), which breaks "yarn build"
// with a parse error / "Default export is missing". The compiled dist that
// our package actually resolves to (via the alias in next.config.js) already
// inlines this file's contents, so nothing needs it to exist under that name.
// Runs postinstall (both locally and on Vercel, since a fresh install wipes
// this rename) to dodge Next's filename convention instead of the file's path.
const fs = require("fs");
const path = require("path");

const src = path.join(
  __dirname, "..", "node_modules", "@kunalabs-io", "sui-snap-wallet", "src", "icon.ts",
);
const dest = path.join(path.dirname(src), "_icon.ts");

if (fs.existsSync(src)) {
  fs.renameSync(src, dest);
  console.log("[fix-sui-icon] renamed sui-snap-wallet src/icon.ts -> _icon.ts");
}
