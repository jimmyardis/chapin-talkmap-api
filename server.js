/* ============================================================
   The Chapin Map — Voice Tool API
   ------------------------------------------------------------
   A small Express server that exposes three Vapi-callable
   tools backed by static GeoJSON data:
     - get_place_info
     - rank_tracts
     - get_county_data

   Vapi sends a POST to /api/vapi-tool with the tool call(s)
   in the body. We compute and return the results in the
   format Vapi expects. Same endpoint handles all 3 tools —
   we route by function.name.

   Local test:    npm install && npm start
   Deploy:        push to Railway / Render / fly.io / wherever
   ============================================================ */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));

// =============================================================
// Load data once at startup
// =============================================================
const dataDir = path.join(__dirname, 'data');
const tracts  = JSON.parse(fs.readFileSync(path.join(dataDir, 'chapin-area-tracts.geojson'), 'utf-8'));
const places  = JSON.parse(fs.readFileSync(path.join(dataDir, 'chapin-places.geojson'),       'utf-8'));
const summary = JSON.parse(fs.readFileSync(path.join(dataDir, 'chapin-area-summary.json'),    'utf-8'));

console.log(`📚 Loaded ${tracts.features.length} tracts, ${places.features.length} places, ${Object.keys(summary.county_population_by_year || {}).length} counties.`);

// Helper: compute population-weighted area aggregates for any list of tract features
// Returns demographics suitable for an LLM to weave into a conversation.
function computeAreaAggregates(tractFeatures, areaLabel) {
  if (!tractFeatures || tractFeatures.length === 0) {
    return { error: `No tracts in ${areaLabel}.` };
  }

  const totalPop = tractFeatures.reduce((a, b) => a + (Number(b.properties.pop_2020) || 0), 0);

  function popWeighted(prop) {
    const samples = tractFeatures
      .map(f => ({ value: Number(f.properties[prop]), pop: Number(f.properties.pop_2020) || 0 }))
      .filter(s => !isNaN(s.value) && s.pop > 0);
    if (samples.length === 0 || totalPop === 0) return null;
    const sum = samples.reduce((a, b) => a + b.value * b.pop, 0);
    const popUsed = samples.reduce((a, b) => a + b.pop, 0);
    return Math.round((sum / popUsed) * 100) / 100;
  }

  return {
    area: areaLabel,
    tract_count: tractFeatures.length,
    total_population_2020: totalPop,
    median_household_income_USD: popWeighted('median_income'),
    median_age_years: popWeighted('median_age'),
    population_density_per_sqkm: popWeighted('density_per_sqkm'),
    racial_composition: {
      pct_white_alone: popWeighted('pct_white'),
      pct_black_alone: popWeighted('pct_black'),
      pct_asian_alone: popWeighted('pct_asian'),
      pct_hispanic_origin: popWeighted('pct_hispanic'),
      pct_other_or_multiracial: popWeighted('pct_other'),
      pct_non_white: popWeighted('pct_nonwhite'),
    },
  };
}

// =============================================================
// TOOL IMPLEMENTATIONS
// =============================================================
const TOOLS = {
  /**
   * Look up info about any named place — town, CDP, ZIP, county, or tract.
   * Optional `year` parameter (2014-2022) returns historical population for tracts.
   */
  get_place_info({ name, year }) {
    if (!name) return { error: 'Need a place name to look up.' };
    const n = String(name).toLowerCase().trim();
    const yearStr = year != null ? String(year) : null;

    // 1. Counties
    if (summary.county_population_by_year) {
      for (const [county, years] of Object.entries(summary.county_population_by_year)) {
        if (n.includes(county.toLowerCase())) {
          const countyTracts = tracts.features.filter(
            f => String(f.properties.county_name || '').toLowerCase() === county.toLowerCase()
          );
          return {
            name: `${county} County, SC`,
            type: 'county',
            population_by_year: years,
            growth_2000_2020_pct: years[2000] && years[2020]
              ? Math.round((years[2020] - years[2000]) / years[2000] * 1000) / 10
              : null,
            demographics: computeAreaAggregates(countyTracts, `${county} County`),
            note: county === 'Lexington'
              ? 'Most of Chapin proper is in Lexington County.'
              : 'White Rock and the eastern Greater Chapin area are in Richland County.',
          };
        }
      }
    }

    // 2. Places (towns, CDPs, ZIP, colloquial)
    if (places.features) {
      const place = places.features.find(f => {
        const dn = String(f.properties.display_name || '').toLowerCase();
        const bn = String(f.properties.BASENAME || '').toLowerCase();
        return dn.includes(n) || (bn && (n.includes(bn) || bn.includes(n)));
      });
      if (place) {
        const result = {
          name: place.properties.display_name,
          type: place.properties.kind,
          notes: place.properties.tooltip,
        };

        // For ZIP 29036 / Chapin / Chapin-related, attach Greater Chapin aggregates
        const dn = String(place.properties.display_name || '').toLowerCase();
        const isChapinish = dn.includes('chapin') || dn.includes('29036') ||
                            n.includes('chapin') || n.includes('29036') ||
                            n.includes('white rock') || n.includes('ballentine');

        if (isChapinish) {
          const greaterChapin = tracts.features.filter(f => f.properties.is_greater_chapin === true);
          result.greater_chapin_aggregates = computeAreaAggregates(greaterChapin, 'Greater Chapin area');
        }
        return result;
      }
    }

    // 3. Tracts (by tract number or name)
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
        type: 'census_tract',
        county: `${p.county_name} County, SC`,
        population_2010: p.pop_2010,
        population_2020: p.pop_2020,
        growth_pct_2010_to_2020: p.growth_pct,
        median_household_income: p.median_income,
        median_age: p.median_age,
        density_per_sqkm: p.density_per_sqkm,
        is_greater_chapin: p.is_greater_chapin === true,
      };
      if (yearStr && p[`pop_${yearStr}`] != null) {
        result[`population_${yearStr}`] = p[`pop_${yearStr}`];
      }
      // Always include annual history if available
      const history = {};
      for (let y = 2014; y <= 2022; y++) {
        if (p[`pop_${y}`] != null) history[y] = p[`pop_${y}`];
      }
      if (Object.keys(history).length > 0) result.population_history = history;
      result.note = p.has_2010
        ? null
        : 'This tract did not exist in 2010 — created when an older tract was split (often a fast-growth area).';
      return result;
    }

    return { error: `Couldn't find a place matching "${name}".` };
  },

  /**
   * Get a tract's annual population history (2014-2022 ACS estimates).
   * Useful for the voice agent to answer trend questions.
   */
  get_tract_population_history({ tract }) {
    if (!tract) return { error: 'Need a tract identifier (e.g. "210.19" or "021019").' };
    const digits = String(tract).replace(/\D/g, '');
    const feat = tracts.features.find(f => {
      const t = String(f.properties.TRACT || '');
      return digits && t.includes(digits);
    });
    if (!feat) return { error: `No tract found matching "${tract}".` };

    const p = feat.properties;
    const history = {};
    for (let y = 2014; y <= 2022; y++) {
      if (p[`pop_${y}`] != null) history[y] = p[`pop_${y}`];
    }
    if (Object.keys(history).length === 0) {
      return { error: `Tract ${tract} has no annual population data.` };
    }
    const yrs = Object.keys(history).map(Number).sort();
    const first = history[yrs[0]];
    const last = history[yrs[yrs.length - 1]];
    return {
      tract: p.NAME,
      county: `${p.county_name} County, SC`,
      annual_population: history,
      change_first_to_last: last - first,
      change_pct: first > 0 ? Math.round((last - first) / first * 1000) / 10 : null,
      first_year: yrs[0],
      last_year: yrs[yrs.length - 1],
    };
  },

  /**
   * Find tracts ranked by a metric.
   * direction: 'fastest_growing' | 'declining' | 'most_populous_2020'
   */
  rank_tracts({ direction = 'fastest_growing', count = 5, county = null }) {
    let pool = tracts.features.filter(f => f.properties.has_2010 === true);
    if (county) {
      const cn = String(county).toLowerCase();
      pool = pool.filter(f => String(f.properties.county_name || '').toLowerCase().includes(cn));
    }

    const sorters = {
      fastest_growing:    (a, b) => (b.properties.growth_pct ?? 0) - (a.properties.growth_pct ?? 0),
      declining:          (a, b) => (a.properties.growth_pct ?? 0) - (b.properties.growth_pct ?? 0),
      most_populous_2020: (a, b) => (b.properties.pop_2020   ?? 0) - (a.properties.pop_2020   ?? 0),
    };
    const sorter = sorters[direction];
    if (!sorter) return { error: `Unknown direction "${direction}".` };

    pool.sort(sorter);

    return {
      direction,
      count: Math.min(count, pool.length),
      tracts: pool.slice(0, count).map(f => ({
        name: f.properties.NAME,
        tract_id: f.properties.TRACT,
        county: f.properties.county_name,
        population_2010: f.properties.pop_2010,
        population_2020: f.properties.pop_2020,
        growth_pct: f.properties.growth_pct,
      })),
    };
  },

  /**
   * County-level population totals.
   * county: 'Lexington' | 'Richland' | 'both'
   */
  get_county_data({ county = 'both', year = null }) {
    const yearsByCounty = summary.county_population_by_year || {};
    const result = {};
    const keys = county === 'both' ? Object.keys(yearsByCounty) : [county];

    for (const k of keys) {
      const matched = Object.keys(yearsByCounty).find(
        c => c.toLowerCase().includes(String(k).toLowerCase())
      );
      if (matched) {
        const data = yearsByCounty[matched];
        result[matched] = year ? { [year]: data[year] } : data;
      }
    }
    return Object.keys(result).length === 0
      ? { error: `No data for county "${county}".` }
      : { years: result };
  },

  /**
   * Aggregate any tract-level metric across a named area.
   *
   * area: 'Lexington' | 'Richland' | 'Greater Chapin' | 'ZIP 29036' | 'both'
   * metric: any tract property — 'median_income', 'median_age', 'pop_2020',
   *         'density_per_sqkm', 'pct_white', 'pct_black', 'pct_hispanic',
   *         'pct_nonwhite', 'growth_pct', etc.
   * operation: 'average' | 'median' | 'sum' | 'min' | 'max' | 'population_weighted_average'
   */
  aggregate_tracts({ area, metric, operation = 'population_weighted_average' }) {
    if (!area)   return { error: 'Need an area (e.g. "Lexington County", "Greater Chapin").' };
    if (!metric) return { error: 'Need a metric (e.g. "median_income", "median_age").' };

    const a = String(area).toLowerCase().trim();

    // Pick which tracts to aggregate over
    let pool, areaLabel;
    if (a.includes('greater chapin') || a.includes('29036') || a === 'chapin' || a === 'chapin area') {
      pool = tracts.features.filter(f => f.properties.is_greater_chapin === true);
      areaLabel = 'Greater Chapin (ZIP 29036 footprint)';
    } else if (a.includes('lexington')) {
      pool = tracts.features.filter(f => String(f.properties.county_name || '').toLowerCase() === 'lexington');
      areaLabel = 'Lexington County, SC';
    } else if (a.includes('richland')) {
      pool = tracts.features.filter(f => String(f.properties.county_name || '').toLowerCase() === 'richland');
      areaLabel = 'Richland County, SC';
    } else if (a === 'both' || a.includes('both counties')) {
      pool = tracts.features;
      areaLabel = 'Lexington + Richland Counties combined';
    } else {
      return {
        error: `Unknown area "${area}". Try: 'Lexington County', 'Richland County', 'Greater Chapin', 'ZIP 29036', or 'both'.`
      };
    }

    if (pool.length === 0) return { error: `No tracts in area "${area}".` };

    // Pull metric values + populations (for weighted ops)
    const samples = pool
      .map(f => ({
        value:      typeof f.properties[metric] === 'number' ? f.properties[metric] : (parseFloat(f.properties[metric]) || null),
        population: typeof f.properties.pop_2020 === 'number' ? f.properties.pop_2020 : 0,
      }))
      .filter(s => s.value != null && !isNaN(s.value));

    if (samples.length === 0) {
      return { error: `No data for metric "${metric}" in "${areaLabel}". Check the metric name.` };
    }

    // Aggregators
    const aggregators = {
      average: () => samples.reduce((a, b) => a + b.value, 0) / samples.length,
      sum:     () => samples.reduce((a, b) => a + b.value, 0),
      min:     () => Math.min(...samples.map(s => s.value)),
      max:     () => Math.max(...samples.map(s => s.value)),
      median:  () => {
        const sorted = samples.map(s => s.value).sort((a, b) => a - b);
        const n = sorted.length;
        return n % 2 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      },
      population_weighted_average: () => {
        const totalPop = samples.reduce((a, b) => a + b.population, 0);
        if (totalPop === 0) return samples.reduce((a, b) => a + b.value, 0) / samples.length;
        return samples.reduce((a, b) => a + b.value * b.population, 0) / totalPop;
      },
    };

    const fn = aggregators[operation];
    if (!fn) {
      return { error: `Unknown operation "${operation}". Try: ${Object.keys(aggregators).join(', ')}.` };
    }

    const raw = fn();
    const value = typeof raw === 'number' ? Math.round(raw * 100) / 100 : raw;

    return {
      area: areaLabel,
      metric,
      operation,
      value,
      tracts_used: samples.length,
      tracts_in_area: pool.length,
      total_population_in_area: pool.reduce((a, b) => a + (Number(b.properties.pop_2020) || 0), 0),
    };
  },
};

// =============================================================
// ROUTES
// =============================================================

// Health / index
app.get('/', (req, res) => {
  res.json({
    name: 'Chapin Map Voice API',
    status: 'ok',
    tools: Object.keys(TOOLS),
    endpoints: {
      'POST /api/vapi-tool': 'main endpoint Vapi calls when the agent invokes a tool',
      'GET /api/test/:tool': 'direct test of a tool, e.g. /api/test/get_place_info?name=Chapin',
      'GET /healthz': 'liveness probe',
    },
  });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Main Vapi endpoint — handles all three tools
app.post('/api/vapi-tool', (req, res) => {
  console.log('\n→ Tool call request:', JSON.stringify(req.body, null, 2));

  const message = req.body?.message;
  const toolCallList = message?.toolCallList || message?.tool_calls || [];

  if (!Array.isArray(toolCallList) || toolCallList.length === 0) {
    return res.status(400).json({
      error: 'No tool calls in request body.',
      received: req.body,
    });
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
      try {
        result = fn(args || {});
      } catch (e) {
        result = { error: String(e?.message || e) };
      }
    }

    console.log(`🔧 ${fnName}(${JSON.stringify(args)}) →`, result);

    return {
      toolCallId: call.id,
      result: typeof result === 'string' ? result : JSON.stringify(result),
    };
  });

  res.json({ results });
});

// Direct testing endpoint (handy for verifying tools work without Vapi)
// Examples:
//   GET /api/test/get_place_info?name=Chapin
//   GET /api/test/rank_tracts?direction=fastest_growing&count=3
//   GET /api/test/get_county_data?county=Lexington
app.get('/api/test/:tool', (req, res) => {
  const fn = TOOLS[req.params.tool];
  if (!fn) {
    return res.status(404).json({ error: `Unknown tool: ${req.params.tool}`, available: Object.keys(TOOLS) });
  }
  const args = { ...req.query };
  // coerce numeric strings
  for (const k of Object.keys(args)) {
    if (/^-?\d+$/.test(args[k])) args[k] = parseInt(args[k], 10);
  }
  try {
    res.json({ tool: req.params.tool, args, result: fn(args) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// =============================================================
// START
// =============================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Chapin Map Voice API listening on port ${PORT}`);
  console.log(`   Try: curl http://localhost:${PORT}/api/test/get_place_info?name=Chapin`);
});
