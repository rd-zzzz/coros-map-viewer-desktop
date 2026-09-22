# MapViewer

[中文](README.md) | **English**

An offline PMTiles map viewer built on Tauri 2 + MapLibre GL JS for loading and browsing VCM (contour lines), VSM (vector terrain), and generic `.pmtiles` map data.

## Background

VCM (contour) and VSM (vector feature) map data originate from the offline map packs of COROS sport watches. These files use the `.t` extension and are actually stored in the PMTiles V3 format. Since the watch itself provides no way to directly inspect or debug map content, this project was developed to conveniently browse and verify the map tile data on a desktop computer.

## Requirements

Given a batch of `.t` map tile files extracted from a COROS watch (or generic `.pmtiles` files), build a desktop viewer that can run fully offline, load tiles in batch, and render on demand.

Core technology stack:

| Layer | Technology | Responsibility |
|---|---|---|
| Desktop shell | Tauri 2 (Rust) | Window management, system integration, packaged as a single-file exe |
| Map rendering | MapLibre GL JS 4.7 | WebGL vector tile rendering engine |
| Tile protocol | PMTiles JS 4.4 | Parses PMTiles V3 format, reads tiles on demand by offset/length (via Rust IPC locally, not HTTP) |
| Fonts / Icons | Noto Sans + custom COROS sprite | Local offline text labels; blue round POI icons (generated at build time) |

## Data Format

### PMTiles V3

Each `.t` or `.pmtiles` file is essentially a standard PMTiles V3 archive, consisting of five sections:

```
+--------+----------------+----------+------------------+-----------+
| Header | Root Directory | Metadata | Leaf Directories | Tile Data |
| 127B   |   (gzip)       |  (JSON)  |   (gzip)         |  (MVT)   |
+--------+----------------+----------+------------------+-----------+
```

- **Header** (127 bytes): magic number `PMTiles` + version + offset/length of each section + zoom level range + geographic bounding box
- **Root Directory**: tile index using Hilbert-curve-encoded tileID for binary search
- **Metadata**: JSON format, contains `vector_layers` array (layer names, field definitions, zoom ranges)
- **Tile Data**: actual tiles in MVT (Mapbox Vector Tiles) format, GZIP compressed

### VCM vs VSM

| Property | VCM (Contour) | VSM (Vector Features) |
|---|---|---|
| File naming | Starts with `C`, e.g. `C1213032V00.t` | Starts with `S`, e.g. `S1213032V00.t` |
| Tile type | MVT | MVT |
| Compression | GZIP | GZIP |
| Zoom levels | z9 - z13 | z8 - z13 |
| Vector layers | 1: `Q` (field: `F` numeric, elevation value) | 11: `J`, `K`, `P`, `L`, `N`, `O`, `B`, `A`, `I`, `F`, `H` |
| Content | Contour lines with elevation labels along the lines | Roads, water, land cover, place names, POIs and other features (no separate building layer) |
| Coverage | Partitioned by subdirectory (121, 123, 130, 131, 132) | Same as VCM, one-to-one correspondence with VCM files |

By decoding real tiles, the semantics of the VSM layers and the field `E` (classification code) have been confirmed. Besides `E`, the common fields are: `X` (name), `C` (code), `N` (name/code), `b` (bridge), `j` (tunnel), `i` (pedestrian-street / park-path subclass of `L` E13), `F` (elevation, `H` layer only), `c` (extra field on `H`). The actual field sets per layer are `J{E,X}`, `K{E,X}`, `P{C,E,N,X}`, `L{C,E,X,b,i,j}`, `N{E,N}`, `O{E,X}`, `B{E}`, `A{E,X}`, `I{E,X}`, `F{E}`, `H{E,F,X,c}`:

| Layer | Geometry | Semantics (`E` codes) |
|---|---|---|
| `L` | Line/Polygon | Roads: 7/19/20 motorway, 8/9 arterial, 10 secondary, 11–16/21/22/23 local, 0 path, 29 hiking trail, 2 railway, 3 metro/BRT |
| `F` | Polygon | Land cover: 1 forest, 2 rail corridor, 4 farmland, 7 urban park/green space |
| `N` | Polygon | Water bodies (rivers, lakes, reservoirs, ponds) |
| `P` / `O` | Line | Low / high zoom water lines |
| `K` | Point | POIs: 1 convenience, 4 golf, 5 fast food, 6 park, 7 bus stop, 8 train station, 11 campsite, 13 supermarket, 19 cafe, 22 bar, 25 hospital, 27 attraction, 30 stadium, 36 fuel, 52 parking; unlisted codes fall back to a generic dot icon |
| `J` | Point | Administrative place names (city, district, town, village, street) |
| `H` / `A` | Point | Peaks (`F`=elevation) / airport |
| `B` / `I` | Line/Polygon | Airport land / protected area |

## Architecture

### Overall Flow

```
User selects folder
    │
    ▼
Scan .t / .pmtiles files ──→ FileSource / DiskSource ──→ PMTiles.getHeader() + getMetadata()
    │                                                    │
    ▼                                                    ▼
Build allEntries[]                              Read bounds, zoom range, layer list
    │
    ▼
fitBounds() ──→ Force minZoom ──→ updateViewport()
                                        │
                                        ▼
                              Calculate viewport bounds + padding
                                        │
                                        ▼
                              Filter entries intersecting viewport
                              Sort by intersection area with viewport, take top 24
                                        │
                                        ▼
                         ┌────────────────┼────────────────┐
                         ▼                ▼                ▼
                     loadEntry()    unloadSource()    updateStats()
                  Register protocol  Remove layers    Update panel stats
                  + add layers       + remove sources
```

### PMTiles Protocol Bridge

MapLibre GL JS supports custom data source protocols through the `addProtocol` mechanism. This project uses the `Protocol` class bundled with the pmtiles library:

```javascript
var protocol = new pmtiles.Protocol({ metadata: true });
maplibregl.addProtocol("pmtiles", protocol.tile);
```

When MapLibre requests `pmtiles://some-key`, `protocol.tile` will:
1. Parse the URL to extract the file identifier
2. Look up the registered PMTiles instance
3. Read the Header to return source metadata (bounds, zoom range)
4. Or read the tile data at the specified z/x/y and return it to the renderer

After each local file is wrapped as a PMTiles instance, it is registered into the protocol via `protocol.add(inst)`. The identifier returned by `inst.source.getKey()` automatically becomes the key in the `pmtiles://` URL.

### Reading Local Files: Two Paths

A PMTiles JS Source only needs to implement two methods: `getKey()` and `getBytes(offset, length)`. This project provides two implementations depending on where the files come from:

| Path | Trigger | Source implementation | How bytes are read |
|---|---|---|---|
| Folder picker | Click the drop zone, `<input type="file" webkitdirectory>` | `pmtiles.FileSource(file)` | Browser File API, files read by the WebView |
| Native drag-drop | Drag files or folders from the OS file explorer | `DiskSource(path)` | On-demand Range reads via the Rust IPC command `read_file_slice` |

```javascript
// DiskSource: byte reads are performed by the Rust backend,
// so the entire file is never loaded into WebView memory.
function DiskSource(path) { this._path = path; }
DiskSource.prototype.getKey = function () { return this._path; };
DiskSource.prototype.getBytes = function (offset, length) {
    return window.__TAURI__.core.invoke("read_file_slice", {
        path: this._path, offset: offset, length: length
    }).then(function (bytes) {
        return { data: new Uint8Array(bytes).buffer };
    });
};
```

The Rust backend (`src-tauri/src/lib.rs`) exposes two IPC commands:

| Command | Function |
|---|---|
| `read_path_as_files` | Accepts a file or folder path; recursively scans folders and returns the full paths of all `.t`/`.pmtiles` files within |
| `read_file_slice` | Reads a specified byte range of a file by offset/length; the actual executor of PMTiles Range requests |

On native drag-drop, the frontend first calls `read_path_as_files` to scan directories on the Rust side (bypassing the browser's folder-upload mechanism), then creates a `DiskSource` for each path to build the index. Even with roughly 6 GB of map data, only the tile index — not file contents — resides in WebView memory.

### Viewport On-Demand Loading

With hundreds of tile files, loading them all into MapLibre at once is impractical. The core strategy:

1. **Indexing phase**: Scan all `.t` files, read Header and Metadata, store into `allEntries[]` (not loaded to the map)
2. **Viewport filtering**: On each `moveend`/`zoomend`, compute the bounding box of the current viewport + padding, perform intersection test against each entry's bounds
3. **Area sorting**: Sort by the intersection area between each tile's bounds and the viewport in descending order, prioritizing sources that cover a large part of the viewport, take the top `MAX_ACTIVE_SOURCES` (24) entries
4. **Load/Unload**: Entries newly entering the viewport call `loadEntry()` (register protocol + add source + add layer); entries leaving the viewport call `unloadSource()` (remove layer + remove source)
5. **Zoom filtering**: Skip entries where `minZoom > currentZoom + 1` to avoid loading sources that have no tiles at the current level

```javascript
// Viewport filtering core logic
for (var i = 0; i < allEntries.length; i++) {
    var entry = allEntries[i];
    if (z >= entry.header.minZoom - 1 && boundsIntersect(entry.bounds, pv)) {
        candidates.push(entry);
    }
}
```

### Incremental Loading & Deduplication

Within one session you can pick a folder or drop files repeatedly; new files are **appended** to the existing index rather than replacing it:

- The dedup table `accumulatedNames` records indexed files by path. **The two channels use different key schemes** — the folder channel keys on `webkitRelativePath || name`, the native drag-drop channel on the full disk path. Mixing the schemes indexes the same file twice.
- Before indexing, a pre-scan computes `totalNew`: a file counts only if the extension is valid, it is not already deduped, and `detectType` can classify it — otherwise the progress bar never reaches 100%.
- The loop calls `yieldUI()` every 10 files (20 in the drag-drop channel) to yield the main thread, keeping the UI responsive with hundreds of files.
- `fitBounds` (and raising the zoom to the data's `globalMinZoom`) only happens when `allEntries` goes from empty to non-empty, i.e. on the first load; appending files never resets the user's current view.
- The "Clear all" button unloads every loaded source, clears `allEntries` and the dedup table, and resets the panel state.

### Rendering Strategy (semantic colors, matching the COROS watch look)

Previously colors were generated randomly by golden angle based on layer index (`(i * 137.508) % 360`). Colors are now assigned by layer semantics and the field `E`, matching the watch's light outdoor style, with two palettes (`PALETTES`, light by default). On theme switch, `applyPalette()` iterates over each source's recorded `bindings` and calls `setPaintProperty` to recolor layers live without rebuilding them.

**Roads (`L` layer)**: Each class is drawn as a casing + fill pair — motorways/arterials are peach/salmon with a deeper orange casing; secondary/local roads are white paved at high zoom (secondary around z14.5, local around z15) and thin gray lines at low zoom, and the white pavement is outlined with medium-gray casings (darker for secondary than local) so white roads do not vanish against the near-white background. Hiking trails (E29) and park paths/pedestrian streets (E13 with `i` 19/23) are medium-gray dashed lines, and paths (E0) are thin light-gray lines; both colors and widths are deliberately weaker than formal roads so low-class paths never outshine major roads. Railways are gray dashed lines, and metro/BRT lines are blue; widths are interpolated by zoom and deliberately narrowed so roadside green belts stay visible.

**Land cover and water (`F` / `N` layers)**: Forests are light green, farmland pale yellow, urban parks teal, water light blue; protected areas and airport land have their own base colors.

**POIs (`K` layer)**: Uniform blue round icons with white glyphs (sprite under `src/sprites/coros/`), generated by the build script `tools/build-coros-sprite.js`, which extracts white-glyph masks from the v4/light sprite; missing icons (hospital, parking, fuel, campsite, golf) are hand-drawn by the script.

**Text labels**: Names are read from the COROS `X` field (the standard `name` is absent). Road names follow the road line in dark gray, administrative and POI names are dark red, peak names brown, all with a white halo.

**VCM (contours, `Q` layer)**: Index/contour lines are distinguished by `F` (elevation) `% 50`, drawn as thin tan lines with fixed opacity (0.75 for intermediate, 0.9 for index). There is no hover highlight: contour elevation is inherently non-unique (in a sample of 36 z11 tiles, 43 features carried only 5 distinct elevations), so it cannot serve as a feature id — `feature-state` would light up every same-elevation line across the whole source.

**Global stacking**: All layers follow `SLOT_ORDER` (land/water → roads from local to motorway → trails/railways → icons → text, bottom to top) and are reordered by `reorderLayers()` via `moveLayer`, keeping multi-source stacking consistent; the reorder runs once per viewport refresh instead of once per source.

Generic `.pmtiles` files do not use the semantic colors above; they keep the geometry-based random-color fallback rendering.

### Automatic File Type Detection

Determined by both file path and file name:

```javascript
function detectType(file) {
    var path = file.webkitRelativePath || file._dropPath || "";
    if (/[/\\]VCM[/\\]/i.test(path)) return "vcm";  // Path contains VCM directory
    if (/[/\\]VSM[/\\]/i.test(path)) return "vsm";  // Path contains VSM directory
    if (/^C\d/i.test(file.name)) return "vcm";       // Starts with C
    if (/^S\d/i.test(file.name)) return "vsm";       // Starts with S
    if (file.name.toLowerCase().endsWith(".pmtiles")) return "generic";  // .pmtiles file
    return null;
}
```

## Project Structure

```
map viewer/
├── src/                          # Frontend assets (served directly by Tauri)
│   ├── index.html                # Single frontend file, contains all HTML/CSS/JS
│   ├── maplibre-gl.js            # MapLibre GL JS 4.7.1 (local)
│   ├── maplibre-gl.css           # MapLibre GL JS stylesheet (local)
│   ├── pmtiles.js                # PMTiles JS 4.4.1 (local)
│   ├── fonts/                    # Noto Sans fonts (local offline)
│   │   ├── OFL.txt               # Font license (OFL-1.1)
│   │   ├── Noto Sans Regular/    # Primary label font
│   │   ├── Noto Sans Medium/
│   │   ├── Noto Sans Italic/
│   │   └── Noto Sans Devanagari Regular v1/
│   └── sprites/                  # Map sprites (local, offline)
│       ├── v3/                   # Legacy Protomaps sprites (black/light/dark/white/grayscale)
│       ├── v4/                   # Protomaps colored badge sprites (black/light/dark/white/grayscale)
│       └── coros/                # Build-generated blue round POI sprite (sprite.png/json + @2x)
│
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml                # Rust dependency configuration
│   ├── Cargo.lock                # Rust dependency lock file
│   ├── tauri.conf.json           # Tauri window/packaging configuration
│   ├── build.rs                  # Tauri build script
│   ├── gen/schemas/              # Auto-generated permission and configuration schemas
│   ├── capabilities/
│   │   └── default.json          # Window operation permissions (minimize/maximize/close/drag)
│   ├── icons/
│   │   ├── icon.ico              # Windows icon
│   │   ├── icon.icns             # macOS icon
│   │   ├── icon.png              # Generic icon
│   │   ├── android/              # Android icon set (hdpi ~ xxxhdpi)
│   │   └── ios/                  # iOS icon set
│   └── src/
│       ├── main.rs               # Entry point, calls lib::run()
│       └── lib.rs                # Tauri Builder initialization + Rust IPC commands
│
├── package.json                  # Node.js dependencies (only @tauri-apps/cli)
├── Map/                          # Local map data (not committed): VCM/, VSM/ regional .t files
├── tools/                        # Build-time/analysis scripts (not part of app runtime), incl. COROS sprite builder
└── ...                           # README / AGENTS.md, etc.
```

### Why a Single-File Frontend

Tauri's `frontendDist` points to the `src/` directory. `index.html` references co-located JS/CSS/font/sprite assets via relative paths. The embedded WebView in Tauri reads directly from the local filesystem — no bundler (webpack/vite) required, no network requests needed.

All external CDN dependencies have been localized:
- `https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js` → `maplibre-gl.js`
- `https://unpkg.com/pmtiles@4.4.1/dist/pmtiles.js` → `pmtiles.js`
- `https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf` → `fonts/{fontstack}/{range}.pbf`
- `https://protomaps.github.io/basemaps-assets/sprites/v4/black` → `sprites/v4/black`

## UI Components

| Component | Position | Function |
|---|---|---|
| Custom title bar | Top 36px | App name + drag area + minimize/maximize/close buttons |
| Control panel | Top-left | Folder selection (dashed drag area, supports native drag-drop), VCM toggle, light/dark theme toggle, statistics cards (indexed / active / zoom), progress bar, clear all button; panel is collapsible |
| Zoom widget | Top-right | Unified zoom component: zoom level display + zoom in/out buttons + scale bar |
| Attribute inspector | Bottom-left | Attribute table shown on feature click, supports copy-all; translucent area features never shadow line/point features |
| Debug log | Bottom-right | Hidden by default, toggled via circular button; error lines get a red left border and warnings a yellow one, 80 lines kept at most |
| Status bar | Bottom 28px | Mouse coordinates, current tile z/x/y, loading status indicator |

### Window Customization

Tauri is configured with `decorations: false` to remove the system title bar, replaced by an HTML-rendered title bar. Window controls are invoked via Tauri's `__TAURI__` global object:

```javascript
var appWindow = window.__TAURI__.window.getCurrentWindow();
document.getElementById("btn-min").onclick = function () { appWindow.minimize(); };
document.getElementById("btn-max").onclick = function () { appWindow.toggleMaximize(); };
document.getElementById("btn-close").onclick = function () { appWindow.close(); };
```

## Building

### Prerequisites

- Rust 1.70+ (recommended installation via [rustup](https://rustup.rs/))
- Node.js 18+
- Windows 10/11 (WebView2 runtime, built-in since Win10 20H2+)

### Build Steps

```bash
npm install
npx tauri build
```

The first build downloads and compiles Rust dependencies (Tauri + wry + tao), taking approximately 2-3 minutes. Subsequent incremental builds take about 30 seconds.

### Build Artifacts

| File | Size | Description |
|---|---|---|
| `src-tauri/target/release/map-app.exe` | ~8.7 MB | Portable executable, can be run directly |
| `src-tauri/target/release/bundle/nsis/MapViewer_0.2.1_x64-setup.exe` | ~6.8 MB | NSIS installer |

### Development Mode

```bash
npx tauri dev
```

Starts a development server (built-in static server of the Tauri CLI). Changes to frontend files under `src/` trigger an automatic full-page reload in the WebView; changes to Rust code trigger an automatic recompilation and app restart.

## Release Optimization

Release profile configuration in `Cargo.toml`:

```toml
[profile.release]
strip = true        # Strip debug symbols
lto = true          # Link-time optimization
codegen-units = 1   # Single compilation unit for better optimization
opt-level = "s"     # Optimize for size over speed
panic = "abort"     # Abort on panic, reducing binary size
```

## Data Acquisition

The map data is stored in the `map` folder on the internal storage of a COROS watch, containing two subdirectories: `VCM` and `VSM`. Copy the entire `map` folder to your computer, then select it in the application to load and browse the maps. During development you can also place it directly in the project root (`Map/`, already ignored by `.gitignore`).

> Note: The map data files are large (approximately 6 GB) and are not included in this repository. Please extract them from your watch directly. As of v0.2.0, generic `.pmtiles` format files are also supported.

## Data Directory Structure

The program supports two folder selection methods:

**Method 1: Select the root directory containing VCM/VSM subdirectories**

```
Map/
├── VCM/
│   ├── 121/
│   │   ├── C1213032V00.t
│   │   └── ...
│   ├── 123/
│   └── 130/
└── VSM/
    ├── 121/
    │   ├── S1213032V00.t
    │   └── ...
    ├── 123/
    └── 130/
```

**Method 2: Directly select the VCM or VSM folder**

The program automatically scans all `.t` and `.pmtiles` files and classifies them based on `VCM`/`VSM` in the path, `C`/`S` file name prefix, or `.pmtiles` extension.

## Dependencies

| Dependency | Version | Purpose | License |
|---|---|---|---|
| Tauri | 2.x | Desktop application framework | MIT/Apache-2.0 |
| MapLibre GL JS | 4.7.1 | Vector tile WebGL rendering | BSD-3-Clause |
| pmtiles (JS) | 4.4.1 | PMTiles format parsing + MapLibre protocol adapter | BSD-3-Clause |
| Noto Sans | - | Map text label font | OFL-1.1 |
| Protomaps Basemaps Assets | - | Sprites (icons, road shields) | BSD-3-Clause / CC0 |

## License

This project's code is licensed under the MIT License. Use of map data is subject to the respective vendor's license agreement.
