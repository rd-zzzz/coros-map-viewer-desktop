# MapViewer

[中文](README.md) | **English**

An offline PMTiles map viewer built on Tauri 2 + MapLibre GL JS for loading and browsing VCM (contour lines) and VSM (vector terrain) map data.

## Background

VCM (contour) and VSM (vector feature) map data originate from the offline map packs of COROS sport watches. These files use the `.t` extension and are actually stored in the PMTiles V3 format. Since the watch itself provides no way to directly inspect or debug map content, this project was developed to conveniently browse and verify the map tile data on a desktop computer.

## Requirements

Given a batch of `.t` map tile files extracted from a COROS watch, build a desktop viewer that can run fully offline, load tiles in batch, and render on demand.

Core technology stack:

| Layer | Technology | Responsibility |
|---|---|---|
| Desktop shell | Tauri 2 (Rust) | Window management, system integration, packaged as a single-file exe |
| Map rendering | MapLibre GL JS 4.7 | WebGL vector tile rendering engine |
| Tile protocol | PMTiles JS 4.4 | Parses PMTiles V3 format, reads tiles on demand via HTTP Range Requests |
| Fonts / Icons | Noto Sans + Protomaps Sprites | Local offline text labeling and map symbols |

## Data Format

### PMTiles V3

Each `.t` file is essentially a standard PMTiles V3 archive, consisting of five sections:

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
| Content | Contour lines with elevation labels along the lines | Roads, rivers, buildings, place names and other geographic features |
| Coverage | Partitioned by subdirectory (121, 123, 130, 131, 132) | Same as VCM, one-to-one correspondence with VCM files |

VSM layer fields include `E` (numeric), `X` (string/name), `C`, `N`, `b`, `i`, `j`, `F`, etc. Refer to the data vendor documentation for exact semantics.

## Architecture

### Overall Flow

```
User selects folder
    │
    ▼
Scan .t files ──→ pmtiles.FileSource(file) ──→ PMTiles.getHeader() + getMetadata()
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
                              Sort by distance to center, take top 24
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

Each local file is wrapped as a PMTiles instance via `pmtiles.FileSource(file)`, then registered into the protocol via `protocol.add(inst)`. The identifier returned by `inst.source.getKey()` automatically becomes the key in the `pmtiles://` URL.

### Viewport On-Demand Loading

With hundreds of tile files, loading them all into MapLibre at once is impractical. The core strategy:

1. **Indexing phase**: Scan all `.t` files, read Header and Metadata, store into `allEntries[]` (not loaded to the map)
2. **Viewport filtering**: On each `moveend`/`zoomend`, compute the bounding box of the current viewport + padding, perform intersection test against each entry's bounds
3. **Distance sorting**: Sort by the distance from each tile's bounding box center to the viewport center, take the nearest `MAX_ACTIVE_SOURCES` (24) entries
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

### Rendering Strategy

Different rendering approaches are used based on VCM/VSM type:

**VCM (Contour)**: Creates only `line` layers. Colors are assigned by golden angle based on the layer index (`(i * 137.508) % 360`), and line width is interpolated by zoom level.

**VSM (Vector Features)**: Creates 5 types of layers by geometry type:
- `fill`: Polygon fill with hover transparency change
- `line` (LineString): Line features, bolded on hover
- `line` (Polygon outline): Polygon borders
- `circle`: Point features, radius interpolated by zoom level
- `symbol`: Text labels, reads the `name` or `X` field, uses local Noto Sans font

### Automatic File Type Detection

Determined by both file path and file name:

```javascript
function detectType(file) {
    var path = file.webkitRelativePath || "";
    if (/[/\\]VCM[/\\]/i.test(path)) return "vcm";  // Path contains VCM directory
    if (/[/\\]VSM[/\\]/i.test(path)) return "vsm";  // Path contains VSM directory
    if (/^C\d/i.test(file.name)) return "vcm";       // Starts with C
    if (/^S\d/i.test(file.name)) return "vsm";       // Starts with S
    return null;
}
```

## Project Structure

```
map-app/
├── src/                          # Frontend assets (served directly by Tauri)
│   ├── index.html                # Single frontend file, contains all HTML/CSS/JS
│   ├── maplibre-gl.js            # MapLibre GL JS 4.7.1 (local)
│   ├── maplibre-gl.css           # MapLibre GL JS stylesheet (local)
│   ├── pmtiles.js                # PMTiles JS 4.4.1 (local)
│   ├── fonts/                    # Noto Sans fonts (local offline)
│   │   ├── Noto Sans Regular/    # Primary label font
│   │   ├── Noto Sans Medium/
│   │   ├── Noto Sans Italic/
│   │   └── Noto Sans Devanagari Regular v1/
│   └── sprites/                  # Map sprites (local offline)
│       └── v4/
│           ├── black.json/png    # Dark theme sprites
│           ├── light.json/png
│           ├── dark.json/png
│           ├── white.json/png
│           └── grayscale.json/png
│
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml                # Rust dependency configuration
│   ├── tauri.conf.json           # Tauri window/packaging configuration
│   ├── build.rs                  # Tauri build script
│   ├── capabilities/
│   │   └── default.json          # Window operation permissions (minimize/maximize/close/drag)
│   ├── icons/
│   │   └── icon.ico              # Application icon
│   └── src/
│       ├── main.rs               # Entry point, calls lib::run()
│       └── lib.rs                # Tauri Builder initialization
│
├── package.json                  # Node.js dependencies (only @tauri-apps/cli)
└── docs/
    └── ui-beautification-plan.md # UI beautification plan document
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
| Control panel | Top-left | Folder selection (dashed drag area), VCM toggle (sliding switch), statistics cards (indexed/loaded/zoom), progress bar |
| Zoom display | Top-right | Current zoom level (Z format, two decimal places) |
| Attribute inspector | Bottom-left | Attribute table shown on feature click, supports copy-all |
| Debug log | Bottom-right | Hidden by default, toggled via circular button, error lines marked with red left border |
| Status bar | Bottom 28px | Mouse coordinates, current tile z/x/y, loading status indicator |

### Window Customization

Tauri is configured with `decorations: false` to remove the system title bar, replaced by an HTML-rendered title bar. Window controls are invoked via Tauri's `__TAURI__` global object:

```javascript
var appWindow = window.__TAURI__.window.getCurrentWindow();
btn-min.onclick = function () { appWindow.minimize(); };
btn-max.onclick = function () { appWindow.toggleMaximize(); };
btn-close.onclick = function () { appWindow.close(); };
```

## Building

### Prerequisites

- Rust 1.70+ (recommended installation via [rustup](https://rustup.rs/))
- Node.js 18+
- Windows 10/11 (WebView2 runtime, built-in since Win10 20H2+)

### Build Steps

```bash
cd map-app
npm install
npx tauri build
```

The first build downloads and compiles Rust dependencies (Tauri + wry + tao), taking approximately 2-3 minutes. Subsequent incremental builds take about 30 seconds.

### Build Artifacts

| File | Size | Description |
|---|---|---|
| `src-tauri/target/release/map-app.exe` | ~8.6 MB | Portable executable, can be run directly |
| `src-tauri/target/release/bundle/nsis/MapViewer_0.1.0_x64-setup.exe` | ~6.7 MB | NSIS installer |

### Development Mode

```bash
npx tauri dev
```

Starts a development server. Changes to `src/index.html` trigger automatic hot reload.

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

The map data is stored in the `map` folder on the internal storage of a COROS watch, containing two subdirectories: `VCM` and `VSM`. Copy the entire `map` folder to your computer, then select it in the application to load and browse the maps.

> Note: The map data files are large (approximately 6 GB) and are not included in this repository. Please extract them from your watch directly.

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

The program automatically scans all `.t` files and classifies them based on `VCM`/`VSM` in the path or `C`/`S` file name prefix.

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
