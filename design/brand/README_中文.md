# SFL 图标源文件

v2 保留 v1 已确认的主题：叠层卡片形成的 F 形、密度曲线、三根柱形，以及开放式的双层折角轮廓。这一版修了几何瑕疵，并调整了配色。这个目录不随插件或 npm 包分发。

**18 个独立图标 SVG + 1 张可编辑 SVG 总览。** 所有图形均由路径、矩形和少量渐变组成；无嵌入 PNG、无外部图片、无脚本、无外链字体。

## 相对 v1 的修改

### 图层重叠与几何瑕疵

| 位置 | v1 的问题 | v2 的处理 |
| --- | --- | --- |
| 开放标志双轨道 | 前轨道顶部压进后轨道 2 单位，左侧却留 4 单位缝，单色版粘连成月牙 | 两条轨道同心、等厚，全程间隙固定为 10 单位 |
| 轨道端点 | 下端两侧不对称，右端在单色版粘成“云朵” | 统一为圆头，端点按固定台阶排列 |
| 次曲线 | 被主曲线直接盖住 | 重画为独立形状，与主曲线保持 8 单位间隙 |
| 模块与纸面 | 模块是另一个圆角矩形，叠在纸面上，主图标还露出灰带 | 取消独立模块层，F 形是一整张纸面 |
| F 形内角 | 有尖锐楔口 | 改为真正的内凹圆角 |
| 三层卡片 | 用非等比缩放得到，台阶不均，圆角变形 | 每层在两个方向都退 34 单位，左上角同心 |
| 深度阴影 | 排在所有卡片之下，基本被遮住 | 移到前卡片正下方 |
| 柱形 | 在模块内偏离中心 | 水平居中 |
| 曲线 | 两端有小疙瘩；开放标志里尾部超出轨道 | 尾部平滑接入基线，右端与轨道对齐 |
| 整体位置 | 在底板上偏右下 | 外框居中：x 78–434，y 76–436 |
| 小尺寸 | 24 px 由 32 px 缩放而来，容易发虚 | 32 / 24 / 16 px 各自按像素网格绘制 |

### 配色

底板是翠绿 `#129C63`。v1 的色阶是深底、浅后卡、深中卡、白前卡，明暗来回跳；v2 改为从底板到前卡逐层变亮。最高的一根柱形使用琥珀色 `bar_accent`。

图标颜色和界面主色是分开的：界面主色 `#246C4E` 与官网强调色 `#0d8077` 没有改动。

## 实际使用的位置

| 实际文件 | 来自 | 用途 |
| --- | --- | --- |
| `assets/brand/sfl-logo.svg`、`skills/figure-library/assets/sfl-logo.svg` | `svg/01-app-primary.svg` | 插件、MCP、本地 App 和 MCP App 的界面图标 |
| `assets/brand/sfl-favicon.svg` | `svg/13-icon-16.svg` | 本地 App 的标签页图标 |
| `docs/assets/logo.svg` | `svg/01-app-primary.svg` | 官网首屏 |
| `docs/assets/logo-nav.svg` | `svg/11-icon-32.svg` | 官网导航栏和页脚 |
| `docs/assets/favicon.svg` | `svg/13-icon-16.svg` | 官网标签页图标 |
| `desktop/windows/shell/winres/icon*.png` | 由 `source/export-png.mjs` 导出 | `SFL.exe`，含 256 到 16 px 六个尺寸 |
| `desktop/macos/AppIcon.png` | 由 `source/export-png.mjs` 导出 | macOS 应用图标 |

`docs/assets/banner.svg` 和 `.github/assets/sfl-banner.svg` 内嵌了 `svg/06-brandmark-open.svg`，换图标时需要手动同步。

## 最先打开哪个文件

- 只想手动改颜色：`svg/02-app-flat.svg`。它没有渐变，所有色块使用直接的 `fill`。
- 希望保留轻微层次：`svg/01-app-primary.svg`。
- 想看完整套件：`index.html`，或者 `00-overview.svg`。

## 文件索引

| 文件 | 用途 |
| --- | --- |
| `01-app-primary.svg` | 主图标；分层、轻渐变、可删除的矢量深度层 |
| `02-app-flat.svg` | 主图标的纯色版本，最便于手动换色 |
| `03-app-light.svg` | 浅色背景版本 |
| `04-app-dark.svg` | 深色背景上的开放式品牌标志 |
| `05-brandmark-paper.svg` | 无外框、透明底的叠层卡片标志 |
| `06-brandmark-open.svg` | 无外框、透明底的开放式品牌标志 |
| `07-brandmark-monochrome.svg` | 深色单色标志；柱形为真实透明镂空 |
| `08-brandmark-reverse.svg` | 反白单色标志；适合深色承载面 |
| `09-brandmark-currentcolor.svg` | 单色主题版本；图形填色使用 `currentColor` |
| `10-icon-64.svg` | 64 px 版本；保留两条密度曲线 |
| `11-icon-32.svg` | 32 px 版本；保留三层卡片与三根柱，省略次曲线 |
| `12-icon-24.svg` | 24 px 版本；同上，几何按 24 px 网格重画 |
| `13-icon-16.svg` | 16 px favicon；两层卡片、一条曲线、三根微型柱 |
| `14-app-square-source.svg` | 无预裁圆角的全方形底图，用作平台转换源 |
| `15-app-inset-source.svg` | 全方形底、主体缩到 80%，供宿主裁切时留出余量 |
| `16-wordmark-dark.svg` | 深色横版标志与可编辑文字组合 |
| `17-wordmark-reverse.svg` | 反白横版标志与可编辑文字组合 |
| `18-symbol-16-monochrome.svg` | 16 px 单色小标志，无外框 |

以上文件位于 `svg/`。`00-overview.svg` 是额外的可编辑展示板。

## 统一修改整套配色

修改 `palette.json` 后，在本目录运行（需要 Python 3.10 或更新版本，不需要第三方库）：

```bash
python source/build_svg.py
```

这个命令会重新生成 SVG、总览、`index.html`、`manifest.json` 和 `validation-report.json`，并覆盖同名文件，手工改过路径的话请先备份。

之后按上面的表格复制 SVG，再在仓库根目录导出 PNG（需要 Chromium 内核浏览器，路径可用 `SFL_BROWSER` 指定）：

```bash
node design/brand/source/export-png.mjs
```

`tests/plugin-manifests.test.ts` 会检查实际使用的 SVG 与这里的源文件是否一致。

| 色彩键 | 控制对象 |
| --- | --- |
| `tile` / `tile_highlight` / `tile_shadow` | 底板及其渐变，`tile_shadow` 也用于深度阴影 |
| `ink` / `ink_highlight` | 主曲线、开放标志模块、单色标志、横版标志 |
| `card_back` / `card_back_light` | 后层卡片及其渐变 |
| `card_middle` / `card_middle_light` | 中层卡片及其渐变 |
| `paper` / `paper_highlight` / `paper_shadow` | 前方纸面、纸面渐变、反白副标题 |
| `curve_secondary` | 次密度曲线 |
| `bar` / `bar_light` / `bar_accent` | 柱形：常规色、深色模块上的浅色、强调色 |
| `light_surface` / `dark_surface` | 浅色与深色承载面 |
| `reverse` | 反白标志 |
| `text` / `text_secondary` / `board_background` / `divider` | 总览和说明页 |

横版组合里的文字仍是可编辑 `<text>`，使用系统字体回退，不同环境宽度可能略有差异。定稿后建议转成路径。

图内的密度曲线与柱形是品牌识别图案，不表达真实实验数据。
