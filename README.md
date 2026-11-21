<p align="center"><img src="assets/banner.png" alt="StarTag: Texas SPV on every Marketplace car" width="720"></p>

# StarTag: Texas SPV for Marketplace

Chrome extension (MV3). Shows the TxDMV Standard Presumptive Value of the vehicle on a Facebook
Marketplace listing page in a card: SPV, listing price vs SPV and the SPV of similar variants of the
model (click one to use it). How the value was found, how sure the estimate is and the VIN it used
are in the tooltips.

Install: `chrome://extensions` → Developer mode → Load unpacked → this folder.

## How the VIN is chosen

SPV only takes a VIN (no year/make/model query) and only matches positions 1-8 and 10 (WMI, VDS,
model year); check digit, plant, serial and mileage do not change the value. So:

1. A VIN the user typed on the card for this listing ("Have the VIN?"), or a variant they picked.
2. `vehicle_identification_number` from the listing data.
3. A check-digit-valid VIN in the seller's description.
4. An earlier result for the same year/make/model/trim text, or a VIN seen on another listing of it.
5. An estimate (`src/match.js` + `src/resolver.js`):
   - **Listing text → variants.** Every vPIC variant of the year and make (model × series × trim ×
     engine × drive × fuel × body …, from `data/index/<make>.json`) is scored against the whole
     listing text: title, model, trim and description, free text included ("2016 mercedes cls 400 twin
     turbo", "F-350SD Lariat", typos like "pathfander"). Each variant carries its VIN region (allowed
     characters per position, minus excluded sub-regions).
   - **Real VIN prefixes.** `index.real` holds VIN positions 1-8 + 10 seen on real vehicles in NHTSA
     consumer complaints (64k prefixes, with counts). Each is scored like the best variant containing
     it; one no variant contains (vPIC is thin before ~2000) is scored on its NHTSA model name.
   - **Queue.** Real prefixes go first, common before rare (the counts settle what the text leaves
     open: 2.5L vs 3.5L Camry, 2WD vs 4WD trucks, diesel or not). Then VINs built from the variant
     patterns, with open positions filled by: characters SPV accepted before for that WMI (learned in
     `chrome.storage`), the shipped calibration (`data/fills.json`), the characters vPIC uses for that
     WMI around that year, then the rest. Queries run 3 at a time: up to 24 to find a match, 40 in all with the alternatives.
   - **Alternatives.** Up to 4 other likely variants with a different SPV value are listed on the card;
     clicking one makes it the value shown (remembered for the listing).
   - **Confidence.** high: the top-scoring variant, model and trim/engine named in the text; medium:
     the model matches; low: a guess between models.

Not covered: vehicles before 1981 (no 17-character VIN), and vehicles SPV does not have (some exotics
and models that did not exist that year).

## Files

- `src/hook.js`: page-world hook; forwards XHR/fetch responses with vehicle fields (opening a listing from the feed).
- `src/content.js`: reads the listing (forwarded responses, embedded JSON on a full load, page title as fallback), renders the card.
- `src/background.js`: service worker; runs the resolver, loads `data/`.
- `src/match.js`: listing-text parsing, variant scoring, VIN regions, real-prefix scoring.
- `src/resolver.js`: SPV client, candidate queue, caching.
- `tools/build_index.py`: builds `data/makes.json` and `data/index/` from `vpic.lite.db` (in the
  `@cardog/corgi` npm package, `dist/db/vpic.lite.db.gz`).
- `tools/build_real.py`: adds real VIN prefixes to `data/index/` from NHTSA's
  [FLAT_CMPL.zip](https://static.nhtsa.gov/odi/ffdd/cmpl/FLAT_CMPL.zip). Run after `build_index.py`.
- `assets/`: StarTag logo (`logo.svg`, `logo-small.svg` for 16-32 px), extension icons, README banner;
  `node tools/build_brand.mjs` regenerates them (navy `#0B2A4A`, red `#C8102E`, cream `#FFF8EC`).
- `tools/calibrate.mjs`: runs the resolver on a corpus of Marketplace titles against live SPV,
  reports the resolve rate and query counts, and merges the learned fill characters into `data/fills.json`.

Rebuild: `VPIC_DB=vpic.lite.db npm run build:index && NHTSA_CMPL=FLAT_CMPL.zip npm run build:real`.

## Tests

- `npm test`: resolver against the live SPV service (19 cases: free-text models, typos, trucks,
  motorcycles, VINs in listing/description, pre-1981).
- `npm run test:e2e`: loads the extension in Playwright Chromium with tabtape (recorded); replays the
  recorded listing-open response (card, collapse, drag, back), opens a Camry listing and picks another
  variant, an unknown model and a typed VIN, a non-vehicle item, and the real listing logged out.
  `test/fixtures/route-def.txt` is a recorded Facebook response from your session (gitignored).
- `node tools/calibrate.mjs corpus.json [limit] [maxQueries]`: evaluation on real titles.
