// Runs the resolver against the live TxDMV SPV service with FB-shaped listings.
// Usage: node test/estimate.test.mjs [filter]
import { readFile } from 'node:fs/promises';
import { estimate, checkDigit, isValidVin, findVinInText, parseSpvHtml, yearChar } from '../src/resolver.js';

const root = new URL('../data/', import.meta.url);
const makes = JSON.parse(await readFile(new URL('makes.json', root), 'utf8'));
const loadIndex = async (k) => JSON.parse(await readFile(new URL(`index/${k}.json`, root), 'utf8'));
let seedFills = {};
try { seedFills = JSON.parse(await readFile(new URL('fills.json', root), 'utf8')); } catch {}
const store = new Map();
const cache = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };

let failed = 0;
const assert = (cond, msg) => { if (!cond) { failed++; console.log('  FAIL', msg); } };

// Unit checks
assert(checkDigit('1HGCM82633A004352') === '3', 'check digit of a known VIN');
assert(isValidVin('1HGCM82633A004352') && !isValidVin('1HGCM82603A004352'), 'isValidVin');
assert(yearChar(2013) === 'D' && yearChar(2003) === '3' && yearChar(2000) === 'Y' && yearChar(2024) === 'R', 'year codes');
assert(findVinInText('Clean title. VIN: 1HGCM82633A004352 call 5125551234') === '1HGCM82633A004352', 'VIN in text');
assert(findVinInText('call me 12345678901234567') === null, 'no false VIN');
assert(parseSpvHtml('<td>Error: Your VIN "X" was not found. </td>').ok === false, 'SPV error parse');

const cases = [
  { name: 'Mercedes CLS 400 free-text model (screenshot)', l: { year: 2016, make: 'Mercedes-Benz', model: '2016 mercedes cls 400 twin turbo', trim: '4 doors', title: '2016 Mercedes-Benz 2016 mercedes cls 400 twin turbo · 4 doors', mileage: 90000 }, expect: { model: /CLS/ } },
  { name: 'Ford F-350SD free text', l: { year: 2023, make: 'Ford', model: 'F-350SD Lariat', trim: '', title: '2023 Ford F-350SD Lariat 62669 Miles', mileage: 62669 }, expect: { model: /F-?350|F350|Super Duty/i } },
  { name: 'Nissan Pathfinder typo', l: { year: 2015, make: 'Nissan', model: 'pathfander', trim: '', title: '2015 Nissan pathfander', mileage: 150000 }, expect: { model: /Pathfinder/i } },
  { name: 'Toyota Camry no trim (not hybrid)', l: { year: 2016, make: 'Toyota', model: 'Camry', trim: '', title: '2016 Toyota Camry', mileage: 77000 }, expect: { model: /Camry/ } },
  { name: 'Chevrolet 1500 Extended Cab', l: { year: 2011, make: 'Chevrolet', model: '1500 Extended Cab', trim: 'Long Bed', title: '2011 Chevrolet 1500 Extended Cab · Long Bed', mileage: 180000 }, expect: { model: /Silverado/ } },
  { name: 'Honda VTX motorcycle', l: { year: 2008, make: 'Honda', model: 'VTX', trim: '', title: '2008 Honda VTX', mileage: 12000 }, expect: {} },
  { name: 'Pre-1981 car', l: { year: 1972, make: 'Chevrolet', model: 'Monte Carlo', trim: 'LS Coupe 2D', title: '1972 Chevrolet Monte Carlo · LS Coupe 2D' }, expect: { error: /1981/ } },
  { name: 'Lexus GS 350 (recorded listing, no VIN)', l: { year: 2013, make: 'Lexus', model: 'GS', trim: 'GS 350 Sedan 4D', title: '2013 Lexus GS · GS 350 Sedan 4D', mileage: 196000 }, expect: { model: /GS 350/, value: 7400 } },
  { name: 'VIN in description', l: { year: 2003, make: 'Honda', model: 'Accord', trim: 'EX', title: '2003 Honda Accord', mileage: 120000, description: 'runs great vin 1HGCM82633A004352' }, expect: { source: 'description', value: 1550 } },
  { name: 'VIN in listing field', l: { year: 2003, make: 'Honda', model: 'Accord', trim: '', title: '2003 Honda Accord', mileage: 120000, vin: '1HGCM82633A004352' }, expect: { source: 'listing', value: 1550 } },
  { name: 'Honda Accord 2015 LX', l: { year: 2015, make: 'Honda', model: 'Accord', trim: 'LX Sedan 4D', title: '2015 Honda Accord · LX Sedan 4D', mileage: 110000 }, expect: { model: /Accord/ } },
  { name: 'Toyota Camry 2018 SE', l: { year: 2018, make: 'Toyota', model: 'Camry', trim: 'SE Sedan 4D', title: '2018 Toyota Camry · SE Sedan 4D', mileage: 80000 }, expect: { model: /Camry/ } },
  { name: 'Ford F-150 2016 XLT 4WD', l: { year: 2016, make: 'Ford', model: 'F150 SuperCrew Cab', trim: 'XLT Pickup 4D 5 1/2 ft', title: '2016 Ford F150 SuperCrew Cab · XLT Pickup 4D 5 1/2 ft', mileage: 140000 }, expect: { model: /F-?150/ } },
  { name: 'BMW 3 Series 2014 328i', l: { year: 2014, make: 'BMW', model: '3 Series', trim: '328i Sedan 4D', title: '2014 BMW 3 Series · 328i Sedan 4D', mileage: 90000 }, expect: { model: /328|3/ } },
  { name: 'Chevrolet Silverado 1500 2017', l: { year: 2017, make: 'Chevrolet', model: 'Silverado 1500 Crew Cab', trim: 'LT Pickup 4D 5 3/4 ft', title: '2017 Chevrolet Silverado 1500 Crew Cab · LT Pickup 4D 5 3/4 ft', mileage: 120000 }, expect: { model: /Silverado/ } },
  { name: 'Mercedes-Benz E-Class 2015', l: { year: 2015, make: 'Mercedes-Benz', model: 'E-Class', trim: 'E 350 Sedan 4D', title: '2015 Mercedes-Benz E-Class · E 350 Sedan 4D', mileage: 95000 }, expect: { model: /E/ } },
  { name: 'Tesla Model 3 2020', l: { year: 2020, make: 'Tesla', model: 'Model 3', trim: 'Standard Range Plus Sedan 4D', title: '2020 Tesla Model 3 · Standard Range Plus Sedan 4D', mileage: 50000 }, expect: { model: /3/ } },
  { name: 'Nissan Altima 2012', l: { year: 2012, make: 'Nissan', model: 'Altima', trim: '2.5 S Sedan 4D', title: '2012 Nissan Altima · 2.5 S Sedan 4D', mileage: 150000 }, expect: { model: /Altima/ } },
];

const filter = process.argv[2];
for (const c of cases.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()))) {
  const t0 = Date.now();
  const r = await estimate(c.l, { makes, loadIndex, cache, seedFills });
  const ms = Date.now() - t0;
  const line = r.ok
    ? `${r.source}/${r.confidence} ${r.vin} -> ${r.spv.year} ${r.spv.make} ${r.spv.model} ${r.spv.valueText} [${r.label || ''}] q=${r.queries} ${ms}ms` +
      (r.alternatives?.length ? `\n      alts: ${r.alternatives.map((a) => `${a.model} $${a.value} [${a.label}]`).join('; ')}` : '')
    : `ERROR ${r.error} q=${r.queries ?? '-'} ${ms}ms`;
  console.log(`${c.name}: ${line}`);
  if (c.expect.error) { assert(!r.ok && c.expect.error.test(r.error), `${c.name} error`); continue; }
  assert(r.ok, `${c.name} resolved`);
  if (r.ok && c.expect.model) assert(c.expect.model.test(r.spv.model), `${c.name} model ${r.spv.model}`);
  if (r.ok && c.expect.value) assert(r.spv.value === c.expect.value, `${c.name} value ${r.spv.value}`);
  if (r.ok && c.expect.source) assert(r.source === c.expect.source, `${c.name} source ${r.source}`);
}
// SPV adjusts recent model years for mileage: the same listing text at another mileage reuses the
// cached VIN but asks SPV again for the main value and the variants.
if (!filter || 'mileage'.includes(filter.toLowerCase())) {
  const l = { year: 2017, make: 'Chevrolet', model: 'Silverado 1500 Crew Cab', trim: 'LT Pickup 4D 5 3/4 ft', title: '2017 Chevrolet Silverado 1500 Crew Cab · LT Pickup 4D 5 3/4 ft' };
  const low = await estimate({ ...l, mileage: 20000 }, { makes, loadIndex, cache, seedFills });
  const high = await estimate({ ...l, mileage: 220000 }, { makes, loadIndex, cache, seedFills });
  const alt = (r) => (r.alternatives || []).map((a) => a.value).join(',');
  console.log(`Mileage: 20k ${low.spv?.valueText} [${alt(low)}] -> 220k ${high.spv?.valueText} [${alt(high)}] cached=${!!high.cached} q=${high.queries}`);
  assert(low.ok && high.ok && high.cached, 'mileage: both resolved, second from cache');
  assert(high.spv.value < low.spv.value, 'mileage: higher mileage, lower SPV');
  assert(!low.alternatives.length || alt(low) !== alt(high), 'mileage: variant values re-priced');
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
