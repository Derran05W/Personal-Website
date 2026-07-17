#!/usr/bin/env python3
"""
run_researchers.py — dispatch cheap Haiku subagents to gather Toronto map data.

Usage:
    export ANTHROPIC_API_KEY=sk-ant-...
    python3 run_researchers.py            # run all agents
    python3 run_researchers.py places     # run one agent

Why Haiku: these are bounded lookup tasks (addresses, heights, model links).
No reasoning depth needed — just search, extract, emit JSON. Haiku 4.5 with
server-side web_search does this at a tiny fraction of a frontier model's cost.

EXIT CONDITIONS (every agent, enforced mechanically — not by trusting the model):
  1. SEARCH BUDGET   tools[].max_uses      — server enforces max web searches
  2. TOKEN CAP       max_tokens            — hard output ceiling
  3. JSON CONTRACT   system prompt         — "JSON only"; anything else is
                                             stripped/parsed defensively below
  4. WALL CLOCK      HTTP timeout 300s     — plus exactly ONE retry
  5. SCHEMA GATE     validate() below      — items missing required keys are
                                             dropped and logged, never trusted
  6. NO FOLLOW-UPS   single request per agent; the loop happens server-side
                     inside that one request. No multi-turn drift possible.
"""

import json, os, sys, time, urllib.request, urllib.error, re, pathlib

API   = "https://api.anthropic.com/v1/messages"
MODEL = "claude-haiku-4-5-20251001"
OUT   = pathlib.Path(__file__).parent / "out"
KEY   = os.environ.get("ANTHROPIC_API_KEY", "")

SYSTEM = (
    "You are a research subagent with a strict budget. Follow exactly:\n"
    "- Use at most the allowed number of web searches. Stop early when the schema is filled.\n"
    "- Reply with ONLY a valid JSON object matching the requested schema. No prose, no markdown fences.\n"
    "- Every item must be verified against a source; include 'src' (domain) per item.\n"
    "- NEVER invent an address, height, or URL. If unverified within budget, omit it "
    "or include it with \"confidence\":\"low\".\n"
    "- Prefer official sites, Wikipedia, open-data portals over blogs."
)

BOUNDS = ("Downtown Toronto bounded by Bathurst St (west), Jarvis St (east), "
          "Bloor St (north), Lake Ontario (south); PLUS the Yonge St corridor "
          "in North York between Sheppard Ave and Finch Ave.")

AGENTS = {
  # ---------------------------------------------------------------- places --
  "places": dict(
    max_searches=6, max_tokens=3500,
    task=f"""Find 18-24 widely recognized consumer spots inside these boundaries: {BOUNDS}

Selection rules:
- Recognizable > niche. Chains, flagships, and local icons most Torontonians know.
- Must be easy to represent as a small building + simple 2D logo.
- Cover a mix: fast food icon, late-night food, one fine-dining icon (e.g. Alo, 163 Spadina Ave),
  dessert, coffee/bubble tea chains, a bar chain (e.g. 'Warehouse' group), retail flagships,
  a grocery icon, and 5-7 spots on the North York Yonge strip (Korean BBQ, ramen, karaoke, H Mart etc).
- EXCLUDE (already mapped): Magic Noodle, Alpha's Shawarma, Shake Shack, The Fifth Social Club,
  Eaton Centre itself, St Lawrence Market.
- Verify each still operates at that address (2026).

Schema:
{{"places":[{{"name":"","address":"","zone":"downtown|north_york","category":"",
"brand_color":"#hex","building_look":"one line, e.g. grey 2-storey, red fascia",
"logo_hint":"e.g. golden arches M","recognizability":1,"src":""}}]}}""",
  ),
  # ----------------------------------------------------------------- specs --
  "specs": dict(
    max_searches=6, max_tokens=3500,
    task="""For EACH building below, find: architectural height in metres, floor count,
primary exterior material/colour (e.g. 'black steel, bronze glass'), and one silhouette note.
If height is not quickly findable, floors alone is acceptable.

Buildings: CN Tower; Rogers Centre (incl. dome diameter); TD Bank Tower (66 Wellington W);
First Canadian Place; Scotia Plaza; Commerce Court West; Royal Bank Plaza South Tower;
CIBC Square (81 Bay); Fairmont Royal York; Union Station (facade length); Toronto Eaton Centre
(250 Yonge tower); Aura at College Park; The Well (Wellington tower); Hullmark Centre
(Yonge/Sheppard); North York Civic Centre.

Schema:
{"buildings":[{"name":"","height_m":0,"floors":0,"material_color":"",
"footprint_note":"","silhouette_note":"","src":""}]}""",
  ),
  # ---------------------------------------------------------------- models --
  "models": dict(
    max_searches=5, max_tokens=2500,
    task="""Find FREE sources for Toronto 3D geometry / models. Verify each link works logic-ally
(official page exists). Wanted:
1. City of Toronto '3D Massing' open dataset — current portal URL, formats, licence.
2. Cadmapper — free tile size limit + formats for a Toronto downtown extract.
3. 1-3 CC-licensed CN Tower and/or Rogers Centre models (Sketchfab / poly.pizza) — licence type per model.
4. OpenStreetMap building footprint/height extraction route (e.g. Overpass, osmnx) — one-line how.

Schema:
{"assets":[{"asset":"","url":"","license":"","format":"","notes":"","src":""}]}""",
  ),
}

REQUIRED = {  # schema gate: keys every item must carry to be accepted
  "places":   ("name", "address", "zone", "category"),
  "specs":    ("name",),
  "models":   ("asset", "url", "license"),
}
ROOT_KEY  = {"places": "places", "specs": "buildings", "models": "assets"}


def call(agent: str, cfg: dict) -> dict:
    body = json.dumps({
        "model": MODEL,
        "max_tokens": cfg["max_tokens"],                       # EXIT 2
        "system": SYSTEM,                                      # EXIT 3
        "messages": [{"role": "user", "content": cfg["task"]}],
        "tools": [{"type": "web_search_20250305", "name": "web_search",
                   "max_uses": cfg["max_searches"]}],          # EXIT 1
    }).encode()
    req = urllib.request.Request(API, data=body, headers={
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
    })
    for attempt in (1, 2):                                     # EXIT 4: one retry
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  [{agent}] attempt {attempt} failed: {e}")
            if attempt == 2:
                raise
            time.sleep(5)


def extract_json(resp: dict) -> str:
    text = "".join(b.get("text", "") for b in resp.get("content", [])
                   if b.get("type") == "text")
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M)
    a, b = text.find("{"), text.rfind("}")
    return text[a:b + 1] if a != -1 and b != -1 else "{}"


def validate(agent: str, data: dict) -> dict:                  # EXIT 5
    key, req = ROOT_KEY[agent], REQUIRED[agent]
    items, kept = data.get(key, []), []
    for it in items:
        if all(it.get(k) for k in req):
            kept.append(it)
        else:
            print(f"  [{agent}] DROPPED (missing {req}): {json.dumps(it)[:100]}")
    return {key: kept}


def main():
    if not KEY:
        sys.exit("Set ANTHROPIC_API_KEY first.")
    OUT.mkdir(parents=True, exist_ok=True)
    targets = sys.argv[1:] or list(AGENTS)
    total_in = total_out = 0
    for name in targets:
        cfg = AGENTS[name]
        print(f"▶ {name}: ≤{cfg['max_searches']} searches, ≤{cfg['max_tokens']} tokens")
        resp = call(name, cfg)
        usage = resp.get("usage", {})
        total_in  += usage.get("input_tokens", 0)
        total_out += usage.get("output_tokens", 0)
        searches = sum(1 for b in resp.get("content", [])
                       if b.get("type") == "server_tool_use")
        data = validate(name, json.loads(extract_json(resp)))
        (OUT / f"{name}.json").write_text(json.dumps(data, indent=2))
        n = len(data[ROOT_KEY[name]])
        print(f"  stop={resp.get('stop_reason')}  searches={searches}  "
              f"tokens={usage.get('input_tokens')}/{usage.get('output_tokens')}  kept={n} items")
    print(f"\nTOTAL haiku tokens  in={total_in}  out={total_out}")


if __name__ == "__main__":
    main()
