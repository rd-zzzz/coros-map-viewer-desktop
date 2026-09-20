# AGENTS.md

本文件为 AI 编码助手（及其他协作者）提供 MapViewer 项目的工作指南。动手修改前请先通读全文。

## 项目简介

MapViewer 是一个基于 **Tauri 2 + MapLibre GL JS** 的**完全离线**桌面地图查看器（Windows），用于：

- 浏览高驰（COROS）运动手表离线地图包中的 **VCM**（等高线）与 **VSM**（矢量要素）`.t` 文件——这些文件本质上是 PMTiles V3 归档；
- 加载通用的 `.pmtiles` 文件。

设计目标：离线运行、批量索引数百个瓦片文件、按视口按需渲染，打包为单文件可执行程序与 NSIS 安装包。

## 核心原则（必须遵守）

1. **完全离线，禁止联网依赖**：所有第三方库、CSS、字体、精灵图均已本地化到 `src/`。不得引入任何 CDN URL，不得在运行时发起外部网络请求。
2. **零前端构建**：不使用 webpack / vite 等打包器，也不通过 npm 引入前端运行时包。Tauri 的 `frontendDist` 直接指向 `src/` 目录。
3. **前端保持 ES5 风格**：统一使用 `var`、`function` 声明、字符串 `+` 拼接、`Promise.then`；**不要**使用 `let` / `const`、箭头函数、模板字符串、ES 模块、`async` 语法糖（现有代码刻意保持这一风格）。
4. **单文件内聚**：HTML、CSS、JavaScript 全部位于 `src/index.html`，以 `/* ============ Section Name ============ */` 注释块分节。新增代码应归入对应分节，并保持该节的缩进与命名风格（`<script>` 内为 8 空格缩进，CSS 为 4 空格）。
5. **改动必须实测**：前端逻辑改动通过 `npx tauri dev` 在真实 WebView 中验证；语法通过不等于功能正确。
6. **动态文本必须转义**：任何写入 `innerHTML` 的动态内容（PMTiles 属性、路径、文件名等）必须先经 `escapeHtml()`；CSP 已在 `tauri.conf.json` 启用，不得回退为 `null`，也不要为图省事把 `'unsafe-inline'` 加入 `script-src`。

## 技术栈

| 层 | 技术 | 位置 |
|---|---|---|
| 桌面壳 | Tauri 2（Rust），无边框窗口、NSIS 打包 | `src-tauri/` |
| 地图渲染 | MapLibre GL JS 4.7.x（WebGL 矢量瓦片） | `src/maplibre-gl.js` |
| 瓦片协议 | PMTiles JS 4.4.x（PMTiles V3 解析 + 协议适配） | `src/pmtiles.js` |
| 字体 | Noto Sans（Regular / Medium / Italic / Devanagari） | `src/fonts/` |
| 精灵图 | Protomaps basemaps-assets v3 / v4，多主题 | `src/sprites/` |

## 项目结构

```
map viewer/
├── src/                          # 前端资源（Tauri 直接 serve，无构建步骤）
│   ├── index.html                # 唯一前端文件：全部 HTML/CSS/JS
│   ├── maplibre-gl.js / .css     # MapLibre GL JS（本地）
│   ├── pmtiles.js                # PMTiles JS（本地）
│   ├── fonts/                    # Noto Sans 字体（.pbf，离线）
│   └── sprites/v3/, v4/          # 多主题精灵图（black/light/dark/white/grayscale）
├── src-tauri/
│   ├── Cargo.toml / Cargo.lock   # Rust 依赖与版本锁定
│   ├── tauri.conf.json           # Tauri 窗口、打包、版本配置
│   ├── build.rs                  # Tauri 构建脚本
│   ├── capabilities/default.json # 窗口与核心 API 权限声明
│   ├── gen/schemas/              # Tauri 自动生成的 schema（随构建更新）
│   ├── icons/                    # Windows/macOS/Android/iOS 图标
│   └── src/
│       ├── main.rs               # 入口，调用 lib::run()
│       └── lib.rs                # Tauri Builder + IPC 命令实现
├── package.json                  # 仅依赖 @tauri-apps/cli
├── README.md / README_EN.md      # 中文 / 英文说明（须同步维护）
└── AGENTS.md                     # 本文件
```

## 架构要点（修改相关代码前必读）

### 1. 两条文件读取通道

PMTiles JS 的 Source 只需实现 `getKey()` 与 `getBytes(offset, length)`。项目按文件来源使用两种实现：

| 通道 | 触发方式 | Source | 读取方式 |
|---|---|---|---|
| 文件夹选择 | 点击拖拽区，`<input type="file" webkitdirectory>` | `pmtiles.FileSource(file)` | 浏览器 File API，由 WebView 读取 |
| 原生拖拽 | 监听 `tauri://drag-drop`，从资源管理器拖入 | `DiskSource(path)` | 经 Rust IPC `read_file_slice` 按需 Range 读取 |

`DiskSource` 把字节读取交给 Rust 端，WebView 内存中只保存瓦片索引，即使面对约 6 GB 数据也不会把整文件载入内存。改动文件加载逻辑时两条通道都要考虑。

### 2. Rust IPC 命令（`src-tauri/src/lib.rs`）

- `read_path_as_files(path)`：文件则校验后缀直接返回；文件夹则递归扫描，返回所有 `.t` / `.pmtiles` 的完整路径。
- `read_file_slice(path, offset, length)`：读取指定字节范围（自动 clamp 到文件长度），是 PMTiles Range 请求的实际执行者。

新增或修改 IPC 命令时必须同时：① 在 `tauri::generate_handler!` 中注册；② 如涉及新的核心权限，更新 `capabilities/default.json`；③ 在前端通过 `window.__TAURI__.core.invoke(...)` 调用。

### 3. 视口按需加载

- **索引阶段**：遍历文件，仅读取 Header 与 Metadata 存入 `allEntries[]`，不加入地图。
- **筛选阶段**：`moveend` / `zoomend` 时计算视口 + padding 的边界框，与每个 entry 的 bounds 做相交判断，并按 `minZoom` 过滤。
- **排序与限流**：候选源按 bounds 与视口的**相交面积降序**排序（优先保证大面积覆盖视口的源），最多激活 `MAX_ACTIVE_SOURCES`（24）个。
- **加载 / 卸载**：`loadEntry()` 整体包在 try 内，注册协议实例、添加 source 与 layers；若中途失败必须就地按"先删图层、再删 source、最后移除协议"清理后再抛出，避免孤儿资源。`unloadSource()` 反向移除。
- **首次定位**：两条索引通道都只在 `allEntries` 入口为空（`wasEmpty`）时才 `fitBounds`，追加文件不得重置用户当前视野。

### 4. 渲染策略

- **VCM**：每个 `vector_layer` 只创建 `line` 图层，颜色按图层索引的黄金角色相分配 `(i * 137.508) % 360`，线宽随 zoom 插值。
- **VSM / generic**：依据 Metadata 中的 `vector_layers`，按几何类型创建 `fill`（Polygon）、`line`（LineString 与 Polygon 描边）、`circle`（Point）、`symbol`（文字标注）图层。
- **类型识别 `detectType`**：优先匹配路径中的 `VCM` / `VSM` 目录，其次匹配文件名 `C` / `S` 前缀，最后按 `.pmtiles` 后缀归为 generic。

### 5. 自定义窗口

`tauri.conf.json` 中 `decorations: false`，标题栏由 HTML 自绘（高度 36px，`data-tauri-drag-region` / `-webkit-app-region: drag` 实现拖拽），最小化、最大化、关闭通过 Tauri 核心 API 调用。

## 常用命令

```bash
npm install          # 安装 Tauri CLI
npx tauri dev        # 开发模式：前端改动整页重载，Rust 改动自动重编译重启
npx tauri build      # 发布构建，产出 exe 与 NSIS 安装包
```

环境要求：Rust（推荐 rustup 安装）、Node.js 18+、Windows 10/11（WebView2 运行时）。构建产物位于 `src-tauri/target/release/`。

## 版本号管理

版本号在以下三处必须保持一致，发布前逐一核对：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`（此处的版本决定打包出的安装包文件名）

## 文档与 Git 约定

- 修改功能或架构时，**`README.md`（中文）与 `README_EN.md`（英文）必须同步更新**。
- 提交信息使用 Conventional Commits 风格的英文前缀：`feat` / `fix` / `docs` / `refactor` / `init` 等，后接简短英文描述。
- 远程仓库：`origin` → `https://github.com/rd-zzzz/coros-map-viewer-desktop`，主分支为 `main`。
- `node_modules/`、`src-tauri/target/` 以及地图数据文件（`.t` / `.pmtiles`，体积约 6 GB）不得提交。

## Windows / PowerShell 约定

- 涉及 PowerShell 的命令默认使用 **PowerShell 7（pwsh）**，而非 Windows PowerShell 5.1（powershell.exe）。
- 文本文件统一使用 UTF-8 编码与 LF 行尾（Git 已配置自动转换提示，属正常现象）。
