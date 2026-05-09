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

// =============================================================
// TOOL IMPLEMENTATIONS
// =============================================================
const TOOLS = {
  /**
   * Look up info about any named place — town, CDP, ZIP, county, or tract.
   */
  get_place_info({ name }) {
    if (!name) return { error: 'Need a place name to look up.' };
    const n = String(name).toLowerCase().trim();

    // 1. Counties
    if (summary.county_population_by_year) {
      for (const [county, years] of Object.entries(summary.county_population_by_year)) {
        if (n.includes(county.toLowerCase())) {
          return {
            name: `${county} County, SC`,
            type: 'county',
            population_by_year: years,
            growth_2000_2020_pct: years[2000] && years[2020]
              ? Math.round((years[2020] - years[2000]) / years[2000] * 1000) / 10
              : null,
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
        return {
          name: place.properties.display_name,
          type: place.properties.kind,
          notes: place.properties.tooltip,
        };
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
      return {
        name: p.NAME,
        type: 'census_tract',
        county: `${p.county_name} County, SC`,
        population_2010: p.pop_2010,
        population_2020: p.pop_2020,
        growth_pct_2010_to_2020: p.growth_pct,
        note: p.has_2010
          ? null
          : 'This tract did not exist in 2010 — it was created when an older tract was split (often a fast-growth area).',
      };
    }

    return { error: `Couldn't find a place matching "${name}".` };
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
