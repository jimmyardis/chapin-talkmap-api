# Chapin Map Voice API

Tiny Express server exposing three Vapi-callable tools:

- `get_place_info(name)` — info about any named place (town, CDP, ZIP, county, tract)
- `rank_tracts(direction, count, county)` — ranked tracts by a metric
- `get_county_data(county, year)` — county-level population totals

All three tools share a single endpoint: `POST /api/vapi-tool`. Vapi sends the tool call(s) in the request body; we route by function name and return JSON.

## Local test

```
npm install
npm start
```

Then in another terminal:

```
curl "http://localhost:8080/api/test/get_place_info?name=Chapin"
curl "http://localhost:8080/api/test/rank_tracts?direction=fastest_growing&count=3"
curl "http://localhost:8080/api/test/get_county_data?county=Richland"
```

Each should return JSON with real data.

## Deploy to Railway

1. Create a new Railway project (`railway.app` → New Project)
2. Either:
   - **Push this folder to a new GitHub repo**, then "Deploy from GitHub" in Railway, OR
   - Use the Railway CLI: `railway login` → `railway init` → `railway up`
3. Railway auto-detects this as a Node.js project and runs `npm start`
4. Once deployed, copy the public URL (something like `https://chapin-talkmap-api-production.up.railway.app`)

## Wire to Vapi

For each of your three Vapi tools (`get_place_info`, `rank_tracts`, `get_county_data`), set:

- **Server URL**: `https://YOUR-RAILWAY-URL.up.railway.app/api/vapi-tool`
- **Async**: off
- **Strict**: off

(All three tools point at the SAME URL — the server routes by function name.)

Save each tool. The agent will now call this server when invoking any of the three tools.

## File structure

```
chapin-talkmap-api/
├── server.js          # Express server with the 3 tools
├── package.json
├── README.md
└── data/
    ├── chapin-area-tracts.geojson    # 190 census tracts
    ├── chapin-area-summary.json      # county totals + highlights
    └── chapin-places.geojson         # Chapin/Irmo/Lake Murray/etc. boundaries
```

## What Vapi sends + what we return

Vapi POSTs a body like:

```json
{
  "message": {
    "type": "tool-calls",
    "toolCallList": [
      {
        "id": "call_abc123",
        "function": {
          "name": "get_place_info",
          "arguments": "{\"name\":\"Chapin\"}"
        }
      }
    ]
  }
}
```

We respond with:

```json
{
  "results": [
    {
      "toolCallId": "call_abc123",
      "result": "{\"name\":\"Chapin (incorporated town)\",...}"
    }
  ]
}
```

Vapi parses the `result` string back into JSON for the LLM and the agent uses it in the conversation.
