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

One of two ways to run this on a persistent machine — the other is
[IIS](#running-it-on-iis). Pick one: both start the same two processes on the
same two ports, so running them together just produces a port conflict. PM2 is
the simpler option; choose IIS if you already terminate TLS there or need the
site alongside others.

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

## Running it on IIS

IIS cannot host Node or ASGI applications itself. Both halves are started by
**HttpPlatformHandler**, an IIS module that runs your process, assigns it a
private port, and reverse-proxies to it. Two config files are already in the
repository:

| File | Site | Runs |
|---|---|---|
| `web.config` | frontend, physical path = repository root | `next start` |
| `server/web.config` | backend, physical path = `server` | `uvicorn main:app` |

This **replaces PM2**. Running both means two copies of each service fighting
over the same ports.

The example below uses `D:\scanner` as the repository path and `scanner` /
`scanner-api` as the site names. Substitute your own throughout.

### Before you start

- IIS, with
  [HttpPlatformHandler 1.2](https://www.iis.net/downloads/microsoft/httpplatformhandler)
  installed. Check for it under *IIS Manager to server node to Modules*.
- Node 20+ and Python 3.10+ on the machine's `PATH`.
- Confirm where Node lives:

```
where node
```

If it is not `C:\Program Files\nodejs\node.exe`, edit `processPath` in the root
`web.config` to match.

### 1. Build the app

```
npm install
```
```
npm run setup
```
```
npm run build
```

`npm run build` is not optional: `next start` refuses to boot without a
production build, and the `/api/py/*` rewrite is baked in at build time rather
than read at start-up.

Create the scratch directory the backend writes into:

```
mkdir D:\scanner\server\.data
```

### 2. Create the backend site

In IIS Manager, *Sites to Add Website*:

- **Site name:** `scanner-api`
- **Physical path:** `D:\scanner\server`
- **Binding:** http, **IP address `127.0.0.1`**, port `8000`

Binding to `127.0.0.1` rather than *All Unassigned* matters. The backend has no
authentication, and the frontend reaches it over the loopback interface — there
is no reason for it to be reachable from the network.

### 3. Create the frontend site

*Sites to Add Website* again:

- **Site name:** `scanner`
- **Physical path:** `D:\scanner`
- **Binding:** https, port 443 — see step 6 before choosing http

### 4. Configure both application pools

For **each** of the two pools, in *Application Pools to Basic Settings*:

- **.NET CLR version: No Managed Code.** Neither app is .NET.

Then *Advanced Settings*:

- **Start Mode: AlwaysRunning**
- **Idle Time-out (minutes): 0**

Without those last two, IIS shuts the worker down after 20 idle minutes and the
next scan pays a cold start — several seconds while OpenCV and numpy import.

### 5. Grant permissions

Application pools run as `IIS AppPool\<pool name>`, which by default cannot read
your repository or write anywhere in it. From an elevated prompt:

```
icacls "D:\scanner" /grant "IIS AppPool\scanner":(OI)(CI)RX /T
```
```
icacls "D:\scanner\server" /grant "IIS AppPool\scanner-api":(OI)(CI)RX /T
```
```
icacls "D:\scanner\server\.data" /grant "IIS AppPool\scanner-api":(OI)(CI)M /T
```
```
icacls "D:\scanner\logs" /grant "IIS AppPool\scanner":(OI)(CI)M /T
```
```
icacls "D:\scanner\logs" /grant "IIS AppPool\scanner-api":(OI)(CI)M /T
```

`RX` is read and execute — the backend pool needs it on `server\.venv` to run
the interpreter at all. `M` is modify, needed for the scratch store and the
stdout logs.

### 6. HTTPS, or the camera will not work

Browsers only expose `getUserMedia` in a **secure context**. `localhost` is
exempt, so browsing to `http://localhost` on the server itself is fine. From any
other machine over plain http the camera silently never appears and only the
**Import** button works — the app will look broken rather than report an error.

So if anyone will use this from another device, give the frontend site an https
binding. A self-signed certificate is enough for a LAN, though each client will
have to accept the warning once:

```
New-SelfSignedCertificate -DnsName "scanner.local" -CertStoreLocation "cert:\LocalMachine\My"
```

Then bind it under *Site to Bindings to Add to https*, and install the
certificate into *Trusted Root Certification Authorities* on the client
machines.

### 7. Check it

Backend, from the server itself:

```
curl http://127.0.0.1:8000/health
```

Expected: `{"ok":true,"opencv":"5.0.0","service":"scanner-cv"}`

Frontend, end to end — this goes through IIS, Next.js and its rewrite into the
backend, so a healthy answer means the whole chain is wired up:

```
curl https://localhost/api/py/health
```

Then open the site in a browser. The header shows a red *Vision service offline*
banner if the frontend cannot reach the backend.

### When something does not work

The first request after a restart is slow — HttpPlatformHandler is booting the
child process. After that:

| Symptom | Where to look |
|---|---|
| **502.5** on first request | The child process failed to start. `logs\web-iis.log` or `logs\cv-iis.log` has its stdout. |
| Backend 502, empty log | Pool identity cannot execute `server\.venv\Scripts\python.exe`. Re-check step 5. |
| Frontend 502, log says no production build | `npm run build` was not run, or was run as a different user and the output is unreadable. |
| **404.13** when adding a page | A photo exceeded the request limit. Both configs set 40 MB; check neither was reverted. |
| *Vision service offline* banner | The backend site is stopped, or not bound to `127.0.0.1:8000`. |
| Camera never appears | Not a secure context. See step 6. |
| Everything 503 | The application pool stopped, usually after repeated start failures. Start it again once the underlying error is fixed. |

### After pulling changes

```
npm run build
```

Then *Restart* both sites in IIS Manager. Restarting without rebuilding
re-serves the old bundle.

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
