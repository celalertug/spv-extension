# Chrome Web Store listing

Texts and answers for the developer dashboard. Upload `dist/startag-<version>.zip` (`npm run package`).

## Store listing tab

- **Name** (from the manifest): StarTag – Texas SPV for Marketplace
- **Summary** (manifest `description`, max 132): See what Facebook Marketplace cars actually sell
  for in Texas (TxDMV SPV), right next to the asking price.
- **Category**: Shopping
- **Language**: English (United States)
- **Icon**: `assets/icon-128.png` (96 px artwork, 16 px transparent padding)
- **Screenshots** (1280×800, `node tools/screenshots.mjs`), in this order: `store/screenshot-1-card.png`,
  `store/screenshot-2-variants.png`, `store/screenshot-3-notice.png` (the first one is the listing's
  cover, so it shows a value, not the notice). They are taken on a real listing (a 2017 Mercedes-Benz
  GLC 300 with a daylight exterior photo), logged out, with Facebook's login prompts hidden; check them
  for anything that identifies the seller (names, readable plates) before uploading.
- **Small promo tile** (440×280, `npm run build:brand`): `store/promo-440x280.png`
- **Marquee** (1400×560): none (only needed to be featured)
- **Official URL**: none (needs a site verified in Google Search Console)
- **Homepage URL**: https://celalertug.github.io/startag/ (GitHub Pages of the public repository
  [celalertug/startag](https://github.com/celalertug/startag), a single static page)
- **Support URL**: https://github.com/celalertug/startag/issues

### Description

```
Is that Marketplace price fair? The asking price is what the seller wants. StarTag shows what cars like it actually sell for in Texas, in a small card next to the listing.

The number is the state's own: the TxDMV Standard Presumptive Value (SPV), built from Texas sales, not from listings, and updated weekly.

• The SPV of the listing's vehicle, and how far the asking price is above or below it.
• The model and engine of the VIN the value is for.
• Listings without a VIN get an estimate from their year, make, model and text, with a confidence level. Type the VIN on the card for an exact value.
• Similar variants of the model (drive, engine, trim) and their values, on request; click one to use it.
• Mileage is taken into account for recent model years.

How it works
SPV values come from the TxDMV Standard Presumptive Value calculator (tools.txdmv.gov). For each listing you open, StarTag sends TxDMV a VIN and the listing's mileage, nothing else. It asks before the first lookup. StarTag has no server, no account and no tracking; results are kept in your browser so a vehicle is not looked up twice.

Values are for information only; TxDMV's own calculator is the authoritative source.

StarTag is not affiliated with, endorsed by or sponsored by the Texas Department of Motor Vehicles or Meta Platforms, Inc. Facebook and Marketplace are trademarks of Meta Platforms, Inc.

Vehicle data: NHTSA vPIC and NHTSA consumer complaints (public domain), via @cardog/corgi (ISC License).
```

## Privacy practices tab

- **Single purpose**: Show the Texas Standard Presumptive Value (SPV) of the vehicle in the Facebook
  Marketplace listing the user is viewing.
- **Permission justifications**:
  - `storage`: Keeps TxDMV answers per VIN pattern (values 7 days, "not found" 30 days) so a
    vehicle is not looked up twice, the variant the user picked or the VIN they typed for a
    listing, and the user's OK on the first-run notice. Stored locally only.
  - Host permission `https://tools.txdmv.gov/*`: Looks up the SPV of a VIN and mileage with the
    TxDMV SPV calculator (tools.txdmv.gov/tools/SPV/spv_lookup.php), the only server the extension
    contacts.
  - Content scripts on `https://www.facebook.com/*`: Read the Marketplace listing the user is viewing
    (year, make, model, mileage, price, VIN) and show the value card on it. Facebook is a single-page
    app, so the scripts run on all its pages and act only on `/marketplace/item/` pages; a script in
    the page context reads the listing data Facebook loads when a listing is opened from the feed.
- **Remote code**: No, I am not using remote code. All JavaScript is in the package; no script,
  `eval` or WebAssembly is loaded from elsewhere.
- **Data usage** (what is collected):
  - [x] Website content: the listing's VIN and mileage are sent to TxDMV to look up the value.
  - All other categories unchecked (personally identifiable information, health, financial and
    payment, authentication, personal communications, location, web history, user activity).
- **Certifications** (all three checked):
  - I do not sell or transfer user data to third parties, outside of the approved use cases.
  - I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
  - I do not use or transfer user data to determine creditworthiness or for lending purposes.
- **Privacy policy URL**: https://gist.github.com/celalertug/ff7214f00de40b35398c74f154c5055e (a secret gist with `store/PRIVACY.md`;
  update both together).

## Distribution tab

- **Visibility**: Public
- **Regions**: United States (the values are Texas-specific)
- **Pricing**: Free

## Reviewer notes (Test instructions tab)

```
No login or account is needed. Open a Facebook Marketplace vehicle listing, e.g. search Marketplace for "Toyota Camry" near any Texas city and open a listing (works logged out too). The StarTag card appears at the top right; click "OK, show values" on the first-run notice. The card then shows the TxDMV SPV. "Show similar variants" asks TxDMV for other variants; "Have the VIN?" takes a typed VIN (e.g. 1HGCM82633A004352).
```
