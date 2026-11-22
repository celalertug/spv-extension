# StarTag privacy policy

Effective November 21, 2026.

StarTag is a Chrome extension that shows the Texas Standard Presumptive Value (SPV) of the vehicle
on a Facebook Marketplace listing page. It has no server of its own, no accounts, no analytics and
no ads.

## What StarTag reads

On facebook.com, StarTag reads the Marketplace vehicle listing you open: year, make, model, trim,
mileage, price, VIN and the seller's description, from the page and from the data Facebook loads
for it. Other Facebook content (your profile, messages, friends, other pages) is ignored.

## What StarTag sends, and to whom

To look up the SPV, StarTag sends the TxDMV SPV calculator (https://tools.txdmv.gov) a VIN and a
mileage, and nothing else:

- **VIN**: the one in the listing or its description, or one you type on the card. When the
  listing has none, StarTag sends VINs it builds from the listing's year, make and model (they
  match the model, not the vehicle for sale).
- **Mileage**: the listing's odometer reading.

The listing's price, photos, description and seller, and anything about you or your Facebook
account, are never sent anywhere. Like any website, TxDMV receives your IP address and browser
details with each request; its own policies apply (https://www.txdmv.gov/site-policies).

StarTag explains this on its card before the first lookup and sends nothing to TxDMV until you
click OK there.

## What StarTag stores

In your browser only (`chrome.storage`), never sent anywhere:

- SPV answers, by VIN pattern (VIN characters 1-8 and 10), so the same vehicle is not looked up
  twice: values for 7 days, "not found" answers for 30 days.
- For a year, make, model and trim: the VIN the estimate settled on and its similar variants, and
  VINs seen on listings of it, so the next listing of the same vehicle is answered at once.
- For a listing where you typed a VIN or picked a variant: the listing's number and that VIN.
- The VIN characters TxDMV accepted per manufacturer code, which make later estimates faster.
- That you clicked OK on the notice.

In facebook.com's local storage: the card's position on the screen and whether it is collapsed.

Removing the extension deletes everything it stored in `chrome.storage`.

## What StarTag does not do

StarTag does not sell or transfer user data to anyone, does not use it for advertising,
creditworthiness or lending, and does not let people read it. Its only use of the data is showing
the SPV of the listing you are viewing. The use of information received from Facebook pages
adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Not affiliated

StarTag is not affiliated with, endorsed by or sponsored by the Texas Department of Motor Vehicles
or Meta Platforms, Inc. SPV values come from TxDMV's calculator; TxDMV's own calculator
(https://www.txdmv.gov/standard-presumptive-calculator) is the authoritative source.

## Changes and contact

Changes to this policy are published at this address with a new effective date. Questions: use
the contact email shown on StarTag's Chrome Web Store page.
