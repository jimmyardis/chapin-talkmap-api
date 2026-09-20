/* ============================================================
   TownRing Voice Tool API — multi-city
   ------------------------------------------------------------
   Serves all Vapi tool calls for every TownRing city.
   One endpoint, one Railway service, N cities.

   Tools:
     get_place_info            — county, place, or tract lookup
     get_tract_population_history — annual ACS pop for one tract
     rank_tracts               — fastest-growing, declining, etc.
     get_county_data           — county-level annual pop totals
     aggregate_tracts          — weighted metric over an area

   Cities loaded at startup (skipped gracefully if files missing):
     chapin      → chapin-area-{tracts,places,summary}
     charleston  → charleston-area-{tracts,places,summary}
     columbia    → columbia-area-{tracts,places,summary}

   Tool calls auto-detect the right city dataset by matching
   the requested place name against each city's data.
   Pass an explicit city param to skip auto-detect.
   ============================================================ */

const express = require('express');
const { lookupPlace } = require('./place-lookup.cjs');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

// =============================================================
// Load all city data at startup
// =============================================================
const DATA_DIR = path.join(__dirname, 'data');

function loadCity(slug) {
  try {
    const tracts  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${slug}-area-tracts.geojson`),  'utf-8'));
    const places  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${slug}-places.geojson`),       'utf-8'));
    const summary = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${slug}-area-summary.json`),    'utf-8'));
    console.log(`✅ ${slug}: ${tracts.features.length} tracts, ${places.features.length} places`);
    return { slug, tracts, places, summary };
  } catch (e) {
    console.warn(`⚠️  ${slug}: could not load — ${e.message}`);
    return null;
  }
}

const COLLOQUIAL_ALL = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'colloquial.json'), 'utf-8')); }
  catch (e) { console.warn('⚠️  colloquial.json missing —', e.message); return {}; }
})();

const CITIES = {
  chapin:     loadCity('chapin'),
  charleston: loadCity('charleston'),
  columbia:   loadCity('columbia'),
  sumter:     loadCity('sumter'),
};

// Search priority: broadest metro first, then the scoped towns. Chapin sits
// inside the Columbia metro, so it must come after Columbia.
const CITY_ORDER = ['charleston', 'columbia', 'sumter', 'chapin'];

// The 10 Vapi tools are shared by all four assistants, so a tool call arrives
// with no idea which map the caller is looking at. Without a hint the tools
// fall back to searching every city in CITY_ORDER, which is how a Charleston
// caller once got Chapin's numbers. The assistant id is the one thing Vapi
// always sends that identifies the city, so resolve from that rather than
// trusting the model to pass a `city` argument it could forget.
const ASSISTANT_CITY = {
  'ac689a99-081e-4f4e-8d80-746e6d7daa6a': 'chapin',
  'bdc929fb-5dbb-43ee-84f6-8f51b26c85b9': 'charleston',
  'eed4637f-c1f2-47f0-a896-f93c38532f1b': 'columbia',
  'e569e4e4-4cb2-4806-a1aa-9888d2381318': 'sumter',
};

// Vapi has moved this field around between payload shapes; check every place
// it has been known to appear, then fall back to ?city= on the server URL.
function resolveCityHint(message, query) {
  const id = message?.assistant?.id
          || message?.call?.assistantId
          || message?.call?.assistant?.id
          || message?.assistantId;
  return ASSISTANT_CITY[id] || query?.city || null;
}

// City-specific contextual notes
const CITY_NOTES = {
  chapin: {
    lexington:  'Most of Chapin proper is in Lexington County.',
    richland:   'White Rock and the eastern Greater Chapin area are in Richland County.',
    area_label: 'Greater Chapin area',
    // Every tract in this build is already clipped to 20 km of Chapin by
    // execution/scope_city.py, so all of them are in the greater area.
    area_flag:  f => true,
  },
  charleston: {
    charleston: 'City of Charleston is in Charleston County.',
    berkeley:   'North Charleston and Goose Creek are primarily in Berkeley County.',
    dorchester: 'Summerville and Ladson are in Dorchester County.',
    area_label: 'Greater Charleston tri-county area',
    area_flag:  f => true,  // all tracts are greater charleston
  },
  columbia: {
    richland:   'Columbia is the seat of Richland County, the state capital of South Carolina.',
    lexington:  'Lexington County covers the western half of the Columbia metro, including Irmo, Lexington and West Columbia.',
    area_label: 'Richland + Lexington / Columbia metro',
    area_flag:  f => true,
  },
  sumter: {
    sumter:     'Sumter is the seat of Sumter County. Shaw Air Force Base sits northwest of the city.',
    area_label: 'Sumter County',
    area_flag:  f => true,
  },
};

// =============================================================
// Helpers
// =============================================================

function popWeighted(tractFeatures, prop) {
  const totalPop = tractFeatures.reduce((a, f) => a + (Number(f.properties.pop_2020) || 0), 0);
  const samples = tractFeatures
    .map(f => ({ value: Number(f.properties[prop]), pop: Number(f.properties.pop_2020) || 0 }))
    .filter(s => !isNaN(s.value) && s.pop > 0);
  if (samples.length === 0 || totalPop === 0) return null;
  const popUsed = samples.reduce((a, b) => a + b.pop, 0);
  return Math.round(samples.reduce((a, b) => a + b.value * b.pop, 0) / popUsed * 100) / 100;
}

function areaAggregates(tractFeatures, areaLabel) {
  if (!tractFeatures?.length) return { error: `No tracts in ${areaLabel}.` };
  const totalPop = tractFeatures.reduce((a, f) => a + (Number(f.properties.pop_2020) || 0), 0);
  return {
    area: areaLabel,
    tract_count: tractFeatures.length,
    total_population_2020: totalPop,
    median_household_income_USD: popWeighted(tractFeatures, 'median_income'),
    median_age_years:            popWeighted(tractFeatures, 'median_age'),
    population_density_per_sqkm: popWeighted(tractFeatures, 'density_per_sqkm'),
    pct_non_white:               popWeighted(tractFeatures, 'pct_nonwhite'),
  };
}

// Find which city dataset a name belongs to — returns { city, data } or null.
function detectCity(name, hint) {
  const n = String(name || '').toLowerCase().trim();

  // Explicit hint beats auto-detect
  if (hint) {
    const h = String(hint).toLowerCase().trim();
    const match = Object.values(CITIES).find(c => c && (c.slug === h || c.summary?.city?.toLowerCase().includes(h)));
    if (match) return match;
  }

  const order = [...CITY_ORDER];

  for (const slug of order) {
    const city = CITIES[slug];
    if (!city) continue;

    // County match
    for (const county of Object.keys(city.summary.county_population_by_year || {})) {
      if (n.includes(county.toLowerCase())) return city;
    }

    // Place match
    if (city.places.features.some(f => {
      const dn = String(f.properties.display_name || '').toLowerCase();
      const bn = String(f.properties.BASENAME || '').toLowerCase();
      return dn.includes(n) || (bn && (n.includes(bn) || bn.includes(n)));
    })) return city;

    // City name match
    if (city.summary.city && city.summary.city.toLowerCase().includes(n)) return city;
    if (city.slug.includes(n) || n.includes(city.slug)) return city;
  }

  return null;
}

// =============================================================
// TOOL IMPLEMENTATIONS
// =============================================================
// Places carry Census place-level population (execution/enrich_places.py).
// Before that they held only a name and a boundary, so "population of Chapin
// town" came back with no number at all.
function placeResult(place, summary) {
  const p = place.properties;
  const out = {
    name: p.display_name,
    city: summary.city,
    type: p.kind,
    notes: p.tooltip,
  };
  if (p.pop_2020_dec != null) out.population_2020 = p.pop_2020_dec;
  if (p.pop_2010_dec != null) out.population_2010 = p.pop_2010_dec;
  if (p.growth_pct_2010_2020 != null) out.growth_pct_2010_2020 = p.growth_pct_2010_2020;

  const history = {};
  for (let y = 2014; y <= 2024; y++) {
    if (p[`pop_${y}`] != null) history[y] = p[`pop_${y}`];
  }
  if (Object.keys(history).length) {
    out.population_by_year = history;
    out.population_latest = history[2024] ?? history[Math.max(...Object.keys(history).map(Number))];
    out.population_note = 'Decennial counts are exact; the yearly series is ACS 5-year and will not match them exactly.';
  }
  if (out.population_2020 == null && out.population_latest == null) {
    out.has_own_population = false;
    out.note = 'No census population is published for this place.';
  }
  return out;
}

function mapAreaResult(summary) {
  return {
    name: `Greater ${summary.city}`,
    type: 'map_area',
    description: `The ${summary.total_tracts} census tracts this map covers`,
    state: 'SC',
    counties: summary.counties,
    total_population_2020: summary.pop_2020,
    total_population_2010: summary.pop_2010,
    growth_pct_2010_2020: summary.growth_pct_2010_2020,
    total_tracts: summary.total_tracts,
    growth_basis: summary.growth_basis || null,
  };
}

// Local names people actually use that have no census geography behind them.
const COLLOQUIAL = {
  chapin: {
    'white rock':      { name: 'White Rock', note: 'An unincorporated community in Richland County on the north shore of Lake Murray, inside the Greater Chapin area.' },
    'ballentine':      { name: 'Ballentine', note: 'An unincorporated community between Chapin and Irmo, in Richland County.' },
    'lake murray':     { name: 'Lake Murray', note: 'A 50,000-acre reservoir on the Saluda River, the defining feature of the Chapin area. It is water, so it has no population.' },
    'lake murray dam': { name: 'Lake Murray Dam', note: 'Also called the Saluda Dam, at the lake’s eastern end near Irmo.' },
    'dutch fork':      { name: 'Dutch Fork', note: 'The historic region between the Broad and Saluda Rivers, covering Chapin, Irmo and Ballentine.' },
  },
  columbia: {
    'five points':  { name: 'Five Points', note: 'An entertainment and shopping district just east of the USC campus.' },
    'the vista':    { name: 'The Vista', note: 'The Congaree Vista, a warehouse district turned restaurant and gallery quarter between downtown and the river.' },
    'vista':        { name: 'The Vista', note: 'The Congaree Vista, a warehouse district turned restaurant and gallery quarter between downtown and the river.' },
    'shandon':      { name: 'Shandon', note: 'An early-20th-century residential neighbourhood east of downtown.' },
    'fort jackson': { name: 'Fort Jackson', note: 'The US Army installation covering much of eastern Richland County; it is counted in the surrounding tracts.' },
    'usc':          { name: 'University of South Carolina', note: 'The main campus anchors downtown Columbia; students are counted in the surrounding tracts.' },
    'lake murray':  { name: 'Lake Murray', note: 'A reservoir on the Richland/Lexington line, northwest of the city. It is water, so it has no population.' },
  },
  charleston: {
    'west ashley':   { name: 'West Ashley', note: 'The part of the City of Charleston west of the Ashley River. It has no single census boundary.' },
    'the peninsula': { name: 'The Charleston peninsula', note: 'Downtown Charleston between the Ashley and Cooper Rivers.' },
    'peninsula':     { name: 'The Charleston peninsula', note: 'Downtown Charleston between the Ashley and Cooper Rivers.' },
    'the battery':   { name: 'The Battery', note: 'The promenade and historic district at the southern tip of the peninsula.' },
    'shem creek':    { name: 'Shem Creek', note: 'A working creek and restaurant strip in Mount Pleasant.' },
    'tri-county':    { name: 'The tri-county area', note: 'Charleston, Berkeley and Dorchester Counties together.' },
  },
  sumter: {
    'shaw':            { name: 'Shaw Air Force Base', note: 'Home of the 20th Fighter Wing, northwest of the city. Its personnel are counted in the surrounding tracts.' },
    'shaw afb':        { name: 'Shaw Air Force Base', note: 'Home of the 20th Fighter Wing, northwest of the city. Its personnel are counted in the surrounding tracts.' },
    'shaw air force base': { name: 'Shaw Air Force Base', note: 'Home of the 20th Fighter Wing, northwest of the city. Its personnel are counted in the surrounding tracts.' },
    'swan lake':       { name: 'Swan Lake Iris Gardens', note: 'A public garden in downtown Sumter, the only US public park hosting all eight swan species.' },
    'manchester':      { name: 'Manchester State Forest', note: 'State forest covering much of southern Sumter County.' },
    'manchester state forest': { name: 'Manchester State Forest', note: 'State forest covering much of southern Sumter County.' },
  },
};

const TOOLS = {

  get_place_info({ name, city: cityHint }) {
    // Same implementation the browser runs (shared/place-lookup.js in
    // the townring repo), so a phone call and a browser session cannot
    // give different answers to the same question.
    const targets = cityHint
      ? [detectCity(name, cityHint)].filter(Boolean)
      : CITY_ORDER.map(s => CITIES[s]).filter(Boolean);
    for (const c of targets) {
      const r = lookupPlace(name, {
        tracts: c.tracts, places: c.places, summary: c.summary,
        colloquial: COLLOQUIAL_ALL[c.slug] || {},
      }, c.slug);
      if (r && !r.error) return { ...r, city: c.summary.city };
    }
    return { error: `Couldn't find a place matching "${name}".`,
             suggestion: 'Try a town name, a county, or a census tract number.' };
  },

  get_tract_population_history({ tract, city: cityHint }) {
    if (!tract) return { error: 'Need a tract identifier.' };
    const digits = String(tract).replace(/\D/g, '');
    const citiesToSearch = cityHint
      ? [detectCity(tract, cityHint)].filter(Boolean)
      : CITY_ORDER.map(s => CITIES[s]).filter(Boolean);

    for (const { tracts, summary } of citiesToSearch) {
      const feat = tracts.features.find(f => digits && String(f.properties.TRACT || '').includes(digits));
      if (!feat) continue;
      const p = feat.properties;
      const history = {};
      for (let y = 2014; y <= 2022; y++) {
        if (p[`pop_${y}`] != null) history[y] = p[`pop_${y}`];
      }
      if (!Object.keys(history).length) return { error: `Tract ${tract} has no annual population data.` };
      const yrs = Object.keys(history).map(Number).sort();
      return {
        tract: p.NAME,
        city: summary.city,
        county: `${p.county_name} County, SC`,
        annual_population: history,
        change_pct: yrs.length > 1 && history[yrs[0]] > 0
          ? Math.round((history[yrs[yrs.length-1]] - history[yrs[0]]) / history[yrs[0]] * 1000) / 10 : null,
      };
    }
    return { error: `No tract found matching "${tract}".` };
  },

  rank_tracts({ direction = 'fastest_growing', count = 5, county = null, city: cityHint = null }) {
    const citiesToSearch = cityHint
      ? [detectCity('', cityHint)].filter(Boolean)
      : CITY_ORDER.map(s => CITIES[s]).filter(Boolean);

    const allResults = [];
    for (const { slug, tracts, summary } of citiesToSearch) {
      let pool = tracts.features.filter(f => f.properties.has_2010 === true);
      if (county) {
        const cn = String(county).toLowerCase();
        pool = pool.filter(f => String(f.properties.county_name || '').toLowerCase().includes(cn));
      }
      const cityLabel = summary.city || slug.charAt(0).toUpperCase() + slug.slice(1);
      pool.forEach(f => f._city = cityLabel);
      allResults.push(...pool);
    }

    const sorters = {
      fastest_growing:    (a, b) => (b.properties.growth_pct ?? 0) - (a.properties.growth_pct ?? 0),
      declining:          (a, b) => (a.properties.growth_pct ?? 0) - (b.properties.growth_pct ?? 0),
      most_populous_2020: (a, b) => (b.properties.pop_2020   ?? 0) - (a.properties.pop_2020   ?? 0),
    };
    const sorter = sorters[direction];
    if (!sorter) return { error: `Unknown direction "${direction}".` };

    allResults.sort(sorter);
    return {
      direction,
      count: Math.min(count, allResults.length),
      tracts: allResults.slice(0, count).map(f => ({
        name:           f.properties.NAME,
        tract_id:       f.properties.TRACT,
        city:           f._city,
        county:         f.properties.county_name,
        population_2010: f.properties.pop_2010,
        population_2020: f.properties.pop_2020,
        growth_pct:     f.properties.growth_pct,
      })),
    };
  },

  get_county_data({ county = 'all', year = null, city: cityHint = null }) {
    const citiesToSearch = cityHint
      ? [detectCity('', cityHint)].filter(Boolean)
      : CITY_ORDER.map(s => CITIES[s]).filter(Boolean);

    const result = {};
    for (const { summary } of citiesToSearch) {
      for (const [c, years] of Object.entries(summary.county_population_by_year || {})) {
        if (county === 'all' || c.toLowerCase().includes(String(county).toLowerCase())) {
          result[`${c} (${summary.city})`] = year ? { [year]: years[year] } : years;
        }
      }
    }
    return Object.keys(result).length === 0
      ? { error: `No county data for "${county}".` }
      : { years: result };
  },

  aggregate_tracts({ area, metric, operation = 'population_weighted_average', city: cityHint = null }) {
    if (!area)   return { error: 'Need an area name.' };
    if (!metric) return { error: 'Need a metric name (e.g. "median_income", "median_age").' };

    const a = String(area).toLowerCase().trim();
    const cityData = detectCity(area, cityHint);
    if (!cityData) return { error: `Unknown area "${area}". Try a city, county, or area name.` };

    const { slug, tracts, summary } = cityData;
    const notes = CITY_NOTES[slug] || {};

    let pool, areaLabel;
    // Try county match
    for (const county of Object.keys(summary.county_population_by_year || {})) {
      if (a.includes(county.toLowerCase())) {
        pool = tracts.features.filter(f => String(f.properties.county_name || '').toLowerCase() === county.toLowerCase());
        areaLabel = `${county} County, SC`;
        break;
      }
    }
    // Fall back to full city
    if (!pool) {
      pool = tracts.features;
      areaLabel = `${summary.city}, SC`;
    }

    if (!pool.length) return { error: `No tracts in area "${area}".` };

    const samples = pool
      .map(f => ({
        value: typeof f.properties[metric] === 'number' ? f.properties[metric] : parseFloat(f.properties[metric]) || null,
        population: Number(f.properties.pop_2020) || 0,
      }))
      .filter(s => s.value != null && !isNaN(s.value));

    if (!samples.length) return { error: `No data for metric "${metric}" in "${areaLabel}".` };

    const aggregators = {
      average: () => samples.reduce((a, b) => a + b.value, 0) / samples.length,
      sum:     () => samples.reduce((a, b) => a + b.value, 0),
      min:     () => Math.min(...samples.map(s => s.value)),
      max:     () => Math.max(...samples.map(s => s.value)),
      median:  () => {
        const sorted = [...samples.map(s => s.value)].sort((a, b) => a - b);
        const n = sorted.length;
        return n % 2 ? sorted[Math.floor(n / 2)] : (sorted[n/2-1] + sorted[n/2]) / 2;
      },
      population_weighted_average: () => {
        const totalPop = samples.reduce((a, b) => a + b.population, 0);
        if (!totalPop) return samples.reduce((a, b) => a + b.value, 0) / samples.length;
        return samples.reduce((a, b) => a + b.value * b.population, 0) / totalPop;
      },
    };

    const fn = aggregators[operation];
    if (!fn) return { error: `Unknown operation "${operation}". Try: ${Object.keys(aggregators).join(', ')}.` };

    return {
      area: areaLabel,
      city: summary.city,
      metric,
      operation,
      value: Math.round(fn() * 100) / 100,
      tracts_used: samples.length,
      total_population: pool.reduce((a, f) => a + (Number(f.properties.pop_2020) || 0), 0),
    };
  },
};

// =============================================================
// ROUTES
// =============================================================
app.get('/', (req, res) => {
  res.json({
    name: 'TownRing Voice API',
    status: 'ok',
    cities: Object.entries(CITIES)
      .filter(([, v]) => v)
      .map(([k, v]) => ({ slug: k, city: v.summary.city, tracts: v.tracts.features.length })),
    tools: Object.keys(TOOLS),
    endpoints: {
      'POST /api/vapi-tool': 'main Vapi tool endpoint',
      'GET  /api/test/:tool': 'e.g. /api/test/get_place_info?name=Charleston',
      'GET  /healthz': 'liveness probe',
    },
  });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/api/vapi-tool', (req, res) => {
  const message = req.body?.message;
  const toolCallList = message?.toolCallList || message?.tool_calls || [];

  if (!Array.isArray(toolCallList) || toolCallList.length === 0) {
    return res.status(400).json({ error: 'No tool calls in request body.', received: req.body });
  }

  const cityHint = resolveCityHint(message, req.query);
  console.log(`📍 city hint: ${cityHint || 'NONE (will search all cities)'}`);

  const results = toolCallList.map((call) => {
    const fnName  = call.function?.name      || call.name;
    const rawArgs = call.function?.arguments ?? call.arguments ?? '{}';
    let args;
    try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs; }
    catch { args = {}; }

    // Every data tool takes `city`; pin it to the calling assistant's map
    // unless the model deliberately asked about a different one.
    if (cityHint && args && args.city == null) args.city = cityHint;

    const fn = TOOLS[fnName];
    let result;
    if (!fn) {
      result = { error: `Unknown tool "${fnName}". Available: ${Object.keys(TOOLS).join(', ')}.` };
    } else {
      try { result = fn(args || {}); }
      catch (e) { result = { error: String(e?.message || e) }; }
    }

    console.log(`🔧 ${fnName}(${JSON.stringify(args)}) →`, JSON.stringify(result).slice(0, 200));

    return {
      toolCallId: call.id,
      result: typeof result === 'string' ? result : JSON.stringify(result),
    };
  });

  res.json({ results });
});

app.get('/api/test/:tool', (req, res) => {
  const fn = TOOLS[req.params.tool];
  if (!fn) return res.status(404).json({ error: `Unknown tool: ${req.params.tool}`, available: Object.keys(TOOLS) });
  const args = { ...req.query };
  for (const k of Object.keys(args)) {
    if (/^-?\d+$/.test(args[k])) args[k] = parseInt(args[k], 10);
  }
  try { res.json({ tool: req.params.tool, args, result: fn(args) }); }
  catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// =============================================================
// START
// =============================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 TownRing Voice API on port ${PORT}`);
});
