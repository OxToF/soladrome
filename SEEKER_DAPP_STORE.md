# Soladrome on the Solana Seeker / dApp Store — Runbook

Goal: ship Soladrome (the existing Next.js web dApp) as an installable **Android
app** on the **Solana dApp Store** (the Seeker's app store, no Google fees).

We take the pragmatic path: **wrap the deployed web app as a Trusted Web Activity
(TWA) → signed APK → publish**. No second codebase. The app's connect flow uses
the **Mobile Wallet Adapter** (already wired in `app/app/providers.tsx`), so on the
Seeker it connects natively to Seed Vault / Phantom / Solflare.

---

## 0. What's already done (in the repo)

- ✅ **PWA manifest** — `app/app/manifest.ts` → served at `/manifest.webmanifest`
  (name, icons, `display: standalone`, theme color).
- ✅ **App icons** — `app/public/icons/` (192, 512, maskable-512, apple-touch, favicon).
  ⚠️ These are a branded **placeholder** (green tile + "S"). Swap for the final logo
  before publishing — same filenames, keep 192/512 + a maskable variant.
- ✅ **Mobile Wallet Adapter** — `@solana-mobile/wallet-adapter-mobile`, branded
  `appIdentity` in `providers.tsx`.

## 0bis. Before you build — two things to set

1. **Confirm the production domain.** Everything below (TWA host, Digital Asset
   Links, MWA `appIdentity.uri`) must use the **exact** domain you publish under.
   - If it's `soladrome.finance` → nothing to change (it's the default).
   - Otherwise set `NEXT_PUBLIC_SITE_URL=https://<your-domain>` in Vercel **and**
     update `appIdentity.uri` in `providers.tsx`.
2. **Cluster.** `providers.tsx` pins MWA to `cluster: "devnet"`. Switch to
   `"mainnet-beta"` when you launch on mainnet.

---

## 1. Prerequisites (one-time, on your Mac)

```bash
# Node 18+ (you have it). Java JDK 17 + Android build tools are pulled by Bubblewrap.
brew install --cask temurin@17          # JDK 17 (skip if already installed)
npm i -g @bdragon28/bubblewrap || npm i -g @bubblewrap/cli   # TWA builder
npm i -g @solana-mobile/dapp-store-cli                       # dApp Store publishing
```

You also need a tiny bit of **SOL on mainnet** in a publishing keypair (the dApp
Store mints 3 NFTs — Publisher, App, Release — typically < 0.1 SOL total). The
store itself takes **no cut**.

---

## 2. Build the APK with Bubblewrap (TWA wrapper)

```bash
# 1. Initialise from the live manifest (use your real prod URL)
bubblewrap init --manifest=https://soladrome.finance/manifest.webmanifest

#    Prompts: package id (e.g. finance.soladrome.app), app name (Soladrome),
#    signing key (let it generate one — SAVE the keystore + passwords securely;
#    losing it means you can never update the app).

# 2. Build → produces app-release-signed.apk
bubblewrap build

# 3. Get the SHA-256 fingerprint of your signing key (needed for step 3)
bubblewrap fingerprint   # or: keytool -list -v -keystore ./android.keystore
```

> **PWABuilder alternative (no CLI):** go to https://www.pwabuilder.com, paste the
> prod URL, "Package for stores" → Android → it generates the same signed APK +
> the `assetlinks.json` for you. Easier if the CLI fights you.

---

## 3. Digital Asset Links (removes the browser URL bar)

A TWA only runs full-screen (no Chrome address bar) if the website proves it owns
the app. Host this at **`https://<your-domain>/.well-known/assetlinks.json`**:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "finance.soladrome.app",
    "sha256_cert_fingerprints": ["<SHA-256 from step 2>"]
  }
}]
```

In this Next.js app, the simplest host is a static file:
`app/public/.well-known/assetlinks.json` → deployed at the right path automatically.
Verify after deploy: `curl https://<your-domain>/.well-known/assetlinks.json`.

---

## 4. Publish to the Solana dApp Store

```bash
# In a clean publishing folder:
dapp-store init                 # creates config.yaml
```

Fill `config.yaml`:
- **publisher**: name, website, contact email (`info@soladrome.finance`).
- **app**: name, android package id (must match the APK), description.
- **release**: version, the signed `.apk` path, **media** (icon 512, feature
  graphic, ≥4 phone screenshots — use the responsive mobile views), short + long
  description, categories, privacy policy URL.

```bash
# Validate everything is present and the APK is well-formed
dapp-store validate -k <publishing-keypair.json> -b <android-build-tools-dir>

# Mint the on-chain NFTs (mainnet) — Publisher → App → Release
dapp-store create publisher -k <publishing-keypair.json>
dapp-store create app       -k <publishing-keypair.json>
dapp-store create release   -k <publishing-keypair.json> -b <android-build-tools-dir>

# Submit for review
dapp-store publish submit -k <publishing-keypair.json> \
  --requestor-is-authorized --complies-with-solana-dapp-store-policies
```

Review is usually a few days. Updates = bump version, rebuild APK, `create release`
again, `publish submit` again.

---

## 5. Recap of the moving parts

| Piece | Where | Status |
|---|---|---|
| PWA manifest | `app/app/manifest.ts` | ✅ done |
| Icons | `app/public/icons/` | ⚠️ placeholder — swap logo |
| Mobile Wallet Adapter | `app/app/providers.tsx` | ✅ done (cluster=devnet) |
| Prod domain / `NEXT_PUBLIC_SITE_URL` | Vercel env + `providers.tsx` | ⬜ confirm |
| Signed APK | Bubblewrap / PWABuilder | ⬜ build |
| `assetlinks.json` | `app/public/.well-known/` | ⬜ add after APK |
| dApp Store NFTs + submit | `dapp-store-cli` | ⬜ publish |

## Notes
- The Seeker runs Android, so Soladrome is **usable in its browser today** — the
  APK is only for **dApp Store distribution** (discoverability + no Google fees).
- iOS can't use the dApp Store; iPhone users "Add to Home Screen" via the PWA
  manifest (already supported).
- If traction justifies it later, a native **React Native + Expo + Solana Mobile
  SDK** app gives the deepest Seed Vault UX — but it's a second codebase to maintain.
