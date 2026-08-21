# Scanner

Photograph pages with a camera, watch the page edges get picked out live, then
export the lot as one clean, compressed PDF.

- **Live edge detection.** The outline is drawn over the camera feed as you
  move, so you can see what will be cropped before you take the shot.
- **Perspective correction.** The detected quadrilateral is flattened into a
  head-on rectangle, so a photo taken at an angle comes out square.
- **Document clean-up.** Shadows and uneven lighting are divided out, paper goes
  white, ink goes dark, and the page is sharpened.
- **Real compression.** Pure black-and-white pages are stored with CCITT Group 4
  (the fax codec, lossless) and land around 5 kB each. Everything else is JPEG,
  embedded without re-encoding. There is an optional hard cap on the file size.

## Getting started

You need Node 20+ and Python 3.10+.

```bash
npm install
```

```bash
npm run setup
```

```bash
npm run dev
```

Then open <http://localhost:3000>. `npm run setup` builds the Python virtualenv
under `server/.venv`; `npm run dev` starts the Next.js UI on port 3000 and the
Python vision service on port 8000 together.

Camera access needs a secure context. `localhost` counts, so local development
is fine; if you serve this to another device, it has to be over https.

No camera? The **Import** button takes photos from disk and runs them through
exactly the same pipeline.

## How it works

Two processes:

| | |
|---|---|
| **Next.js** (port 3000) | Camera capture, the edge overlay, corner editing, export controls. |
| **Python + OpenCV** (port 8000) | Every piece of image processing: detection, de-warping, enhancement, PDF assembly. |

The browser only ever talks to port 3000 — `next.config.ts` rewrites
`/api/py/*` through to the Python service, so there is no CORS preflight on the
detection loop.

### Why detection runs on the server

The live overlay works by posting a small 480px JPEG of each camera frame to
`/detect` about eight times a second. On localhost that round-trips in roughly
15 ms, which is well inside a frame.

The alternative is shipping OpenCV.js to the browser, which costs a ~9 MB WASM
download and then leaves you maintaining two implementations of the same
algorithm that will drift apart. Doing it this way means the outline you line
the page up against is drawn by exactly the code that will crop it.

### The pipeline

1. **Detect** (`server/cv_utils.py`) — the frame is reduced to ~720px and run
   through several edge maps: auto-thresholded Canny at two sensitivities, plus
   an Otsu pass that catches light paper on a dark desk where the gradient is
   weak. Contours are reduced to 4-point polygons and scored on area,
   squareness and aspect. A big morphological close beforehand dissolves the
   text so the search locks onto the sheet outline, not the words on it.
2. **De-warp** — `getPerspectiveTransform` onto a rectangle sized from the
   quad's own edge lengths. Output is never upscaled past the detail actually
   present in the photo, because inventing pixels only inflates the PDF.
3. **Enhance** — the illumination field (shadows, vignetting, paper tint) is
   estimated on a thumbnail with a morphological close, then divided out. That
   one step does most of the work of making a photo look like a scan. Then per
   mode: CLAHE and a percentile stretch, an edge-preserving denoise, and an
   unsharp mask; or Sauvola local thresholding for 1-bit output.
4. **Compress** (`server/pdf_utils.py`) — each page picks its own codec, and
   `img2pdf` embeds the bytes without recompressing them.

### Modes

| Mode | What it does | Typical size |
|---|---|---|
| Colour | White paper, saturated ink, sharpened | ~200 kB/page |
| Greyscale | Neutral, stored as single-channel JPEG | ~190 kB/page |
| Black & white | Sauvola threshold, CCITT Group 4, lossless | ~5 kB/page |
| Original | Straighten only, no clean-up | varies |

### Capping the file size

Tick **Cap the file size** and the exporter walks quality down first, then
resolution — quality mostly discards invisible noise, while resolution is detail
you cannot get back.

Rather than re-encoding the whole document at each of the 20 rungs, it searches
by encoding a single representative page, then does one full pass at the rung it
found. On a six-page document that is one full pass instead of thirteen. If the
target turns out to be unreachable you still get the smallest version it managed,
and the UI says so rather than pretending it succeeded.

## Checking it works

```bash
cd server && .venv/Scripts/python selftest.py --keep
```

This synthesises a photograph of a page — text, camera angle, uneven lighting,
sensor noise — then runs the whole pipeline over it and checks detection
accuracy against the known corners, timings, ink coverage, output sizes and the
size-cap ladder. `--keep` writes the intermediate images to `server/.selftest/`
so you can look at what each stage did.

On POSIX the interpreter is `.venv/bin/python`.

## Where things live

```
app/page.tsx            Layout and orchestration
components/
  CameraStage.tsx       Camera, detection loop, shutter
  PageEditor.tsx        Corner dragging, magnifier, result preview
  QuadOverlay.tsx       The outline, dim mask and corner ticks
  PageStrip.tsx         Thumbnails, reordering
  ExportPanel.tsx       Mode, resolution, quality, size cap, download
lib/
  api.ts                Typed client for the Python service
  geometry.ts           Quad maths: letterboxing, convexity, smoothing
  store.ts              Zustand store, persisted to localStorage
server/
  main.py               FastAPI routes
  cv_utils.py           Detection, de-warping, enhancement
  pdf_utils.py          Per-page codec choice, PDF assembly, size cap
  store.py              Session scratch storage
```

Scanned pages live in `server/.data/sessions/<id>/` and are swept after 24
hours. The browser keeps the page list in `localStorage`, so a refresh does not
lose your scan; pages whose files have already been swept are dropped on load.

## Running it as a service (PM2)

`ecosystem.config.js` defines both processes. From a fresh clone:

```bash
npm install
```
```bash
npm run setup
```
```bash
npm run build
```
```bash
pm2 start ecosystem.config.js
```
```bash
pm2 save
```

`npm run build` has to come first: the `/api/py/*` rewrite is baked into the
build, not read at start-up.

Four things that will bite you otherwise:

- **No `--reload` on the uvicorn args.** It forks a reloader parent plus a
  server child and PM2 only tracks the parent, so a restart leaves the child
  holding port 8000 and silently serving stale code. PM2 is the restarter now.
- **Not `next dev`.** The build above plus `next start` is the production path;
  `next dev` also spawns children PM2 will not clean up.
- **Keep `instances: 1` and fork mode.** Cluster mode would fork the Python app,
  which cannot share its port that way, and scanned pages live on that
  machine's disk under `server/.data/`.
- **Boot persistence on Windows needs help.** `pm2 startup` does not support
  Windows; [pm2-installer](https://github.com/jessety/pm2-installer) registers
  PM2 as a proper service. A Task Scheduler entry running `pm2 resurrect` works
  as a fallback, but only once a user logs in.

After pulling changes, rebuild before restarting or you will re-serve the old
bundle:

```bash
npm run build
```
```bash
pm2 restart ecosystem.config.js
```

## Hosting the backend on IIS

IIS cannot run an ASGI application itself. `server/web.config` uses
**HttpPlatformHandler**, which starts uvicorn as a child process, assigns it a
free port, and reverse-proxies to it. IIS owns the process lifecycle, so this
replaces PM2 for the backend — running both means two copies fighting over the
same port.

**Prerequisites.** IIS with
[HttpPlatformHandler 1.2](https://www.iis.net/downloads/microsoft/httpplatformhandler)
installed, plus `npm run setup` already run so `server/.venv` exists.

**Set it up.**

1. Create a new IIS **site** (or an application under an existing one) with its
   physical path set to the `server` directory, bound to port 8000. Keeping it
   on 8000 means the frontend needs no reconfiguration.
2. Set its application pool to **No Managed Code** — this is not a .NET app.
3. In the pool's Advanced Settings, set **Start Mode** to `AlwaysRunning` and
   **Idle Time-out** to `0`. Otherwise IIS kills the Python process after 20
   idle minutes and the next scan pays a cold OpenCV import.
4. Grant the pool identity (`IIS AppPool\<pool name>` by default):
   - **Read & execute** on `server`, including `server\.venv`
   - **Modify** on `server\.data` and on `logs`

**Check it.**

```bash
curl http://127.0.0.1:8000/health
```

If that fails, `logs\cv-iis.log` has uvicorn's stdout — the usual causes are the
pool identity lacking execute permission on the virtualenv, or `npm run setup`
never having been run.

**The frontend still needs a host.** IIS here serves only the API. Either keep
`scanner-web` under PM2, or put the Next.js app behind IIS as well using ARR and
URL Rewrite. Whichever you choose, `PY_API_URL` has to match the address IIS
exposes *at build time* — see the note at the end of the next section.

**Two settings in `web.config` worth knowing about.** `maxAllowedContentLength`
is raised to 40 MB to match the service's own upload limit; IIS otherwise
rejects bodies over 30 MB with a 404.13 before the request reaches the app. And
`SCANNER_DATA_DIR` exists because the pool identity usually cannot write inside
the site directory — point it at a directory you have granted Modify on.

## Running the vision service elsewhere

The service is a plain FastAPI app, so it can live on a different machine from
the UI:

```bash
PY_API_URL=http://192.168.0.50:8000 npm run web
```

On that machine, bind it publicly with `API_HOST=0.0.0.0 npm run api`. CORS is
already open, so a phone on the same network can also point straight at port
8000. There is no authentication — keep it on a trusted network.

## Things worth knowing if you extend it

- **Quads are normalised.** Every quad crossing the API is in 0..1 of the image,
  in TL, TR, BR, BL order. That is what lets the browser scale one detection
  result to a thumbnail, a full-size editor and the export without conversions.
- **The overlay maths uses the content rect, not the element rect.** A video or
  image under `object-fit: contain` is letterboxed inside its box;
  `contentRect()` in `lib/geometry.ts` is what keeps the outline on the page.
- **Don't guess whether an image is 1-bit after resizing it.** A document page
  is naturally over 90% pure black and pure white, so that test also matches
  ordinary colour scans and will silently flatten them. Decide from the
  original and pass the answer down — `_prepare()` takes it as an argument, and
  `selftest.py` guards against the regression.
- **`/detect` takes a raw body, not multipart.** It is called many times a
  second and multipart parsing is pure overhead at that rate.

Natural things to add next: OCR (Tesseract over the de-warped page, written back
as an invisible PDF text layer), auto-capture once the outline holds steady, and
multi-page batch splitting.
