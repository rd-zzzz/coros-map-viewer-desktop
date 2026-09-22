# MapViewer

**中文** | [English](README_EN.md)

基于 Tauri 2 + MapLibre GL JS 的离线 PMTiles 地图查看器，用于加载和浏览 VCM（等高线）、VSM（矢量地形）以及通用 `.pmtiles` 地图数据。

## 项目背景

VCM（等高线）和 VSM（矢量要素）地图数据来源于高驰（COROS）运动手表的离线地图包。这些数据以 `.t` 为后缀，实际采用 PMTiles V3 格式存储。作者需要在Windows平台上更方便地浏览、检查这些地图瓦片数据，因此开发了本项目。

## 功能需求

给定一批从高驰手表提取的 `.t` 地图瓦片文件（或通用 `.pmtiles` 文件），需要一个能离线运行、批量加载、按需渲染的桌面查看器。

核心技术栈：

| 层 | 技术 | 职责 |
|---|---|---|
| 桌面壳 | Tauri 2 (Rust) | 窗口管理、系统集成、打包为单文件 exe |
| 地图渲染 | MapLibre GL JS 4.7 | WebGL 矢量瓦片渲染引擎 |
| 瓦片协议 | PMTiles JS 4.4 | 解析 PMTiles V3 格式，按 offset/length 按需读取瓦片（本地经 Rust IPC，不走 HTTP） |
| 字体/图标 | Noto Sans + 自建 COROS 精灵 | 本地离线文字标注；蓝色圆形 POI 图标（构建期生成） |

## 数据格式

### PMTiles V3

每个 `.t` 或 `.pmtiles` 文件本质上是一个标准的 PMTiles V3 归档文件，由五部分组成：

```
+--------+----------------+----------+------------------+-----------+
| Header | Root Directory | Metadata | Leaf Directories | Tile Data |
| 127B   |   (gzip压缩)   |  (JSON)  |   (gzip压缩)     |  (MVT)   |
+--------+----------------+----------+------------------+-----------+
```

- **Header**（127 字节）：魔数 `PMTiles` + 版本号 + 各段偏移量/长度 + 缩放级别范围 + 地理边界框
- **Root Directory**：瓦片索引，使用 Hilbert 曲线编码的 tileID 进行二分查找
- **Metadata**：JSON 格式，包含 `vector_layers` 数组（图层名、字段定义、缩放范围）
- **Tile Data**：实际瓦片，MVT（Mapbox Vector Tiles）格式，GZIP 压缩

### VCM 与 VSM

| 属性 | VCM（等高线） | VSM（矢量要素） |
|---|---|---|
| 文件命名 | `C` 开头，如 `C1213032V00.t` | `S` 开头，如 `S1213032V00.t` |
| 瓦片类型 | MVT | MVT |
| 压缩 | GZIP | GZIP |
| 缩放级别 | z9 - z13 | z8 - z13 |
| 矢量图层 | 1 个：`Q`（字段：`F` 数字型，高程值） | 11 个：`J`, `K`, `P`, `L`, `N`, `O`, `B`, `A`, `I`, `F`, `H` |
| 内容特征 | 等高线，沿线标注高程数值 | 道路、水体、地表覆盖、地名、POI 等要素（无独立建筑图层） |
| 覆盖区域 | 按子目录分区（121, 123, 130, 131, 132） | 同 VCM，与 VCM 文件一一对应 |

通过对真实瓦片的解码，VSM 各图层的语义与字段 `E`（分类码）已确认。除 `E` 外的常见字段：`X`（名称）、`C`（编号）、`N`（名称/编号）、`b`（桥梁）、`j`（隧道）、`i`（`L` 层 E13 的步行街 / 公园步道子类）、`F`（高程，仅 `H` 层）、`c`（`H` 层附加）。各层实际字段集合为 `J{E,X}`、`K{E,X}`、`P{C,E,N,X}`、`L{C,E,X,b,i,j}`、`N{E,N}`、`O{E,X}`、`B{E}`、`A{E,X}`、`I{E,X}`、`F{E}`、`H{E,F,X,c}`：

| 图层 | 几何 | 语义（`E` 分类码） |
|---|---|---|
| `L` | 线/面 | 道路：7/19/20 高速、8/9 主干、10 次干、11–16/21/22/23 支路、0 小路、29 登山步道、2 铁路、3 地铁/BRT |
| `F` | 面 | 地表覆盖：1 林地、2 铁路走廊、4 农田、7 城市公园/绿地 |
| `N` | 面 | 水体（河、湖、库、塘） |
| `P` / `O` | 线 | 低 / 高缩放级别水系线 |
| `K` | 点 | POI：1 便利店、4 高尔夫、5 快餐、6 公园、7 公交站、8 火车站、11 露营、13 超市、19 咖啡、22 酒吧、25 医院、27 景点、30 体育场、36 加油、52 停车；未列出的分类回落为通用点图标 |
| `J` | 点 | 行政地名（市、区、镇、村、街道） |
| `H` / `A` | 点 | 山峰（`F`=高程）/ 机场 |
| `B` / `I` | 线/面 | 机场用地 / 自然保护区 |

## 架构设计

### 整体流程

```
用户选择文件夹
    │
    ▼
Scan .t / .pmtiles files ──→ FileSource / DiskSource ──→ PMTiles.getHeader() + getMetadata()
    │                                                    │
    ▼                                                    ▼
构建 allEntries[]                              读取边界框、缩放范围、图层列表
    │
    ▼
fitBounds() ──→ 强制 minZoom ──→ updateViewport()
                                        │
                                        ▼
                              计算视口范围 + padding
                                        │
                                        ▼
                              筛选与视口相交的 entries
                              按与视口相交面积排序，取前 24 个
                                        │
                                        ▼
                         ┌────────────────┼────────────────┐
                         ▼                ▼                ▼
                     loadEntry()    unloadSource()    updateStats()
                   注册协议+图层    移除图层+源       更新面板数字
```

### PMTiles 协议桥接

MapLibre GL JS 通过 `addProtocol` 机制支持自定义数据源协议。本项目使用 pmtiles 库自带的 `Protocol` 类：

```javascript
var protocol = new pmtiles.Protocol({ metadata: true });
maplibregl.addProtocol("pmtiles", protocol.tile);
```

当 MapLibre 请求 `pmtiles://some-key` 时，`protocol.tile` 会：
1. 解析 URL 提取文件标识
2. 查找已注册的 PMTiles 实例
3. 读取 Header 返回源元数据（bounds, zoom range）
4. 或读取指定 z/x/y 的瓦片数据返回给渲染器

每个本地文件包装为 PMTiles 实例后，通过 `protocol.add(inst)` 注册到协议中。`inst.source.getKey()` 返回的标识符自动成为 `pmtiles://` URL 的关键 key。

### 本地文件读取：两条通道

PMTiles JS 的 Source 接口只需实现 `getKey()` 和 `getBytes(offset, length)` 两个方法。本项目按文件来源提供两种实现：

| 通道 | 触发方式 | Source 实现 | 读取方式 |
|---|---|---|---|
| 文件夹选择 | 点击拖拽区，`<input type="file" webkitdirectory>` | `pmtiles.FileSource(file)` | 浏览器 File API，由 WebView 读取文件 |
| 原生拖拽 | 从操作系统资源管理器拖入文件或文件夹 | `DiskSource(path)` | Rust IPC `read_file_slice` 按需 Range 读取 |

```javascript
// DiskSource：字节读取交由 Rust 端完成，不把整个文件载入 WebView 内存
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

Rust 后端（`src-tauri/src/lib.rs`）暴露两个 IPC 命令：

| 命令 | 功能 |
|---|---|
| `read_path_as_files` | 接收文件或文件夹路径；文件夹则递归扫描，返回其中所有 `.t`/`.pmtiles` 的完整路径 |
| `read_file_slice` | 按 offset/length 读取文件的指定字节范围，是 PMTiles Range 请求的实际执行者 |

原生拖拽时，前端先调用 `read_path_as_files` 在 Rust 端完成目录扫描（不经过浏览器的目录上传机制），再为每个路径创建 `DiskSource` 进行索引。这样即使面对约 6 GB 地图数据，WebView 内存中也只保存瓦片索引而非文件内容。

### 视口按需加载

面对数百个瓦片文件，不能一次性全部加载到 MapLibre 中。核心策略：

1. **索引阶段**：遍历所有 `.t` 文件，读取 Header 和 Metadata，存入 `allEntries[]`（不加载到地图）
2. **视口筛选**：每次 `moveend`/`zoomend` 时，计算当前视口 + padding 的边界框，与每个 entry 的 bounds 做相交判断
3. **面积排序**：按瓦片 bounds 与视口的相交面积降序排序，优先保证大面积覆盖视口的源，取前 `MAX_ACTIVE_SOURCES`（24）个
4. **加载/卸载**：新进入视口的 entry 调用 `loadEntry()`（注册协议 + 添加源 + 添加图层），移出视口的调用 `unloadSource()`（移除图层 + 移除源）
5. **缩放过滤**：跳过 `minZoom > 当前缩放 + 1` 的 entry，避免加载当前级别无瓦片的源

```javascript
// 视口筛选核心逻辑
for (var i = 0; i < allEntries.length; i++) {
    var entry = allEntries[i];
    if (z >= entry.header.minZoom - 1 && boundsIntersect(entry.bounds, pv)) {
        candidates.push(entry);
    }
}
```

### 增量加载与去重

同一会话内可反复选择文件夹或拖入文件，新文件是**追加**进既有索引，而非替换：

- 去重表 `accumulatedNames` 按路径记录已索引文件。**两条通道的键口径不同**——文件夹通道用 `webkitRelativePath || name`，原生拖拽通道用完整磁盘路径；口径混用会让同一文件被索引两次。
- 索引开始前先预扫一遍统计 `totalNew`：后缀合法、未去重、`detectType` 能识别，三者同时满足才计数，保证进度条能走到 100%。
- 循环中每处理 10 个（拖拽通道 20 个）文件调用一次 `yieldUI()` 让出主线程，避免面对数百个文件时界面冻结。
- 只有 `allEntries` 从空变为非空（首次加载）时才 `fitBounds` 并把缩放抬升到数据的 `globalMinZoom`；追加文件不会重置用户当前视野。
- 「清除所有」按钮卸载全部已加载源、清空 `allEntries` 与去重表，并把面板状态复位。

### 渲染策略（语义化配色，对齐 COROS 手表外观）

旧版按图层索引黄金角（`(i * 137.508) % 360`）生成随机色，现改为按图层语义与字段 `E` 分类着色，外观对齐手表的浅色户外风格，并提供浅色/深色两套调色板（`PALETTES`，默认浅色）。切换主题时，`applyPalette()` 遍历每个源记录的 `bindings`，调用 `setPaintProperty` 实时重设颜色，无需重建图层。

**道路（`L` 层）**：每个等级绘制 casing（描边）+ fill（铺面）两层——高速/主干道为 peach/salmon 色并配更深的橙色描边；次干/支路在高缩放为白色铺面（次干约 z14.5、支路约 z15 变白）、低缩放为浅灰细线，白色铺面统一用中灰色 casing 勾边（次干描边深于支路），避免白色道路在近白背景上「消失」。登山步道（E29）以及公园步道/步行街（E13 且 `i` 为 19/23）为中灰色虚线、小路（E0）为浅灰细线，颜色与线宽均刻意弱于正式道路，防止低等级小路比大路更抢眼；铁路为灰色虚线，地铁/BRT 为蓝色。线宽随缩放插值，并刻意收窄以让沿路绿带露出。

**地表与水体（`F` / `N` 层）**：林地淡绿、农田淡黄、城市公园 teal 色、水体淡蓝；保护区与机场用地各有对应底色。

**POI（`K` 层）**：使用统一的蓝色圆形 + 白色字形图标（精灵位于 `src/sprites/coros/`），由构建脚本 `tools/build-coros-sprite.js` 从 v4/light 精灵提取白色字形掩膜生成；缺失图标（医院、停车、加油、露营、高尔夫）由脚本手绘。

**文字标注**：名称读取 COROS 的 `X` 字段（标准 `name` 缺失）；道路名沿道路走向排布、深灰色，行政地名暗红色、POI 名中性灰、山峰名棕褐色，均带白色描边光晕。

**VCM（等高线，`Q` 层）**：按 `F`（高程）`% 50` 区分首曲线/计曲线，淡棕褐色细线，不透明度固定（首曲线 0.75、计曲线 0.9）。不提供 hover 高亮：等高线的高程天然不唯一（实测 36 个 z11 瓦片里 43 个要素只有 5 个高程值），无法作为要素 id，用 `feature-state` 会跨瓦片点亮所有同高程线。

**全局叠放顺序**：所有图层按 `SLOT_ORDER`（地表/水体 → 道路由支路到高速 → 步道/铁路 → 图标 → 各类文字，自底向顶）由 `reorderLayers()` 通过 `moveLayer` 重排，保证多源叠放一致；重排在每次视口刷新末尾对整批执行一次，而非逐源触发。

通用 `.pmtiles` 文件不套用上述语义配色，保留按几何类型 + 随机色的回退渲染。

### 文件类型自动识别

通过文件路径和文件名两个维度判断：

```javascript
function detectType(file) {
    var path = file.webkitRelativePath || file._dropPath || "";
    if (/[/\\]VCM[/\\]/i.test(path)) return "vcm";  // 路径含 VCM 目录
    if (/[/\\]VSM[/\\]/i.test(path)) return "vsm";  // 路径含 VSM 目录
    if (/^C\d/i.test(file.name)) return "vcm";       // C 开头
    if (/^S\d/i.test(file.name)) return "vsm";       // S 开头
    if (file.name.toLowerCase().endsWith(".pmtiles")) return "generic";  // .pmtiles 文件
    return null;
}
```

## 项目结构

```
map viewer/
├── src/                          # 前端资源（Tauri 直接 serve）
│   ├── index.html                # 唯一的前端文件，包含全部 HTML/CSS/JS
│   ├── maplibre-gl.js            # MapLibre GL JS 4.7.1（本地）
│   ├── maplibre-gl.css           # MapLibre GL JS 样式（本地）
│   ├── pmtiles.js                # PMTiles JS 4.4.1（本地）
│   ├── fonts/                    # Noto Sans 字体（本地离线）
│   │   ├── OFL.txt               # 字体许可证（OFL-1.1）
│   │   ├── Noto Sans Regular/    # 主要标注字体
│   │   ├── Noto Sans Medium/
│   │   ├── Noto Sans Italic/
│   │   └── Noto Sans Devanagari Regular v1/
│   └── sprites/                  # 地图精灵图（本地离线）
│       ├── v3/                   # Protomaps 旧版精灵（black/light/dark/white/grayscale）
│       ├── v4/                   # Protomaps 彩色徽章精灵（black/light/dark/white/grayscale）
│       └── coros/                # 构建期生成的蓝色圆形 POI 精灵（sprite.png/json + @2x）
│
├── src-tauri/                    # Rust 后端
│   ├── Cargo.toml                # Rust 依赖配置
│   ├── Cargo.lock                # Rust 依赖版本锁定
│   ├── tauri.conf.json           # Tauri 窗口/打包配置
│   ├── build.rs                  # Tauri 构建脚本
│   ├── gen/schemas/              # Tauri 自动生成的权限与配置 schema
│   ├── capabilities/
│   │   └── default.json          # 窗口操作权限（最小化/最大化/关闭/拖拽）
│   ├── icons/
│   │   ├── icon.ico              # Windows 图标
│   │   ├── icon.icns             # macOS 图标
│   │   ├── icon.png              # 通用图标
│   │   ├── android/              # Android 图标集（hdpi ~ xxxhdpi）
│   │   └── ios/                  # iOS 图标集
│   └── src/
│       ├── main.rs               # 入口，调用 lib::run()
│       └── lib.rs                # Tauri Builder 初始化 + Rust IPC 命令
│
├── package.json                  # Node.js 依赖（仅 @tauri-apps/cli）
├── Map/                          # 本地地图数据（不提交 git）：VCM/、VSM/ 各区域 .t 文件
├── tools/                        # 构建期/分析脚本（不进入应用运行时），含 COROS 精灵生成器
└── ...                           # README / AGENTS.md 等
```

### 为什么前端是单文件

Tauri 的 `frontendDist` 指向 `src/` 目录，`index.html` 中通过相对路径引用同目录的 JS/CSS/字体/精灵资源。这样 Tauri 内嵌的 WebView 直接从本地文件系统读取，无需打包工具（webpack/vite），也无需网络请求。

所有外部 CDN 依赖已本地化：
- `https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js` → `maplibre-gl.js`
- `https://unpkg.com/pmtiles@4.4.1/dist/pmtiles.js` → `pmtiles.js`
- `https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf` → `fonts/{fontstack}/{range}.pbf`
- `https://protomaps.github.io/basemaps-assets/sprites/v4/black` → `sprites/v4/black`

## UI 组件

| 组件 | 位置 | 功能 |
|---|---|---|
| 自定义标题栏 | 顶部 36px | 应用名 + 拖拽区域 + 最小化/最大化/关闭按钮 |
| 控件面板 | 左上角 | 文件夹选择（虚线拖拽区，支持原生拖拽）、VCM 开关、浅色/深色主题切换、统计卡片（已索引 / 已加载）、进度条、清除所有按钮；面板可折叠 |
| 缩放控件 | 右上角 | 统一缩放组件：缩放级别显示 + 放大/缩小按钮 + 比例尺 |
| 属性检查 | 左下角 | 点击要素后显示属性表格，支持复制全部；半透明面要素不会抢在线/点要素之前 |
| 调试日志 | 右下角 | 默认隐藏，点击圆形按钮切换；错误行红色竖线、警告行黄色竖线标记，最多保留 80 行 |
| 状态栏 | 底部 28px | 鼠标坐标、当前瓦片 z/x/y、加载状态指示灯 |

### 窗口自定义

Tauri 配置 `decorations: false` 移除系统标题栏，由 HTML 自绘标题栏替代。窗口控制通过 Tauri 的 `__TAURI__` 全局对象调用：

```javascript
var appWindow = window.__TAURI__.window.getCurrentWindow();
document.getElementById("btn-min").onclick = function () { appWindow.minimize(); };
document.getElementById("btn-max").onclick = function () { appWindow.toggleMaximize(); };
document.getElementById("btn-close").onclick = function () { appWindow.close(); };
```

## 构建

### 环境要求

- Rust 1.70+（推荐通过 [rustup](https://rustup.rs/) 安装）
- Node.js 18+
- Windows 10/11（WebView2 运行时，Win10 20H2+ 自带）

### 构建步骤

```bash
npm install
npx tauri build
```

首次构建需要下载并编译 Rust 依赖（Tauri + wry + tao），耗时约 2-3 分钟。后续增量编译约 30 秒。

### 产出物

| 文件 | 大小 | 说明 |
|---|---|---|
| `src-tauri/target/release/map-app.exe` | ~8.7 MB | 绿色版可执行文件，可直接运行 |
| `src-tauri/target/release/bundle/nsis/MapViewer_0.2.1_x64-setup.exe` | ~6.8 MB | NSIS 安装包 |

### 开发模式

```bash
npx tauri dev
```

启动开发服务器（Tauri CLI 内置静态服务）。修改 `src/` 下的前端文件后 WebView 自动整页重新加载；修改 Rust 代码则自动重新编译并重启应用。

## Release 优化

`Cargo.toml` 中的 release profile 配置：

```toml
[profile.release]
strip = true        # 去除调试符号
lto = true          # 链接时优化
codegen-units = 1   # 单编译单元，更好的优化
opt-level = "s"     # 优化体积而非速度
panic = "abort"     # panic 时直接终止，减小二进制体积
```

## 数据获取

地图数据存储在 COROS 手表内部存储的 `map` 文件夹中，内含 `VCM` 和 `VSM` 两个子目录。将整个 `map` 文件夹复制到电脑后，通过本程序选择该文件夹即可加载浏览。开发时也可直接将其放在项目根目录（`Map/`，已被 `.gitignore` 忽略）。

> 注意：地图数据文件体积较大（约 6 GB），未包含在本仓库中，请自行从手表提取。v0.2.0 起也支持通用 `.pmtiles` 格式文件。

## 数据目录结构

程序支持两种文件夹选择方式：

**方式 1：选择包含 VCM/VSM 子目录的根目录**

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

**方式 2：直接选择 VCM 或 VSM 文件夹**

程序会自动扫描所有 `.t` 和 `.pmtiles` 文件，根据路径中的 `VCM`/`VSM`、文件名前缀 `C`/`S` 或 `.pmtiles` 后缀自动分类。

## 依赖

| 依赖 | 版本 | 用途 | 许可证 |
|---|---|---|---|
| Tauri | 2.x | 桌面应用框架 | MIT/Apache-2.0 |
| MapLibre GL JS | 4.7.1 | 矢量瓦片 WebGL 渲染 | BSD-3-Clause |
| pmtiles (JS) | 4.4.1 | PMTiles 格式解析 + MapLibre 协议适配 | BSD-3-Clause |
| Noto Sans | - | 地图文字标注字体 | OFL-1.1 |
| Protomaps Basemaps Assets | - | 精灵图（图标、路牌） | BSD-3-Clause / CC0 |

## 许可证

本项目代码基于 MIT 许可证。地图数据的使用需遵循各自供应商的许可协议。
