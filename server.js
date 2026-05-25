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

const CITIES = {
  chapin:     loadCity('chapin'),
  charleston: loadCity('charleston'),
  columbia:   loadCity('columbia'),
};

const CITY_ORDER = ['charleston', 'columbia', 'chapin'];   // search priority

// City-specific contextual notes
const CITY_NOTES = {
  chapin: {
    lexington:  'Most of Chapin proper is in Lexington County.',
    richland:   'White Rock and the eastern Greater Chapin area are in Richland County.',
    area_label: 'Greater Chapin area',
    area_flag:  f => f.properties.is_greater_chapin === true,
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
    area_label: 'Richland County / Columbia metro',
    area_flag:  f => f.properties.is_greater_area === true,
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
const TOOLS = {

  get_place_info({ name, year, city: cityHint }) {
    if (!name) return { error: 'Need a place name to look up.' };
    const n = String(name).toLowerCase().trim();
    const yearStr = year != null ? String(year) : null;

    // Try to find in a specific city first, then fall back to searching all
    const citiesToSearch = cityHint
      ? [detectCity(name, cityHint)].filter(Boolean)
      : CITY_ORDER.map(s => CITIES[s]).filter(Boolean);

    for (const cityData of citiesToSearch) {
      const { slug, tracts, places, summary } = cityData;
      const notes = CITY_NOTES[slug] || {};

      // 1. County match
      for (const [county, years] of Object.entries(summary.county_population_by_year || {})) {
        if (n.includes(county.toLowerCase())) {
          const countyTracts = tracts.features.filter(
            f => String(f.properties.county_name || '').toLowerCase() === county.toLowerCase()
          );
          return {
            name: `${county} County, SC`,
            city: summary.city,
            type: 'county',
            population_by_year: years,
            growth_pct_2010_2020: years[2010] && years[2020]
              ? Math.round((years[2020] - years[2010]) / years[2010] * 1000) / 10 : null,
            demographics: areaAggregates(countyTracts, `${county} County`),
            note: notes[county.toLowerCase()] || null,
          };
        }
      }

      // 2. Place match (city name exact)
      if (summary.city && summary.city.toLowerCase() === n) {
        return {
          name: summary.city,
          type: 'city',
          state: 'SC',
          county: summary.county,
          total_population_2020: summary.pop_2020,
          total_population_2010: summary.pop_2010,
          growth_pct_2010_2020: summary.growth_pct_2010_2020,
          total_tracts: summary.total_tracts,
        };
      }

      // 3. Places GeoJSON
      const place = places.features.find(f => {
        const dn = String(f.properties.display_name || '').toLowerCase();
        const bn = String(f.properties.BASENAME || '').toLowerCase();
        return dn.includes(n) || (bn && (n.includes(bn) || bn.includes(n)));
      });
      if (place) {
        const result = {
          name: place.properties.display_name,
          city: summary.city,
          type: place.properties.kind,
          notes: place.properties.tooltip,
        };
        return result;
      }

      // 4. Tract by number or name
      const digits = n.replace(/\D/g, '');
      const tract = tracts.features.find(f => {
        const t  = String(f.properties.TRACT || '');
        const tn = String(f.properties.NAME  || '').toLowerCase();
        return (digits && t.includes(digits)) || tn.includes(n);
      });
      if (tract) {
        const p = tract.properties;
        const result = {
          name: p.NAME,
          city: summary.city,
          type: 'census_tract',
          county: `${p.county_name} County, SC`,
          population_2010: p.pop_2010,
          population_2020: p.pop_2020,
          growth_pct_2010_to_2020: p.growth_pct,
          median_household_income: p.median_income,
          median_age: p.median_age,
          density_per_sqkm: p.density_per_sqkm,
        };
        if (yearStr && p[`pop_${yearStr}`] != null) result[`population_${yearStr}`] = p[`pop_${yearStr}`];
        const history = {};
        for (let y = 2014; y <= 2022; y++) {
          if (p[`pop_${y}`] != null) history[y] = p[`pop_${y}`];
        }
        if (Object.keys(history).length > 0) result.population_history = history;
        if (!p.has_2010) result.note = 'This tract did not exist in 2010 — created when a larger tract was split.';
        return result;
      }
    }

    return { error: `Couldn't find a place matching "${name}". Try a city name, county, or neighborhood.` };
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

  const results = toolCallList.map((call) => {
    const fnName  = call.function?.name      || call.name;
    const rawArgs = call.function?.arguments ?? call.arguments ?? '{}';
    let args;
    try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs; }
    catch { args = {}; }

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
