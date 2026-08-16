# AR Marker Studio

**Know your NFT marker's quality before you build it.** A marker authoring tool for
ARToolKit5 / ARnft.

→ **https://kidsnz.github.io/ar-marker-studio/**

[日本語版 README](README.ja.md)

The existing [NFT-Marker-Creator](https://github.com/Carnaux/NFT-Marker-Creator) will happily
generate a marker, but it tells you nothing about whether that marker is any good. You find out
on the phone, when the pose jitters. Then you edit the artwork, generate again, and repeat.

This tool predicts the number of tracking points **before** you generate, and shows you which
part of the artwork is letting you down. Generation happens on the same page.

No server. Your images never leave the browser.

---

## What it does

| | |
|---|---|
| **Predicts before generating** | Tracking points per distance band, in a few seconds |
| **Judges real-world use** | "How many points do I actually get holding the phone upright?" |
| **Heatmaps** | Selected points / candidate strength / **areas with no clue at all** |
| **Generates** | Runs the real generator in-browser and gives you `.fset` / `.fset3` / `.iset` |
| **Checks itself** | After generating, it compares the prediction against the real output |

## What the runtime actually does (and why the numbers are what they are)

The thresholds below are not folklore. They come from reading `tracking.c` and
`selectTemplate.c` in ARToolKit5, which is where "how many points do I need" is really decided.

| Fact | Source | What it means |
|---|---|---|
| **Tracking stops below 3 points** | `tracking.c`: `if(num < 3) return -3` | At exactly 3, one lost point ends it |
| **Only 16 points are tried per frame** | the default `AR2_DEFAULT_SEARCH_FEATURE_NUM` is 10, but `setupAR2()` in `ARToolKitNFT_js.cpp` overrides it with `ar2SetSearchFeatureNum(16)` | 90 points still means 16 per frame. **Spread beats count** |
| **Points in the outer 1/8 of the frame are never picked** | coordinate check in `ar2SelectTemplate` | Only bites when the band image is wider than ~176px |
| **If a band is empty it retries `[mindpi/2, maxdpi*2]`** | `extractVisibleFeatures` | The strict band count is a little pessimistic |
| **The band is chosen by the smaller of the two apparent dpi** | `ar2GetResolution2` puts the smaller in `dpi[1]`, and `w[1]` is what is tested | Confirms `min(width-based, height-based)` |

### Spread

`ar2SelectTemplate` picks the first four tracking points like this:

| Point | Chosen as |
|---|---|
| 1st | **farthest from the centre** of the frame |
| 2nd | **farthest from the 1st** |
| 3rd | **farthest from the line** through the 1st and 2nd |
| 4th | the one that **maximises the quadrilateral area** |
| 5th on | whatever was tracked last frame, otherwise random |

**Distribution is not a heuristic here, it is the algorithm.** The same number of points
bunched together only spans a small quadrilateral, and the pose wobbles.

The tool reports this as **spread**: the convex hull of the points as a share of the marker.
Measured against real devices:

| Spread | Points | Behaviour |
|---|---|---|
| 1% | 3 | jumps around |
| 17% | 9 | mostly stable |
| 33% | 14 | stable |

## How far away does it work?

The tool also answers "will this hold up from 30cm to 2m?". It derives the camera's field of
view from ARnft's standard `camera_para.dat` (640×480, fx=609.37, so 55.4° across the long
axis) and works out the apparent dpi at each distance:

```
focal length on the processing canvas = (long side px / 2) / tan(fov / 2)
   long side px = 320 held sideways, 240 held upright (the video rotates)
apparent dpi = focal length / distance in mm × 25.4
```

**Careful: the count does not fall off smoothly with distance.** The bands overlap unevenly, so
the number of points jumps up and down. Measured on satoshi/03 held upright: 39cm gives 14
points, 41cm gives 8, 49cm gives 12 again. Reporting a plain "from X to Y" would be a lie, so
the tool reports the longest continuous stretch and how many separate stretches there are.

## Detection is a separate problem from tracking

NFT has two independent halves, and they fail differently:

| Symptom | Culprit |
|---|---|
| It never recognises the marker | `.fset3` (detection) is weak |
| It recognises but the pose wobbles | `.fset` (tracking) has too few points |

After you generate, the tool reads the `.fset3` and adds a **Detection** column to the band
table. **A band with 0 detection keypoints cannot be recognised at that distance at all**, no
matter how many tracking points it has.

There is deliberately **no "repetitive pattern" score**. The idea is sound — the matcher uses a
ratio test (best/second-best < 0.7), so near-identical descriptors elsewhere in the image cancel
each other out — but every marker to hand recognises fine, so there was no failing example to
calibrate a threshold against. Rather than ship a number nobody can check, the tool reports the
counts and stops there.

An earlier version of this section said that feeding synthetic camera frames to the real detector
"did not work". **That was wrong: the fault was in the test harness, not in the approach.**
Driving the same WASM detector ARnft uses with generated frames works, and costs a few
milliseconds per condition. `tools/check_detection.py` in the website repo does exactly that —
it shrinks the marker frame by frame to find the size at which detection stops, which is how far
away it can be recognised from. What is still missing for a repetitive-pattern score is a marker
that actually fails, not a way to test one.

## Why the total point count is meaningless

A `.fset` splits its points across distance bands (scales). At runtime only the band matching
the **apparent resolution** of the marker in the camera is used. A marker with 92 points in
total can have just 14 in the band you actually use.

And **ARnft processes the camera image on a fixed 320×240 canvas** (hardcoded in `prepareImage()`
in `ARnft.js`). "My camera is 640px so I'm fine" is wrong, and getting this backwards throws the
verdict off by a factor of 3.5.

Two things shrink it further, and both have to be counted:

1. **How the video lands on the canvas.** Stock ARnft letterboxes an upright phone, so the marker
   only gets 180×240 of the canvas. This tool assumes the rotated pipeline instead
   (`ARnft-rot.js`: turn the video 90° and rotate the projection matrix back), which gives the
   marker **240×320** — the same canvas, without the black bars.
2. **`object-fit: cover`.** The video is displayed cropped, so roughly a quarter of it is never
   on screen, and you cannot put a marker where the user cannot see it. On the measured device
   (600×800 video, 375×664 screen) that leaves **75.3%** of the width.

```
apparent dpi = min( effective width px  ÷ marker width in inches,
                    effective height px ÷ marker height in inches )

   held upright, rotated pipeline   240 × 0.753 = 181  ×  320
   held upright, stock letterbox    180 × 0.753 = 136  ×  240
   held sideways                    320  ×  240 × 0.753 = 181
```

### These thresholds need re-measuring

| Usable points | How it behaved |
|---|---|
| 14 | stable |
| 9 | mostly stable, slight jitter |
| 3 | jumps around, unusable |

Those counts were produced by an older version that used a 180px width for an upright phone —
the letterbox canvas width, without subtracting the `object-fit: cover` crop. That number happens
to land within a pixel of the 181px this tool now uses for the rotated pipeline, so **the table
carries over rather than being invalidated**.

What has *not* been settled is a contradiction inside the older notes. Recomputed under the stock
letterbox model (136px), the same three markers come out at 3, **2** and 4 points — so the middle
one, written down as "mostly stable", sits below the 3-point floor where tracking stops outright,
and the felt ordering no longer matches. The most likely explanation is that the notes were taken
with the phone close enough that the marker overflowed the screen edges, which is a different
framing from the one the tool assumes. Until that is checked on a device, treat "stable" and
"marginal" as provisional.

The one number that is not a judgement call is the floor: below 3 points tracking stops, and that
comes from `tracking.c` (`if(num < 3) return -3`), not from how anything felt.

## What actually increases the point count

All of the following was measured, not guessed.

- **Scale up 2× with nearest-neighbour.** By far the most effective. Interpolated scaling
  softens the edges and backfires.
- **Use `-level=4`.** The generator defaults to 2. Just raising it nearly doubles the count.
- **Make the artwork coarser.** Place large blocks apart from each other.
- **Put structure on all four edges.** Top and bottom alone cannot fix horizontal position.
- **Go square or 4:3.** Wide formats lose badly when the phone is held upright.
- **Keep the greys.** Converting to pure black and white made one marker drop from 9 points to 2.

Confirmed not to help: thin lines, dithering, double or dashed lines, thin borders (under 3px
after downscaling), changing `-dpi` (it only shifts the bands), and 4× scaling (worse than 2×).

## Important: never feed it a PNG with an alpha channel

`rgbaToRgb()` in NFT-Marker-Creator is broken. It treats alpha as 0–1 while the values are
actually 0–255, then re-reads the resulting 3-bytes-per-pixel array in 4-byte steps. The result
is **the picture repeated about five times sideways with its tones inverted**. Flatten the
background to a solid colour and save as RGB before generating. This tool warns you when it
sees an alpha channel.

---

## Accuracy

The quality check is an independent reimplementation of ARToolKit5's `ar2GenImageSet`,
`ar2GenFeatureMap` and `ar2SelectFeature2`. **It was not guessed at: it was checked against the
real generator's own logs, point by point, band by band.**

Across 12 configurations (9 images × levels 0–4 × dpi 40–150):

| Agreement | Cases |
|---|---|
| Every coordinate, count and candidate identical | 7 |
| Counts identical; a few coordinates swapped between ties 5e-6 apart | 3 |
| Off by a few percent (flat, gradient-heavy artwork) | 2 |

Every remaining difference comes from **rounding inside the generator itself**. It accumulates
correlation over 2025 pixels in float32, so in low-contrast regions the sum loses precision and
values drift by about 1e-3. Reproducing that float32 accumulation step by step matched the
generator's logged values to six decimal places, which means this tool's float64 result is the
mathematically correct one. The difference is never large enough to change the verdict.

### Verification

**Always run the verification after touching the engine.** "I'm pretty sure that's right" is not
good enough. This check has already caught real mistakes.

Expected values live in `test/fixtures.js`. The marker source images come from
`projects/atariar/markers/` in the murakamishinji.com repository.

```bash
# Node
node test/verify.js ../website/projects/atariar/markers

# Browser: serve, then open test/verify.html and pick the folder
python3 -m http.server 8000
```

There is also a Python implementation of the same engine
(`tools/predict_features.py`) that passes the same fixtures. **The two check each
other.**

---

## The algorithm, for anyone porting it

**Correlation is not measured at every pixel.** Miss this and your prediction comes out about
five times too high.

1. **Narrow down the candidates.** Take a 3×3 gradient and keep only pixels greater than all
   four neighbours (`Extracted` in the log). Then build a 1000-bin histogram, walk down from the
   strongest, and cut off at **2% of the pixel count** (`Filtered`).
2. **Measure correlation.** For the survivors, build a 45×45 template and record the highest
   correlation anywhere **outside radius 2 but within ±10** (a 21×21 square with a radius-2 disc
   punched out). It stops early once anything exceeds 0.95, so the recorded value is not
   necessarily the true maximum.
3. **Take the lowest first.** A point qualifies if its value is below `max_thresh`, its
   luminance SD is at least `sd_thresh`, and the highest correlation within ±2px is **0.99 or
   lower** (hardcoded, not configurable). Each point taken paints out `occ_size × 2` around it.

The thing that will bite you is **float32**. ARToolKit computes key steps in single precision,
and writing them in JavaScript's doubles gives different answers. The minimum-dpi calculation in
particular:

```c
truncf( (28.0f / shorter side) * dpi * 1000.0 ) / 1000.0f
```

`* 1000.0` is a double constant, so the expression runs in double, but `truncf` takes a float,
so the value is **rounded up on the way in** and only then truncated. At 520×400 with dpi=60,
4199.9998 becomes 4200.0 and the result is 4.2. Truncate in double and you get 4.199, every
distance band shifts by 0.02%, a downscaled image comes out one pixel shorter, and nothing
downstream matches.

`js/engine.js` rounds through `Math.fround()` at every step where the C code uses a float.

## Layout

```
index.html          the page
css/style.css
js/engine.js        the quality engine (browser + Node, no dependencies)
js/i18n.js          language switching (English is the source, Japanese is a layer)
js/worker.js        runs the prediction off the main thread
js/heatmap.js       heatmap rendering
js/png.js           PNG decoder (canvas can alter pixels via colour profiles, so we decode here)
js/generate.js      generator entry point
js/genworker.js     runs generation off the main thread (it freezes the tab otherwise)
js/app.js           page wiring
vendor/             NFT-Marker-Creator build artifact (single asm.js file)
test/               verification (fixtures.js / verify.js / verify.html)

tools/              command-line tools (run independently of the browser app)
  predict_features.py   Python port of the engine; cross-checks js/engine.js
  parse_fset.py         scores an existing .fset; same criteria as js/fset.js
  check_detection.py    runs the real WASM detector to measure actual detection
  fix_fset3.py          adds a level to a .fset3
  make_camera_para.py   rotates / scales camera_para.dat
  nft_detect.js         detector wrapper used by check_detection.py
  camera-check.html     open on a phone to measure the real camera pipeline
docs/
  ar-marker-guide.md    technical guide (14 chapters); the basis for the criteria
```

The markers that `tools/` operates on live in a **sibling repository**
(`../website/projects/atariar/markers/`). Run the commands from the
ar-marker-studio root.

No build tools. Plain HTML/CSS/JS: `git push` and it is live.

GitHub Pages caches assets for 10 minutes, so the `?v=` query on the `<script>` and
`<link>` tags in `index.html` and `test/verify.html` matters: **bump that number whenever
you change a JS or CSS file.** Without it a returning visitor can end up running an old
script against a new one, which half-breaks the page.

Source comments are in Japanese, since this started as a tool for one artist's own workflow.
The UI and this README are in English.

## Speed

Chrome on an Apple Silicon Mac, with a 320×320 image:

| | |
|---|---|
| Prediction (all 12 bands) | about 3 seconds |
| Generation | about 6 seconds |

Both run in a Worker, so the page stays responsive.

## Licence

MIT. `vendor/` bundles, unmodified, a build artifact from
[Carnaux/NFT-Marker-Creator](https://github.com/Carnaux/NFT-Marker-Creator) (MIT), which is
itself an Emscripten build of ARToolKit5 (LGPL v3 with a linking exception). See
[LICENSE](LICENSE). The quality engine, the heatmaps and the interface are original work.

**The visual design follows NFT-Marker-Creator on purpose**, out of respect for where this came
from: the green for what you can do, the red for what you cannot press yet, and the dashed frames
around anything you drop an image into or act on. Only the greens are adjusted — `#42b983` sits at
2.5:1 on white, which is too low to read, so the light theme uses a deeper `#27795a` for text and
keeps the original green for panels and borders.

Related:
- [Carnaux/NFT-Marker-Creator](https://github.com/Carnaux/NFT-Marker-Creator) (upstream)
- [kidsnz/NFT-Marker-Creator](https://github.com/kidsnz/NFT-Marker-Creator) (preservation fork,
  identical to upstream)
