# MapViewer

**中文** | [English](README_EN.md)

基于 Tauri 2 + MapLibre GL JS 的离线 PMTiles 地图查看器，用于加载和浏览 VCM（等高线）和 VSM（矢量地形）地图数据。

## 项目背景

VCM（等高线）和 VSM（矢量要素）地图数据来源于高驰（COROS）运动手表的离线地图包。这些数据以 `.t` 为后缀，实际采用 PMTiles V3 格式存储。作者需要在Windows平台上更方便地浏览、检查这些地图瓦片数据，因此开发了本项目。

## 功能需求

给定一批从高驰手表提取的 `.t` 地图瓦片文件，需要一个能离线运行、批量加载、按需渲染的桌面查看器。

核心技术栈：

| 层 | 技术 | 职责 |
|---|---|---|
| 桌面壳 | Tauri 2 (Rust) | 窗口管理、系统集成、打包为单文件 exe |
| 地图渲染 | MapLibre GL JS 4.7 | WebGL 矢量瓦片渲染引擎 |
| 瓦片协议 | PMTiles JS 4.4 | 解析 PMTiles V3 格式，通过 HTTP Range Request 按需读取瓦片 |
| 字体/图标 | Noto Sans + Protomaps Sprites | 本地离线文字标注和地图符号 |

## 数据格式

### PMTiles V3

每个 `.t` 文件本质上是一个标准的 PMTiles V3 归档文件，由五部分组成：

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
| 内容特征 | 等高线，沿线标注高程数值 | 道路、河流、建筑、地名等地物要素 |
| 覆盖区域 | 按子目录分区（121, 123, 130, 131, 132） | 同 VCM，与 VCM 文件一一对应 |

VSM 各图层的字段包括 `E`（数字）、`X`（字符串/名称）、`C`、`N`、`b`、`i`、`j`、`F` 等，具体语义需参考数据供应商文档。

## 架构设计

### 整体流程

```
用户选择文件夹
    │
    ▼
遍历 .t 文件 ──→ pmtiles.FileSource(file) ──→ PMTiles.getHeader() + getMetadata()
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
                              按距离中心排序，取前 24 个
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

每个本地文件通过 `pmtiles.FileSource(file)` 包装为 PMTiles 实例，再通过 `protocol.add(inst)` 注册到协议中。`inst.source.getKey()` 返回的标识符自动成为 `pmtiles://` URL 的 key。

### 视口按需加载

面对数百个瓦片文件，不能一次性全部加载到 MapLibre 中。核心策略：

1. **索引阶段**：遍历所有 `.t` 文件，读取 Header 和 Metadata，存入 `allEntries[]`（不加载到地图）
2. **视口筛选**：每次 `moveend`/`zoomend` 时，计算当前视口 + padding 的边界框，与每个 entry 的 bounds 做相交判断
3. **距离排序**：按瓦片边界中心到视口中心的距离排序，取最近的 `MAX_ACTIVE_SOURCES`（24）个
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

### 渲染策略

根据 VCM/VSM 类型采用不同的渲染方式：

**VCM（等高线）**：仅创建 `line` 图层，颜色按图层索引的黄金角色相分配（`(i * 137.508) % 360`），线宽随缩放级别插值。

**VSM（矢量要素）**：按几何类型创建 5 种图层：
- `fill`：Polygon 填充，带 hover 透明度变化
- `line`（LineString）：线要素，hover 时加粗
- `line`（Polygon outline）：面边框
- `circle`：Point 要素，半径随缩放插值
- `symbol`：文字标注，读取 `name` 或 `X` 字段，使用本地 Noto Sans 字体

### 文件类型自动识别

通过文件路径和文件名两个维度判断：

```javascript
function detectType(file) {
    var path = file.webkitRelativePath || "";
    if (/[/\\]VCM[/\\]/i.test(path)) return "vcm";  // 路径含 VCM 目录
    if (/[/\\]VSM[/\\]/i.test(path)) return "vsm";  // 路径含 VSM 目录
    if (/^C\d/i.test(file.name)) return "vcm";       // C 开头
    if (/^S\d/i.test(file.name)) return "vsm";       // S 开头
    return null;
}
```

## 项目结构

```
map-app/
├── src/                          # 前端资源（Tauri 直接 serve）
│   ├── index.html                # 唯一的前端文件，包含全部 HTML/CSS/JS
│   ├── maplibre-gl.js            # MapLibre GL JS 4.7.1（本地）
│   ├── maplibre-gl.css           # MapLibre GL JS 样式（本地）
│   ├── pmtiles.js                # PMTiles JS 4.4.1（本地）
│   ├── fonts/                    # Noto Sans 字体（本地离线）
│   │   ├── Noto Sans Regular/    # 主要标注字体
│   │   ├── Noto Sans Medium/
│   │   ├── Noto Sans Italic/
│   │   └── Noto Sans Devanagari Regular v1/
│   └── sprites/                  # 地图精灵图（本地离线）
│       └── v4/
│           ├── black.json/png    # 深色主题精灵
│           ├── light.json/png
│           ├── dark.json/png
│           ├── white.json/png
│           └── grayscale.json/png
│
├── src-tauri/                    # Rust 后端
│   ├── Cargo.toml                # Rust 依赖配置
│   ├── tauri.conf.json           # Tauri 窗口/打包配置
│   ├── build.rs                  # Tauri 构建脚本
│   ├── capabilities/
│   │   └── default.json          # 窗口操作权限（最小化/最大化/关闭/拖拽）
│   ├── icons/
│   │   └── icon.ico              # 应用图标
│   └── src/
│       ├── main.rs               # 入口，调用 lib::run()
│       └── lib.rs                # Tauri Builder 初始化
│
├── package.json                  # Node.js 依赖（仅 @tauri-apps/cli）
└── docs/
    └── ui-beautification-plan.md # UI 美化方案文档
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
| 控件面板 | 左上角 | 文件夹选择（虚线拖拽区）、VCM 开关（滑动开关）、统计卡片（已索引/已加载/缩放）、进度条 |
| 缩放显示 | 右上角 | 当前缩放级别（Z 格式，两位小数） |
| 属性检查 | 左下角 | 点击要素后显示属性表格，支持复制全部 |
| 调试日志 | 右下角 | 默认隐藏，点击圆形按钮切换，错误行红色竖线标记 |
| 状态栏 | 底部 28px | 鼠标坐标、当前瓦片 z/x/y、加载状态指示灯 |

### 窗口自定义

Tauri 配置 `decorations: false` 移除系统标题栏，由 HTML 自绘标题栏替代。窗口控制通过 Tauri 的 `__TAURI__` 全局对象调用：

```javascript
var appWindow = window.__TAURI__.window.getCurrentWindow();
btn-min.onclick = function () { appWindow.minimize(); };
btn-max.onclick = function () { appWindow.toggleMaximize(); };
btn-close.onclick = function () { appWindow.close(); };
```

## 构建

### 环境要求

- Rust 1.70+（推荐通过 [rustup](https://rustup.rs/) 安装）
- Node.js 18+
- Windows 10/11（WebView2 运行时，Win10 20H2+ 自带）

### 构建步骤

```bash
cd map-app
npm install
npx tauri build
```

首次构建需要下载并编译 Rust 依赖（Tauri + wry + tao），耗时约 2-3 分钟。后续增量编译约 30 秒。

### 产出物

| 文件 | 大小 | 说明 |
|---|---|---|
| `src-tauri/target/release/map-app.exe` | ~8.6 MB | 绿色版可执行文件，可直接运行 |
| `src-tauri/target/release/bundle/nsis/MapViewer_0.1.0_x64-setup.exe` | ~6.7 MB | NSIS 安装包 |

### 开发模式

```bash
npx tauri dev
```

启动开发服务器，修改 `src/index.html` 后自动热重载。

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

地图数据存储在 COROS 手表内部存储的 `map` 文件夹中，内含 `VCM` 和 `VSM` 两个子目录。将整个 `map` 文件夹复制到电脑后，通过本程序选择该文件夹即可加载浏览。

> 注意：地图数据文件体积较大（约 6 GB），未包含在本仓库中，请自行从手表提取。

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

程序会自动扫描所有 `.t` 文件，根据路径中的 `VCM`/`VSM` 或文件名前缀 `C`/`S` 自动分类。

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
