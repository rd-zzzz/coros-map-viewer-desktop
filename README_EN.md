# MapViewer

[中文](README.md) | **English**

A fully offline Windows desktop map viewer for browsing the offline maps of COROS sport watches on a PC; it also opens regular `.pmtiles` files. Built with Tauri 2 + MapLibre GL JS.

## Background

COROS watches keep their offline maps in a `map` folder on the watch storage, split into `VCM` (contour lines) and `VSM` (roads, water, place names, POIs and other vector features). Every file carries a `.t` extension, but they are really PMTiles V3 archives in disguise. The watch itself offers no way to inspect them, so I wrote this tool: drop the map pack into the window and browse it on the PC.

## Usage

Copy the whole `map` folder off the watch (about 6 GB), then either:

- click the dashed area at the top-left to pick a folder;
- or drag files / folders straight from Explorer into the window.

Both the root folder (the one containing `VCM` and `VSM`) and the `VCM` / `VSM` subfolders work — files are scanned recursively. Once indexing finishes, the view zooms to the data, and only tiles near the current viewport are loaded as you pan around.

You can keep adding files in the same session; duplicates are skipped automatically. The file list shows every indexed file grouped by type, and clicking one flies you to its area. Indexing can also be cancelled midway.

## How it works

**No full-file loads.** The drag-drop path reads byte ranges from the Rust side — at runtime PMTiles only needs the header, the directory index and the tiles in the current viewport — so file contents never sit in WebView memory, even with a 6 GB pack. The folder picker uses the browser File API instead.

**Index first, render later.** At startup only each file's header and metadata (bounds, zoom range, layer list) are read; nothing is drawn yet. On every pan or zoom, sources are ranked by the intersection area of their bounds with the viewport, at most 24 are active, and those out of view are unloaded.

**Colors follow the watch.** Roads get class-specific casing and fill; minor roads and trails are deliberately darker and thinner so they can't outshine the main roads. POIs share one set of blue round icons and appear in tiers by importance, keeping cities from turning into a mess. Contours distinguish intermediate and index lines, with elevation labels on the index lines. Colors come from layer semantics, with light and dark palettes; switching themes recolors in place. Generic `.pmtiles` have none of this and fall back to random colors by geometry.

Also: the title bar is custom-drawn, window position and size are remembered by the window-state plugin, every library / font / sprite is local so the app makes no network requests, and there is no frontend build step — Tauri serves the `src/` directory directly.

## Data format

### PMTiles V3

A `.t` / `.pmtiles` file has five sections: a 127-byte header; a root directory (a gzip-compressed tile index, binary-searched by Hilbert-encoded tileID); metadata (JSON, including `vector_layers`); leaf directories; and tile data (gzip-compressed MVT).

### VCM vs VSM

Files are grouped into regional subdirectories (121, 123, 130, 131, 132), with VCM and VSM files paired one-to-one.

| | VCM (contours) | VSM (vector features) |
|---|---|---|
| File name | Starts with `C`, e.g. `C1213032V00.t` | Starts with `S`, e.g. `S1213032V00.t` |
| Zoom levels | z9 – z13 | z8 – z13 |
| Layers | One: `Q`, with field `F` for elevation | Eleven: `J` `K` `P` `L` `N` `O` `B` `A` `I` `F` `H` |
| Content | Contour lines, elevation labels on index lines | Roads, water, land cover, place names, POIs (no separate building layer) |

By decoding real tiles, the semantics of the VSM layers have been confirmed. Besides the classification code `E`, common fields include `X` (name), `C` (code), `N` (name / code), `b` (bridge), `j` (tunnel), `i` (pedestrian-street / park-path subclass of `L` E13), `F` (elevation, `H` only) and `c` (extra field on `H`). The actual field sets are `J{E,X}`, `K{E,X}`, `P{C,E,N,X}`, `L{C,E,X,b,i,j}`, `N{E,N}`, `O{E,X}`, `B{E}`, `A{E,X}`, `I{E,X}`, `F{E}`, `H{E,F,X,c}`.

| Layer | Geometry | Semantics (`E` codes) |
|---|---|---|
| `L` | Line / polygon | Roads: 7/19/20 motorway, 8/9 arterial, 10 secondary, 11–16/21/22/23 local, 0 path, 29 hiking trail, 2 railway, 3 metro / BRT |
| `F` | Polygon | Land cover: 1 forest, 2 rail corridor, 4 farmland, 7 urban park / green space |
| `N` | Polygon | Water bodies (rivers, lakes, reservoirs, ponds) |
| `P` / `O` | Line | Low / high zoom water lines |
| `K` | Point | POIs: 1 convenience, 4 golf, 5 fast food, 6 park, 7 bus stop, 8 train station, 11 campsite, 13 supermarket, 19 cafe, 22 bar, 25 hospital, 27 attraction, 30 stadium, 36 fuel, 52 parking; other codes fall back to a generic dot icon |
| `J` | Point | Administrative place names (city, district, town, village, street) |
| `H` / `A` | Point | Peaks (`F` = elevation) / airport |
| `B` / `I` | Line / polygon | Airport land / protected area |

## Building

Requires Rust ([rustup](https://rustup.rs/) recommended), Node.js 18+, and Windows 10/11 with the WebView2 runtime (built in since Win10 20H2).

```bash
npm install
npx tauri dev      # development, frontend changes auto-reload
npx tauri build    # release build
```

The first build compiles the Rust dependencies and takes 2–3 minutes; incremental builds take tens of seconds afterwards. Artifacts land in `src-tauri/target/release/`:

| File | Size | Notes |
|---|---|---|
| `map-app.exe` | ~8.7 MB | Portable, run directly |
| `bundle/nsis/MapViewer_0.3.1_x64-setup.exe` | ~6.8 MB | NSIS installer |

The release profile uses stripping, LTO and size optimization (`opt-level = "s"`), which keeps the exe just over 8 MB.

## Project structure

```
map viewer/
├── src/                  # Frontend, served directly by Tauri, no build step
│   ├── index.html        # All HTML/CSS/JS lives in this one file
│   ├── maplibre-gl.js    # MapLibre GL JS (local)
│   ├── pmtiles.js        # PMTiles JS (local)
│   ├── fonts/            # Noto Sans (local)
│   └── sprites/          # v3/v4 sprites + build-generated coros blue icons
├── src-tauri/
│   ├── src/lib.rs        # Tauri setup and IPC commands
│   ├── tauri.conf.json
│   └── capabilities/     # Window permission declarations
├── tools/                # Build / analysis scripts, incl. coros sprite builder
├── Map/                  # Local map data (not committed)
└── package.json          # Only depends on @tauri-apps/cli
```

## Dependencies

| Dependency | Version | Purpose | License |
|---|---|---|---|
| Tauri | 2.x | Desktop application framework | MIT / Apache-2.0 |
| tauri-plugin-window-state | 2.x | Remembers window position and size | MIT / Apache-2.0 |
| MapLibre GL JS | 4.7.1 | Vector tile WebGL rendering | BSD-3-Clause |
| pmtiles (JS) | 4.4.1 | PMTiles parsing and protocol adapter | BSD-3-Clause |
| Noto Sans | — | Map label font | OFL-1.1 |
| Protomaps Basemaps Assets | — | Sprites | BSD-3-Clause / CC0 |

## License

The project code is released under the MIT License. Use of the map data is subject to the respective vendors' license agreements.
