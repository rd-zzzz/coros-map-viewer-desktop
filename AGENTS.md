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
3. **前端保持 ES5 风格**：统一使用 `var`、`function` 声明、字符串 `+` 拼接、`Promise.then`；**不要**使用 `let` / `const`、箭头函数、模板字符串、ES 模块、`async` 语法糖（现有代码刻意保持这一风格）。**既有例外**：`indexFolder()` 与 `indexDroppedPaths()` 已声明为 `async function`——索引循环需要 `await` 顺序读取 Header/Metadata，并用 `yieldUI()` 让出主线程。新增代码仍守 ES5，不要继续扩散 `async`。
4. **单文件内聚**：HTML、CSS、JavaScript 全部位于 `src/index.html`，以 `/* ============ Section Name ============ */` 注释块分节。新增代码应归入对应分节，并保持该节的缩进与命名风格（`<script>` 内为 8 空格缩进，CSS 为 4 空格）。
5. **改动必须实测**：前端逻辑改动通过 `npx tauri dev` 在真实 WebView 中验证；语法通过不等于功能正确。
   > **AI 辅助开发的验证上限**：AI 侧最多能做到「Rust 编译通过（`cargo check`）+ exe 启动存活 + WebView2 进程拉起」。文件选择对话框、原生拖拽、hover 反馈、属性面板点击等真实交互**无法自动化**，必须由 Rodney 手动跑一次。不要声称已经验证过这些路径。
6. **动态文本必须转义**：任何写入 `innerHTML` 的动态内容（PMTiles 属性、路径、文件名等）必须先经 `escapeHtml()`；CSP 已在 `tauri.conf.json` 启用，不得回退为 `null`，也不要为图省事把 `'unsafe-inline'` 加入 `script-src`。

## 技术栈

| 层 | 技术 | 位置 |
|---|---|---|
| 桌面壳 | Tauri 2（Rust），无边框窗口、NSIS 打包 | `src-tauri/` |
| 地图渲染 | MapLibre GL JS 4.7.x（WebGL 矢量瓦片） | `src/maplibre-gl.js` |
| 瓦片协议 | PMTiles JS 4.4.x（PMTiles V3 解析 + 协议适配） | `src/pmtiles.js` |
| 字体 | Noto Sans（Regular / Medium / Italic / Devanagari） | `src/fonts/` |
| 精灵图 | Protomaps basemaps-assets v3 / v4（多主题）+ 构建期生成的 coros 蓝色圆形图标 | `src/sprites/` |

## 项目结构

```
map viewer/
├── src/                          # 前端资源（Tauri 直接 serve，无构建步骤）
│   ├── index.html                # 唯一前端文件：全部 HTML/CSS/JS
│   ├── maplibre-gl.js / .css     # MapLibre GL JS（本地）
│   ├── pmtiles.js                # PMTiles JS（本地）
│   ├── fonts/                    # Noto Sans 字体（.pbf，离线）
│   └── sprites/                  # v3/、v4/ 多主题精灵；coros/ 为构建期生成的蓝色圆形 POI 图标
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
├── Map/                          # 本地地图数据（不提交 git）：VCM/ 与 VSM/，各含区域子目录，内为 .t 文件
├── tools/                        # 构建期/分析用 Node 脚本（不进入应用运行时）；目前仅 build-coros-sprite.js 入库，其余为本地调试脚本
├── README.md / README_EN.md      # 中文 / 英文说明（须同步维护）
└── AGENTS.md                     # 本文件
```

> **地图数据位置**：手表地图包放在项目根目录的 `Map/` 文件夹，结构为 `Map/VCM/<区域>/*.t`（等高线）与 `Map/VSM/<区域>/*.t`（矢量要素）。这些 `.t` 数据体积约 6 GB，`/map/` 与 `/Map/` 均已在 `.gitignore` 中排除；应用运行时由用户自行选择该文件夹或拖入。

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
- `read_file_slice(path, offset, length)`：读取指定字节范围（自动 clamp 到文件长度），是 PMTiles Range 请求的实际执行者。**返回 base64 字符串而不是 `Vec<u8>`**——`Vec<u8>` 会被 serde 序列化成 JSON 数字数组，实测 40 KB 二进制膨胀到 3.56x、序列化+解析约 1.4 ms/瓦片；base64 只有 1.33x、约 0.075 ms（端到端往返已实测校验一致）。前端 `DiskSource` 用 `base64ToArrayBuffer()`（基于 `atob`）还原成 `ArrayBuffer`。
- **溢出防护（勿改回）**：`end` 用 `offset.saturating_add(length).min(file_len)`。`offset + length` 在 u64 下可能溢出，release 构建无溢出检查，回绕会让 `min()` 取到巨大值并触发 `vec![0u8; 巨大]` 的内存分配。

新增或修改 IPC 命令时必须同时：① 在 `tauri::generate_handler!` 中注册；② 如涉及新的核心权限，更新 `capabilities/default.json`；③ 在前端通过 `window.__TAURI__.core.invoke(...)` 调用。

**递归安全（勿移除）**：目录扫描 `scan_dir()` 使用 `entry.file_type()`——该 API 不跟随符号链接——并显式跳过 symlink / junction，防止链接指回祖先目录造成无限递归。新增扫描逻辑时必须保留这一行为。

### 3. 视口按需加载

- **索引阶段**：遍历文件，仅读取 Header 与 Metadata 存入 `allEntries[]`，不加入地图。
- **增量与去重**：`accumulatedNames` 是两条通道共用的去重表，但两条通道**天生拿不到同口径的标识**——文件夹通道只有 `webkitRelativePath`（浏览器 File API 不暴露绝对路径），原生拖拽通道是完整磁盘路径。因此统一走 `normalizePathKey()`（分隔符归一为 `/`、Windows 下转小写）+ `isKnownPath()`（归一化后互为路径后缀即视为同一文件）。不要改回直接字符串相等比较，否则「先选文件夹再拖入同一文件夹」会把同一文件索引两次。索引开始前先预扫一遍统计 `totalNew`（后缀合法 + `isKnownPath` 为假 + `detectType` 能识别，三者同时满足才计数），否则进度条永远走不到 100%。
- **重入守卫（两条通道都要有）**：`indexFolder` 与 `indexDroppedPaths` 开头都必须判定 `loadingActive` 后直接返回。少一个就会出现两个索引循环并发：进度条互相覆盖、状态文案打架，且双方都判定 `wasEmpty` 为 true 从而各 `fitBounds` 一次，视野跳两下。
- **PMTiles 实例回收（易踩坑）**：pmtiles 4.x 的 `Protocol` **没有 `remove()`**（实测 `typeof` 为 `undefined`），内部 `tiles` 是无上限的 `Map`。原来写的 `protocol.remove(key)` 每次都抛 `TypeError` 并被空 `catch` 吞掉，导致实例（含目录缓存）全会话驻留、「清除所有」也回收不掉。回收必须走 `releaseProtocol(key)` → `protocol.tiles.delete(key)`。
- **让出主线程**：索引循环每处理 10 个（拖拽通道 20 个）文件 `await yieldUI()` 一次，避免数百个文件时界面冻结。
- **筛选阶段**：`moveend` / `zoomend` 时计算视口 + padding 的边界框，与每个 entry 的 bounds 做相交判断，并按 `minZoom` 过滤。
- **排序与限流**：候选源按 bounds 与视口的**相交面积降序**排序（优先保证大面积覆盖视口的源），最多激活 `MAX_ACTIVE_SOURCES`（24）个。
- **加载 / 卸载**：`loadEntry()` 整体包在 try 内，注册协议实例、添加 source 与 layers；若中途失败必须就地按"先删图层、再删 source、最后移除协议"清理后再抛出，避免孤儿资源。`unloadSource()` 反向移除。
- **首次定位**：两条索引通道都只在 `allEntries` 入口为空（`wasEmpty`）时才 `fitBounds`，追加文件不得重置用户当前视野。
- **样式未就绪重试**：`updateViewport()` 在 `!map.isStyleLoaded()` 时最多重试 10 次（间隔 200ms）。计数器 `vpRetries` 只在**确实排入了一次重试**时自增，且用 `vpRetryTimer` 保证同一时刻只有一个待执行重试——否则鼠标移动会经 file-drop 的透明 `<input>` 高频触发本函数，把预算在一次样式切换内烧光，导致视口刷新永久丢失。

### 4. 渲染策略（语义化配色，对齐 COROS 手表）

- **配色不再随机**：旧版按图层索引黄金角 `(i * 137.508) % 360` 生成随机 HSL；现改为按图层语义与字段 `E` 分类着色。两套调色板定义在 `src/index.html` 的 `PALETTES`（light/dark），切主题时由 `applyPalette()` 遍历每个源的 `bindings` 调 `setPaintProperty` 重设颜色。
- **VSM 图层语义**（经真实瓦片解码确认，详见 index.html 注释）：`L` 道路（线+面，E 分级：7/19/20 高速、8/9 主干、10 次干、11–16/21/22/23 支路、0 小路、29 登山步道、2 铁路、3 地铁/BRT）；`F` 地表覆盖（E1 林地、E4 农田、E7 城市公园、E2 铁路走廊）；`N` 水体；`I` 保护区；`B` 机场用地；`P`/`O` 低/高 zoom 水系线；`K` POI（点，E 分类）；`J` 行政地名；`H` 山峰；`A` 机场点。
- **道路绘制**：每个等级画 casing（描边）+ fill（铺面）两层；低 zoom 次/支路为浅灰细线、高 zoom（约 z15）为白色铺面（`lowHighExpr` 随 zoom 插值），主干道/高速为 peach/salmon 色；E29 步道、以及 E13 中 `i`=19/23 的公园步道/步行街为黑色虚线（`line-dasharray`，后者在 local 过滤器中排除、并入 trail 层）。线宽刻意收窄以露出沿路 E7 绿带。名称字段为 `X`，道路名/POI 标签的 filter 与 text-field 都必须兼容 X。
- **POI 图标**：使用 `src/sprites/coros/`（统一蓝色圆形 + 白色字形），由构建脚本 `tools/build-coros-sprite.js` 从 v4/light 白色字形掩膜生成；该精灵缺省不随主题变色。医院/停车/加油/露营/高尔夫为脚本手绘字形。
- **VCM**：`Q` 层等高线，按 `F`（高程）`% 50` 区分首曲线 / 计曲线，淡棕褐色细线。**没有 hover 高亮**——曾尝试用 `feature-state` 提升不透明度，但实测 36 个 z11 瓦片里 Q 层 43 个要素只有 5 个高程值（`F=600` 跨 15 个瓦片），而 `feature-state` 以 `(sourceLayer, id)` 为键且跨瓦片生效，hover 一条线会点亮整个 source 内所有同高程线。高程天然不唯一，不能当要素 id。
- **全局叠放顺序**：所有图层按 `SLOT_ORDER`（自底向顶：地表/水体 → 道路（支路→高速）→ 步道/铁路 → 图标 → 各类文字）由 `reorderLayers()` 通过 `moveLayer` 重排，保证多源叠放一致。**只在 `updateViewport()` 末尾对整批调用一次**——不要挪回 `loadEntry()` 内部：单 VSM 源 27 层 × 最多 24 源，逐层触发会变成单次刷新约 7800 次 `moveLayer`。
- **要素 id（`promoteId`）**：VCM **不提升**（见上一条）；VSM / generic 为每个 source-layer 提升数字字段 `E`（缺失则 id 为空，无副作用）。目前没有图层消费 `feature-state`，`promoteId` 只为将来按要素着色预留。
- **类型识别 `detectType`**：优先匹配路径中的 `VCM` / `VSM` 目录，其次匹配文件名 `C` / `S` 前缀，最后按 `.pmtiles` 后缀归为 generic（generic 保留按几何类型 + 随机色的回退渲染）。
- **主题持久化**：选择结果存在 `localStorage` 键 `mapviewer-theme-v2`（缺省 `light`）。v2 键刻意与早期版本的 `dark` 残留隔离；改键名等于让老用户主题重置，需谨慎。
- **要素点击优先级**：`click` 处理会跳过 id 以 `_fill` 结尾的图层，避免半透明面要素压在线 / 点 / 标注之上。`queryRenderedFeatures` 的返回顺序不可依赖，不要改成直接取 `features[0]`。
- **鼠标移动只有一个监听器**：坐标显示与 hover 光标反馈合并注册在 `mousemove` 上（曾有第二个监听器各做一次无层过滤的 `queryRenderedFeatures`）。查询只针对 `refreshHoverableLayers()` 缓存的**非 fill 图层**列表（源增删时重建），且只在命中结果变化时才改 `style.cursor`。新增需要根据 hover 写样式的功能时，先确认要素 id 是否真的唯一，别重蹈 VCM 的覆辙。
- **日志缓冲**：调试日志最多保留 80 行（`debugLines.shift()`），错误行加红色左竖线、警告行加黄色左竖线；所有写入均经 `escapeHtml()`。

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
- `tools/` 下只有 `build-coros-sprite.js` 入库；其余临时调试脚本、截图与采样产物保持未跟踪状态，不要顺手 `git add tools/`。

## Windows / PowerShell 约定

- 涉及 PowerShell 的命令默认使用 **PowerShell 7（pwsh）**，而非 Windows PowerShell 5.1（powershell.exe）。
- 文本文件统一使用 UTF-8 编码与 LF 行尾（Git 已配置自动转换提示，属正常现象）。
