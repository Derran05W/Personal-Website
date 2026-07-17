# Toronto Playable Map — Spec v2

Supersedes v1 (projection/road-graph/TDD doc). v1 sections still apply unless amended here.
Companion data: `data/building-specs.json`, `data/places.json`, `data/model-sources.json`.
Research tooling: `agents/run_researchers.py` (Haiku dispatch, see §9).

---

## 1. World shape — the thermometer

The map is **not a rectangle**. It is a downtown block with a narrow stem rising to a
North York capsule — matching how you actually experience the city.

```
        ┌──────────┐   ← North York capsule (800 wu wide)
        │ FINCH    │      y 0 → 1170
        │  yonge   │
        │ SHEPPARD │
        └───┐  ┌───┘
            │  │       ← Midtown fold (600 wu wide corridor)
            │yg│          y 1170 → 1830   (~9 km folded into 660 wu)
        ┌───┘  └────────────┐
        │ BLOOR             │
        │                   │  ← Downtown block (full 2400 wu)
        │ bathurst ... jarvis│     y 1830 → 3700
        │ FRONT             │
        │ ~~~~ lake ~~~~~~~ │  ← water band y 3700 → 4100
        └───────────────────┘
```

**Playable polygon** (world units, y-down, clockwise):

```
(1100,0) (1900,0) (1900,1170) (1800,1170) (1800,1830) (2400,1830)
(2400,4100) (0,4100) (0,1830) (1200,1830) (1200,1170) (1100,1170)
```

Outside the polygon: void colour + soft vignette. Camera clamps to polygon with
80 wu padding. Edge exits get signposts, not walls: `← Liberty Village`,
`→ The Danforth`, `↑ Steeles Ave`, `→ Distillery District`.

**Tests**
```
polygon is simple (no self-intersection)
every road segment lies fully inside polygon
camera clamp never shows void at default zoom
```

## 2. Zones & scales

| Zone | y-range | N-S scale | E-W scale | rationale |
|---|---|---|---|---|
| North York | 0–1170 | 2.30 m/wu | 1.55 m/wu | Finch→Sheppard ≈2.4 km → 1000 wu; corridor, mildly compressed N-S |
| Midtown fold | 1170–1830 | ~13.6 m/wu | 1.55 m/wu | ~9 km folded into 660 wu (≈0.11×) |
| Downtown | 1830–3700 | 1.55 m/wu | 1.55 m/wu | Bloor→shore ≈2.9 km, Bathurst→Jarvis ≈3.05 km — near-square, full detail |

Projection stays piecewise-linear per v1, now with these three regimes on `f(lat)`
and uniform `g(lon)` anchored so **Yonge = x 1500** everywhere (the spine must be a
straight vertical — it's the thing that makes the whole shape legible).

**Key anchors** (street → world):
Bathurst 210 · Spadina 660 · University 1080 · Bay 1330 · **Yonge 1500** · Church 1670 · Jarvis 2180-edge≈1840 …
Finch y 170 · Sheppard y 1170 · Eglinton node y ≈1500 (inside fold) · Bloor y 1830 ·
Queen y ≈2750 · King y ≈3140 · Front y ≈3370 · shoreline y 3700.
(Regenerate exact values from the projection function — do not hand-tune twice.)

**The fold, made honest:** the v1 concern stands — 0.11× feels like teleporting.
Decision: **subway-tunnel transition.** Driving north past Sheppard-boundary /
south past Bloor on Yonge triggers a short "Line 1" interstitial (dark tunnel,
station names flying past: York Mills · Lawrence · Eglinton · Davisville · St Clair
· Summerhill · Rosedale). Cost: one canvas overlay. Benefit: the compression reads
as a *joke Torontonians are in on*, not a bug. The fold band still renders on the
map (creased-paper hatch + the squeezed station dots) for the minimap/zoom-out view.
Keep the **Yonge & Eglinton mini-node** (with the 40 Eglinton Ave E Shake Shack)
drivable inside the fold for flavour.

## 3. Scale system

### 3a. Roads (the playable surface — deliberately oversized)
Unchanged from v1: one class table, no scattered literals.

| class | width wu | streets |
|---|---|---|
| spine | 36 | Yonge |
| artery | 32–34 | University, Bloor, Spadina |
| major | 26–30 | King, Queen, Dundas, College, Front, Bay, Church, Jarvis, Bathurst, Finch, Sheppard, Queens Quay |
| minor | 16–20 | Richmond, Adelaide, John, Portland, York, Bremner, Park Home |

Real arterials are ~20 m ≈ 13 wu; we draw 26–36. **Ratio ≈ 2–2.8× on roads.**

### 3b. Building footprints
`footprint_wu = real_m / 1.55 × 0.5` → buildings at **half** projected size.
Net road:building ratio ≈ 4–5× vs reality = your "roads big, buildings small" brief.

### 3c. Height compression (new — answers "a large CN Tower would be hard to see")
Linear height would make CN Tower 46× a corner shop and it would block the camera.
Use a power curve:

```
h_game = 2.05 × (h_real_m)^0.6      shadow_wu = h_game × 0.35
```

Computed table (full data in `building-specs.json`):

| Building | real m | floors | game h (wu) | footprint (wu) | material |
|---|---|---|---|---|---|
| CN Tower | 553.3 | — | **91** | 21 | grey concrete, glass pods |
| First Canadian Place (BMO) | 298 | 72 | 63 | 19 | WHITE (marble→white glass reclad) |
| Scotia Plaza | 275 | 68 | 60 | 18 | DEEP RED granite |
| Aura (Yonge/Gerrard) | 272 | 78 | 59 | 15 | dark blue-grey glass |
| CIBC Square (81 Bay) | 241 | 49 | 55 | 18 | blue glass, banded |
| Commerce Court W (CIBC) | 239 | 57 | 55 | 17 | stainless + grey glass |
| TD Bank Tower | 223 | 56 | 53 | 19 | matte BLACK steel |
| Royal Bank Plaza S (RBC) | 180 | 41 | 46 | 16 | GOLD glass |
| The Well tower | 174 | 46 | 45 | 15 | glass on red-brick podium |
| Hullmark (Yonge/Shep) | 161 | 45 | 43 | 13 | blue-green twin |
| Emerald Park (Yonge/Shep) | 147 | 44 | 41 | 13 | GREEN curved twin |
| Fairmont Royal York | 124 | 28 | 37 | 39 | limestone + copper-green roof |
| Rogers Centre | 86 (roof) | — | 30 | 66 (dome ⌀205 m) | white/grey panels |
| North York Civic Centre | 40 | 10 | 19 | 26 | grey precast |
| Eaton Centre galleria | 38 | 4 | 18 | 84 long | glass barrel vault |
| Casa Loma | 30 | 3 | 16 | 32 | grey stone castle |
| Union Station | 27 | 4 | 15 | 74 long | limestone colonnade |
| 2-storey shop | 12 | 2 | 9 | ~8 | per-district |

Result: **CN:shop drops 46× → 10×, CN:FCP 1.86× → 1.44×.** Tallest thing on the map
by a clear margin, never a wall. If 3D: add occlusion-fade (alpha 0.35) on any hero
between camera and player.

**Tests**
```
h_game monotonic in h_real
CN Tower is max height AND ≤ 100 wu
sum: no building footprint exceeds its block (grid gap check)
every skyline building's material matches building-specs.json (single source)
```

## 4. Buildings + 2D logos — final pipeline

Your vision, formalized: **colour + rough shape + flat logo = identity.**

```
Building {
  ...v1 fields,
  material: glass_black | glass_blue | glass_gold | glass_green | marble_white
          | granite_red | brick_red | brick_yellow | limestone | precast_grey
          | storefront,                       // drives fill + trim + window pattern
  dims: { w, d, h }         // from §3 rules, precomputed in building-specs.json
  decal: { logo: atlasKey, mode: CROWN | FASCIA, face: N|S|E|W }
}
```

Two decal modes (this mirrors reality and reads instantly):
- **CROWN** — towers. Logo centred on `face` at 70–85% of height,
  size = clamp(0.5 × faceWidth, 8, 16 wu). This is literally how TD/CIBC/RBC
  signage works downtown; it will read as "correct" without anyone knowing why.
- **FASCIA** — retail/restaurants. Full-width band 3.5–5 wu above ground:
  logo glyph left, name text right. Optional queue-of-people prop
  (Uncle Tetsu, Konjiki NY — the lineup *is* the landmark).

Logo atlas: unchanged from v1 (32×32 pixel grids, baked once). New additions
needed from `places.json`: golden arches, Tims oval, H MART, Loblaws L,
WAREHOUSE wordmark, hangul glyphs, neon record discs (animated 2-frame),
Real Sports, MEC, Rec Room, Apple.

Windows come free: material implies a window pattern (glass = column stripes,
brick = punched grid, storefront = big ground glazing). One 10-line shader/fn,
huge realism return.

## 5. Hero models — CN Tower & Rogers Centre

Decision after sourcing (see `model-sources.json`): **hand-build from primitives;
use CC models + your Apple Maps screenshots as proportion reference only.**
Sketchfab CC-BY meshes exist (42k–87k tris) but are heavy, unstyled, and one is a
Google Earth rip you shouldn't ship. Primitives match the pixel-logo aesthetic anyway.

**CN Tower (91 wu total)** — proportions locked from real data:
main pod centre at 346/553 ≈ **0.62 × h**, SkyPod at 447/553 ≈ **0.81 × h**,
shaft taper from 21 wu base → 6 wu below pod, hex/Y base with 3 splayed legs
(bottom 8% of height), needle top 12%. Night mode: pod LED ring (it's lit
red/white IRL — instant recognition).

**Rogers Centre (30 wu, ⌀66 wu)** — ring base 15% h, dome cap, **4 nested roof-panel
arcs with visible seams, closed position**, one panel drawn as the sliding section.
Grey-white, never brand-coloured. Adjacent placement rule from v1 stands:
tower and dome touching, south of Front, west of the rail corridor.

**Apple Maps screenshot protocol** (yes — useful, bring these back):
1. CN Tower from SW, ~30° elevation — shaft taper + pod height check
2. Rogers roof, top-down — panel seam layout
3. King & Bay from S, ~45° — the four bank colours in one frame
4. Royal York roof detail — copper-green stepping
5. Yonge & Sheppard from N — Hullmark/Emerald twin massing
Use them to *eyeball ratios against the spec table*, not to extract geometry
(impractical + ToS). Numbers stay authoritative in `building-specs.json`.

## 6. District vibe kit

Vibe = 4 cheap levers per district: **ground tint** (subtle fill under the block),
**building stock default** (material for unlabelled filler), **2–3 props**, **signage
style**. Ambient audio optional later. One data table drives all four:

| District | tint | filler stock | props | signage |
|---|---|---|---|---|
| Financial (King×Bay) | cool grey | glass_black/white | suits stream (dots), hotdog cart, PATH stair | crown logos only, no colour |
| Entertainment (Richmond/Adelaide×John–Duncan) | night-purple | precast_grey lowrise | queue ropes, bouncer, LED wash | vertical neon |
| King West | warm brick | brick_red 4-storey | patios, string lights | painted wordmarks |
| Queen West | cream | storefront 2–3st | graffiti wall (Rush Lane!), streetcar, bike racks | hand-painted, mixed |
| Chinatown/Kensington | warm red-green | storefront clutter | red gate @ Spadina×Dundas, produce stands, hand-pulled signs | dense bilingual, stacked |
| Yonge Dundas→Queen | bright | storefront + billboards | Sankofa Sq screens (animated colour blocks), crowds | screen glow |
| Church-Wellesley | rainbow accent | brick_yellow 3st | rainbow crosswalk @ Church×Alexander | small pride flags |
| U of T / Discovery | green-grey | limestone + brutalist | quads, Robarts peacock mass, MaRS glass | engraved serif |
| St Lawrence / Old Town | warm sandstone | brick_red heritage | market awnings, Gooderham flatiron cameo | gold-on-green heritage |
| Harbourfront | blue-grey | glass_blue condos | boardwalk, ferry, Sugar Beach pink umbrellas, YTZ prop plane | minimal white |
| Bloor/Yorkville edge | champagne | limestone luxe | topiary, awnings | serif, understated |
| North York Centre | clean civic | glass_green/blue twins | Mel Lastman pond+arch, condo canyon | corporate + civic |
| Willowdale/Finch strip | warm neon | storefront strips | 2nd-floor stacked signage, karaoke neon, H Mart sweet-potato cart | hangul-forward, vertical stacks |

Rule: filler buildings inherit district stock automatically; only named buildings
override. That's how 40 named buildings + ~300 filler blocks feel like a whole city.

## 7. Free geometry sourcing (verified July 2026)

Full detail in `model-sources.json`. Summary + decision:

1. **Cadmapper** — free ≤1 km² extracts (DXF/SketchUp/Rhino/Illustrator, heights
   incl.), free whole-Toronto 2D road DXF. → **Pull 4 free tiles**: King&Bay,
   rail lands/CN, Yonge Dundas→Queen, Yonge&Sheppard. Covers every hero zone, $0.
2. **OSM via Overpass/osmnx** — live footprints + patchy heights, ODbL. → the
   programmatic route; your projection eats GeoJSON directly.
3. **City of Toronto 3D Massing** — the ideal source **but the portal page is now
   marked Retired**; archived copies live at TMU/York geospatial centres. Grab if
   convenient, don't block on it.
4. **Sketchfab CC-BY CN Tower models** — reference only (credit if shipped).

## 8. Places layer

`data/places.json`: 20 entries, each `verified | knowledge | needs_agent`.
Five gaps intentionally left for the agent (`needs_agent`): downtown McDonald's
exact address, Tims pick, The Alley unit, NY Korean-BBQ anchor, NY karaoke anchor.
Everything verified this session: Warehouse (336 Yonge + 232 Queen W), Uncle Tetsu
(595 Bay), Konjiki ×2 (41 Elm, 5051 Yonge), H Mart ×2 (5545 + 4885 Yonge),
Buk Chang Dong (5445 Yonge). Note the **Sam the Record Man discs** entry — it's a
rooftop sign, not a building; treat as an animated prop. Highest nostalgia-per-vertex
object on the map.

## 9. Agent ops (cost-controlled research)

`agents/run_researchers.py` — Haiku 4.5 + server-side web_search. Exit conditions
are mechanical, not vibes: per-agent search cap (`max_uses` 5–6), token cap
(2.5–3.5k), JSON-only contract with a schema gate that drops malformed items,
300 s timeout, exactly one retry, one request per agent (no multi-turn drift).
Run: `ANTHROPIC_API_KEY=... python3 run_researchers.py [places|specs|models]`.
It prints per-agent token usage + search count so you can watch the burn.
Expected cost: all three agents ≈ a few cents. Re-run `places` after adding any
`needs_agent` rows; re-run `specs` if you extend the skyline list.

## 10. Build order (v2)

| Phase | Deliverable | Done when |
|---|---|---|
| 0 | Piecewise projection + polygon world | anchors land; polygon tests green |
| 1 | Road graph on new shape + tunnel transition | Finch→Union drive feels right; fold reads as a bit, not a bug |
| 2 | Filler massing from Cadmapper/OSM + district stock | zoomed-out screenshot = "that's downtown" |
| 3 | Named buildings + materials + CROWN/FASCIA decals | TD/RBC/Google identifiable at a block |
| 4 | Heroes: CN Tower + Rogers, night pod ring | **the screenshot test** |
| 5 | Places layer + vibe props + Sam's discs + queues | the nostalgia pass |

New tests added by v2: polygon containment, height-curve monotonic/cap,
material single-source, decal-face-toward-road, district-stock inheritance,
tunnel triggers exactly at fold boundaries.

---
*Confidence notes: heights/floors for the bank towers, CN, Aura, Royal York = high
(stable encyclopedia facts). CIBC Square, The Well, Hullmark, Emerald, Union facade,
Eaton galleria = medium — worth one `specs` agent pass before final tuning.*

---

## Addendum A — Renderer resolved: true 3D, Smashy Road-style (v2.1)

Confirmed: the game is true 3D with a low-poly, flat-shaded look and an elevated
chase camera ("plays exactly like Smashy Road"). Consequences, binding:

### A.1 Art direction lock
Flat-shaded, flat/vertex-coloured extruded boxes. The §4 material table maps to
plain colours + a simple window-stripe treatment (thin darker quads or a tiny
repeating strip texture — pick one, use everywhere). One directional light,
simple blob shadows. The `shadow_wu` column in building-specs.json becomes an
optional blob-shadow radius hint; real lighting does the rest. No photo
textures anywhere — a photoreal asset would break the style harder than a
missing one.

### A.2 Camera bearing → decal faces
**Check the code first:** does the camera keep a fixed compass bearing (classic
Smashy Road) or rotate with the car?
- **Fixed bearing:** exactly two faces of every box are ever visible. Author
  every CROWN/FASCIA decal on those two faces only, and replace the v1
  "decal faces a road" test with "decal face lies in the camera-visible
  half-space". Half the decal work disappears.
- **Rotating cam:** heroes and banks get CROWN decals on two opposite faces
  (or all four for the King & Bay cluster); retail FASCIA stays on the
  road-facing side and relies on proximity.

### A.3 Hero meshes — tri budgets
- **CN Tower ≤ 600 tris:** hex-prism shaft in 3 taper segments, 2 squashed
  cylinder pods (main at 0.62 h, SkyPod at 0.81 h), cone+cylinder needle,
  3 wedge legs on the bottom 8%. Emissive ring on the main pod for night mode.
- **Rogers Centre ≤ 500 tris:** ring base (15% h) + lathed dome cap +
  4 roof-panel bands with visible seam edges, closed position.
- **Bank towers = plain boxes** + crown decal. Their identity is colour +
  height + logo, not silhouette.
- Sketchfab CC models (42k–87k tris) are hereby **reference-only**: they clash
  with the art style by two orders of magnitude. `model-sources.json` stands.

### A.4 Filler pipeline (promoted to primary)
Cadmapper SketchUp/DXF tiles or OSM GeoJSON → run footprints through the §2
projection → extrude to `h_game` → merge → flat-colour by district stock (§6).
Extruded coloured boxes ARE the Smashy Road look; the filler city costs zero
art time.

### A.5 New Phase 4 tests
```
car is never fully hidden: meshes on the camera→car ray fade to ≤0.4 alpha within 150 ms
decal textures sample with nearest-neighbour, mipmaps disabled
CN Tower ≤ 600 tris; Rogers ≤ 500; no filler box > 12 tris
fixed-bearing branch only: every decal face lies in the visible half-space
```

### A.6 Handling feel check
Arcade Smashy-Road handling means §3a road widths are validated by playtest,
not math: drive King & Bay and the Yonge strip; if the minor class (16–20 wu)
clips during drifts, widen minors to 20 and re-test before touching anything else.
