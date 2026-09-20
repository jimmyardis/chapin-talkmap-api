/* GENERATED from townring/shared/place-lookup.js by execution/sync_api.sh.
   Do not edit here — edit the shared module and re-run the sync. */
/* ============================================================
   TownRing — shared place lookup (browser side)
   ------------------------------------------------------------
   One implementation of get_place_info for all four cities.

   Each city's voice.js used to carry its own copy (59 to 92 lines,
   all slightly different), and all four shared the same three bugs:

     1. A place result carried a name but no population, so "what is
        the population of Chapin town?" answered with nothing and the
        model fell back to whatever number was in its system prompt —
        the 96,000 Greater Chapin figure.
     2. The map's own name returned the whole multi-tract area typed
        as "city", so "Chapin" also read as 96,000 rather than the
        town's ~1,800.
     3. Colloquial names people actually use (White Rock, Ballentine,
        Lake Murray) are not census places, so they fell through to
        "couldn't find a place", which sounds like a broken map.

   The population now comes from execution/enrich_places.py, and the
   colloquial names from shared/colloquial.json. Keep this in step
   with get_place_info in the chapin-talkmap-api server, which answers
   the same tool on phone calls.
   ============================================================ */

function lookupPlace(name, DATA, slug) {
  if (!name) return { error: 'Need a place name to look up.' };
  const n = String(name).toLowerCase().trim();
  const { tracts, places, summary, colloquial } = DATA;

  // A bare name can be several places at once. "Charleston" is a city of
  // 150,000, a county of 407,000, and the tri-county area this map covers;
  // "Chapin" is a town of 1,800 and a 24-tract area of 96,000. Whichever
  // branch ran first used to win, so the agent quoted a county or a whole
  // region as though it were the town. Gather every exact reading, and hand
  // the model all of them when more than one fits.
  const countyHit = Object.entries(summary?.county_population_by_year || {})
    .find(([county]) => n === county.toLowerCase());
  const placeHit = places?.features?.find(
    f => String(f.properties.BASENAME || '').toLowerCase() === n
  );
  const areaHit = summary?.city && summary.city.toLowerCase() === n;

  const readings = {};
  if (placeHit)  readings.place  = placeResult(placeHit);
  if (countyHit) readings.county = countyResult(countyHit);
  if (areaHit)   readings.area   = mapArea(summary);

  const found = Object.keys(readings);
  if (found.length > 1) {
    const labels = [];
    if (readings.place)  labels.push(`the ${readings.place.type === 'incorporated_town' ? 'city or town' : 'place'} itself (${readings.place.name})`);
    if (readings.county) labels.push(`${readings.county.name}`);
    if (readings.area)   labels.push(`the whole area this map covers (${readings.area.total_tracts} tracts)`);
    return {
      ambiguous: true,
      note: `"${name}" could mean ${labels.join(', or ')}. `
          + `Lead with ${readings.place ? 'the city or town itself' : 'the county'} unless the caller `
          + `clearly asked about something bigger, and always say which one you are quoting.`,
      ...readings,
    };
  }
  if (found.length === 1) return readings[found[0]];

  // Loose county match ("Richland County", "greater Charleston")
  for (const [county, years] of Object.entries(summary?.county_population_by_year || {})) {
    if (n.includes(county.toLowerCase())) return countyResult([county, years]);
  }

  // Loose place match
  const place = places?.features?.find(f => {
    const dn = String(f.properties.display_name || '').toLowerCase();
    const bn = String(f.properties.BASENAME || '').toLowerCase();
    return dn.includes(n) || (bn && (n.includes(bn) || bn.includes(n)));
  });
  if (place) return placeResult(place);

  // 4. Colloquial area — real name, no census geography
  const col = (colloquial || {})[n];
  if (col) {
    return {
      name: col.name,
      type: 'colloquial_area',
      has_own_population: false,
      note: col.note,
      suggestion: `${col.name} has no census boundary of its own, so there is no official population for it. `
                + `You can still fly there, or quote the census tract that covers it.`,
    };
  }

  // 5. Census tract by number or name
  const digits = n.replace(/\D/g, '');
  const tract = tracts?.features?.find(f => {
    const t  = String(f.properties.TRACT || '');
    const tn = String(f.properties.NAME  || '').toLowerCase();
    return (digits && t.includes(digits)) || tn.includes(n);
  });
  if (tract) {
    const p = tract.properties;
    const out = {
      name: p.NAME,
      type: 'census_tract',
      county: `${p.county_name} County, SC`,
      population_2010: p.pop_2010,
      population_2020: p.pop_2020,
      growth_pct_2010_to_2020: p.growth_pct,
      median_household_income: p.median_income,
      median_age: p.median_age,
      density_per_sqkm: p.density_per_sqkm,
    };
    const history = {};
    for (let y = 2014; y <= 2024; y++) if (p[`pop_${y}`] != null) history[y] = p[`pop_${y}`];
    if (Object.keys(history).length) out.population_by_year = history;
    if (!p.has_2010) out.note = 'This tract did not exist in 2010 — created when a larger tract was split.';
    return out;
  }

  return {
    error: `Couldn't find "${name}" on the ${summary?.city || slug} map.`,
    suggestion: 'Try a town name, a county, or a census tract number.',
  };
}

function placeResult(place) {
  const p = place.properties;
  const out = {
    name: p.display_name,
    type: p.kind,
    notes: p.tooltip,
  };
  if (p.pop_2020_dec != null) out.population_2020 = p.pop_2020_dec;
  if (p.pop_2010_dec != null) out.population_2010 = p.pop_2010_dec;
  if (p.growth_pct_2010_2020 != null) out.growth_pct_2010_2020 = p.growth_pct_2010_2020;

  const history = {};
  for (let y = 2014; y <= 2024; y++) if (p[`pop_${y}`] != null) history[y] = p[`pop_${y}`];
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

function countyResult([county, years]) {
  const yrs = Object.keys(years).map(Number);
  return {
    name: `${county} County, SC`,
    type: 'county',
    population_by_year: years,
    population_latest: years[Math.max(...yrs)],
    latest_year: Math.max(...yrs),
  };
}

function mapArea(summary) {
  return {
    name: `Greater ${summary.city}`,
    type: 'map_area',
    description: `The ${summary.total_tracts} census tracts this map covers`,
    counties: summary.counties,
    total_population_2020: summary.pop_2020,
    total_population_2010: summary.pop_2010,
    growth_pct_2010_2020: summary.growth_pct_2010_2020,
    total_tracts: summary.total_tracts,
  };
}

module.exports = { lookupPlace };
