/*
 * build-coros-sprite.js
 *
 * 生成对齐 COROS 手表外观的统一蓝色圆形 POI 图标精灵：
 *   src/sprites/coros/sprite.png   + sprite.json      (1x, cell 24, pixelRatio 1)
 *   src/sprites/coros/sprite@2x.png + sprite@2x.json  (2x, cell 48, pixelRatio 2)
 *
 * 字形来源：src/sprites/v4/light.png 中彩色徽章内的白色 Maki 字形（仅取近白像素作掩膜）。
 * 缺失图标（hospital / parking / fuel / campsite / golf / dot）用简单矢量形状手绘。
 *
 * 仅为构建期开发工具，不进入应用运行时（应用完全离线的约束不受影响）。
 */
"use strict";

var fs = require("fs");
var path = require("path");
var PNG = require("pngjs").PNG;

var ROOT = path.resolve(__dirname, "..");
var SRC_SPRITE = path.join(ROOT, "src", "sprites");

/* ---------- 图标清单 ---------- */

// 从 v4/light 提取白色字形的图标
var GLYPH_ICONS = [
    "aerodrome", "attraction", "bar", "cafe", "clothes", "convenience",
    "fast_food", "forest", "garden", "park", "bus_stop", "train_station",
    "stadium", "peak", "supermarket", "museum", "restaurant", "school",
    "university", "theatre", "library"
];

// 手绘图标
var CUSTOM_ICONS = ["hospital", "parking", "fuel", "campsite", "golf", "dot"];

var ALL_ICONS = GLYPH_ICONS.concat(CUSTOM_ICONS);

/* ---------- 基础光栅助手（操作单图标 RGBA buffer） ---------- */

function makeBuf(size) {
    return { size: size, data: new Uint8Array(size * size * 4) };
}

function setPx(b, x, y, c) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= b.size || y >= b.size) return;
    var i = (y * b.size + x) * 4;
    // 与底色做简单 source-over（c 已含 alpha）
    var a = c[3] / 255;
    b.data[i] = Math.round(c[0] * a + b.data[i] * (1 - a));
    b.data[i + 1] = Math.round(c[1] * a + b.data[i + 1] * (1 - a));
    b.data[i + 2] = Math.round(c[2] * a + b.data[i + 2] * (1 - a));
    b.data[i + 3] = Math.max(b.data[i + 3], Math.round(a * 255));
}

function stampCircle(b, cx, cy, r, c) {
    var r2 = r * r;
    for (var y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        for (var x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
            var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            if (dx * dx + dy * dy <= r2) setPx(b, x, y, c);
        }
    }
}

function thickLine(b, x0, y0, x1, y1, w, c) {
    var len = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    var steps = Math.max(1, Math.ceil(len / 0.3));
    for (var i = 0; i <= steps; i++) {
        var t = i / steps;
        stampCircle(b, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, c);
    }
}

function fillRect(b, x0, y0, x1, y1, c) {
    for (var y = Math.round(y0); y < Math.round(y1); y++) {
        for (var x = Math.round(x0); x < Math.round(x1); x++) setPx(b, x, y, c);
    }
}

function ring(b, cx, cy, r, w, c, a0, a1) {
    if (a0 === undefined) a0 = 0;
    if (a1 === undefined) a1 = Math.PI * 2;
    var steps = Math.ceil((a1 - a0) * r / 0.25);
    for (var i = 0; i <= steps; i++) {
        var t = a0 + (a1 - a0) * (i / steps);
        stampCircle(b, cx + Math.cos(t) * r, cy + Math.sin(t) * r, w / 2, c);
    }
}

function fillTriangle(b, p0, p1, p2, c) {
    var minX = Math.min(p0[0], p1[0], p2[0]), maxX = Math.max(p0[0], p1[0], p2[0]);
    var minY = Math.min(p0[1], p1[1], p2[1]), maxY = Math.max(p0[1], p1[1], p2[1]);
    function sign(a, p, q) {
        return (a[0] - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (a[1] - q[1]);
    }
    for (var y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
        for (var x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
            var pt = [x + 0.5, y + 0.5];
            var d1 = sign(pt, p0, p1), d2 = sign(pt, p1, p2), d3 = sign(pt, p2, p0);
            var neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
            var pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
            if (!(neg && pos)) setPx(b, x, y, c);
        }
    }
}

/* ---------- 手绘白色字形 ---------- */

var WHITE = [255, 255, 255, 255];

function drawCustom(b, name) {
    var s = b.size;
    if (name === "hospital") {
        var t = s * 0.16, L = s * 0.62, c0 = s / 2;
        fillRect(b, c0 - t / 2, c0 - L / 2, c0 + t / 2, c0 + L / 2, WHITE);
        fillRect(b, c0 - L / 2, c0 - t / 2, c0 + L / 2, c0 + t / 2, WHITE);
    } else if (name === "parking") {
        // 竖杠 + 右侧圆环，近似 P
        fillRect(b, s * 0.28, s * 0.22, s * 0.42, s * 0.78, WHITE);
        ring(b, s * 0.50, s * 0.40, s * 0.17, s * 0.11, WHITE, -Math.PI / 2, Math.PI / 2);
        thickLine(b, s * 0.50, s * 0.23, s * 0.50, s * 0.57, s * 0.11, WHITE);
    } else if (name === "fuel") {
        // 加油机机身 + 顶部油枪
        fillRect(b, s * 0.32, s * 0.32, s * 0.56, s * 0.78, WHITE);
        fillRect(b, s * 0.56, s * 0.26, s * 0.68, s * 0.36, WHITE);
        thickLine(b, s * 0.56, s * 0.30, s * 0.70, s * 0.30, s * 0.09, WHITE);
        ring(b, s * 0.66, s * 0.52, s * 0.12, s * 0.08, WHITE, -Math.PI / 4, Math.PI / 2);
    } else if (name === "campsite") {
        // 帐篷：两条斜边 + 底线
        thickLine(b, s * 0.26, s * 0.74, s * 0.50, s * 0.28, s * 0.10, WHITE);
        thickLine(b, s * 0.50, s * 0.28, s * 0.74, s * 0.74, s * 0.10, WHITE);
        thickLine(b, s * 0.22, s * 0.76, s * 0.78, s * 0.76, s * 0.09, WHITE);
    } else if (name === "golf") {
        // 旗杆 + 三角旗
        thickLine(b, s * 0.42, s * 0.24, s * 0.42, s * 0.78, s * 0.07, WHITE);
        fillTriangle(b, [s * 0.42, s * 0.24], [s * 0.72, s * 0.33], [s * 0.42, s * 0.46], WHITE);
    } else if (name === "dot") {
        // 纯蓝圆点，无字形
    }
}

/* ---------- 从 v4/light 提取白色字形掩膜并盖到蓝圆上 ---------- */

function loadPng(rel) {
    return new Promise(function (resolve, reject) {
        fs.createReadStream(path.join(SRC_SPRITE, rel))
            .pipe(new PNG())
            .on("parsed", function () { resolve(this); })
            .on("error", reject);
    });
}

function loadJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(SRC_SPRITE, rel), "utf8"));
}

// 判断源像素是否为近白（徽章内的白色字形）：三个通道均较高
function isWhiteGlyph(src, idx) {
    return src.data[idx] > 185 && src.data[idx + 1] > 185 && src.data[idx + 2] > 185 &&
        src.data[idx + 3] > 200;
}

function drawGlyphMask(b, src, frame) {
    var s = b.size;
    // 字形目标盒：居中，占 cell 的 66%
    var box = s * 0.66;
    var x0 = (s - box) / 2, y0 = (s - box) / 2;
    for (var ty = 0; ty < box; ty++) {
        for (var tx = 0; tx < box; tx++) {
            var sx = frame.x + (tx / box) * frame.width;
            var sy = frame.y + (ty / box) * frame.height;
            var sxi = Math.floor(sx), syi = Math.floor(sy);
            if (sxi < 0 || syi < 0 || sxi >= src.width || syi >= src.height) continue;
            if (isWhiteGlyph(src, (syi * src.width + sxi) * 4)) {
                setPx(b, x0 + tx, y0 + ty, WHITE);
            }
        }
    }
}

/* ---------- 组装整张精灵 ---------- */

var BLUE = [58, 134, 209, 255];       // #3a86d1，手表中蓝
var BLUE_EDGE = [40, 105, 170, 255];  // 细描边

function buildIcon(name, size, srcPng, frames) {
    var b = makeBuf(size);
    // 蓝色圆底 + 极细描边
    stampCircle(b, size / 2, size / 2, size * 0.47, BLUE);
    ring(b, size / 2, size / 2, size * 0.47, Math.max(1, size * 0.03), BLUE_EDGE);
    if (CUSTOM_ICONS.indexOf(name) >= 0) {
        drawCustom(b, name);
    } else {
        drawGlyphMask(b, srcPng, frames[name]);
    }
    return b;
}

async function buildScale(cell, scale, srcRel, frameRel, outPng, outJson, pixelRatio) {
    var srcPng = await loadPng(srcRel);
    var frames = loadJson(frameRel);

    var cols = Math.ceil(Math.sqrt(ALL_ICONS.length));
    var rows = Math.ceil(ALL_ICONS.length / cols);
    var W = cols * cell, H = rows * cell;
    var sheet = new PNG({ width: W, height: H });
    var json = {};

    for (var i = 0; i < ALL_ICONS.length; i++) {
        var name = ALL_ICONS[i];
        var icon = buildIcon(name, cell, srcPng, frames);
        var col = i % cols, row = Math.floor(i / cols);
        var ox = col * cell, oy = row * cell;
        for (var yy = 0; yy < cell; yy++) {
            var si = yy * cell * 4;
            var di = ((oy + yy) * W + ox) * 4;
            icon.data.subarray(si, si + cell * 4).forEach(function (v, k) {
                sheet.data[di + k] = v;
            });
        }
        json[name] = { x: ox, y: oy, width: cell, height: cell, pixelRatio: pixelRatio };
    }

    var outDir = path.join(SRC_SPRITE, "coros");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, outPng), PNG.sync.write(sheet));
    fs.writeFileSync(path.join(outDir, outJson), JSON.stringify(json, null, 2) + "\n");
    console.log("wrote " + path.join("src/sprites/coros", outPng) + " (" + W + "x" + H + ")");
}

(async function () {
    // 1x：源 light.png（19px 徽章），cell 24
    await buildScale(24, 1, path.join("v4", "light.png"), path.join("v4", "light.json"),
        "sprite.png", "sprite.json", 1);
    // 2x：源 light@2x.png（38px 徽章），cell 48
    await buildScale(48, 2, path.join("v4", "light@2x.png"), path.join("v4", "light@2x.json"),
        "sprite@2x.png", "sprite@2x.json", 2);
    console.log("done, " + ALL_ICONS.length + " icons");
})().catch(function (e) { console.error(e); process.exit(1); });
