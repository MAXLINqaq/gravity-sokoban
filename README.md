# 重力推箱子（gravity-sokoban）

手机网页重力推箱子 MVP。规格唯一来源：[docs/GAME_DESIGN.md](docs/GAME_DESIGN.md) v0.2。
零构建、零外部依赖、无框架：原生 ES modules + Canvas 2D。

## 本地跑

```powershell
cd C:\Workspace\game-demos\gravity-sokoban
python -m http.server 8787
```

浏览器打开 <http://localhost:8787/>（必须走 http，`file://` 下 ES module 会被拦）。
桌面：方向键移动，Z 撤销，R 重开。手机：倾斜或方向按钮；首次会要求平放校准一次。

- 传感器：`DeviceOrientationEvent` 的 `beta/gamma`（度），触发 20.5°、回正 5.7° 保持 80ms、轴比 2.0，纯轴不做除法。
- 校准：约 200 帧均值当零偏，存 `localStorage`（`lb.gravity.calib`）；平放读数超 17° 会提示重校。
- 切后台/锁屏：监听暂停、`armed` 重置，回前台静默丢弃 200ms 样本。
- 兜底：无传感器 / 权限被拒 / 非 HTTPS 直接按钮模式；挂监听 3 秒无数据也切按钮，并在顶部提示。

## 自测

```powershell
node tests/core.test.mjs      # 内核：A1–A8 + §2.6 边界，20 项
node tests/playtest.mjs       # 无头 Chrome 按最优解点通 12 关 + UI/拖拽/撤销，29 项
node tests/cdp-game.test.mjs  # 游戏页传感器：原 15 条等价断言 + A4/A9/A11，30 项
```

`playtest.mjs` 会起本地服务、开无头 Chrome、逐关执行求解器最优解，并断言每一步页面状态与
Node 端同一内核逐格一致，截图写到 `shots/`。

## 部署到 GitHub Pages

发布包只需 6 个文件、约 49KB：`index.html`、`css/app.css`、`js/core.js`、`js/levels.js`、`js/main.js`、`js/sensor.js`。
仓库根目录就是站点根，所有资源用相对路径——项目页地址是 `https://<user>.github.io/gravity-sokoban/` 这种子路径，
本地已按 `/gravity-sokoban/` 模拟跑通（`node tests/pages-sim.test.mjs`，8/8）。

1. 新建**公开**仓库 `gravity-sokoban`（免费版 Pages 只支持公开仓库）；
2. push 到 `main`；
3. Settings → Pages → Source: `Deploy from a branch` → `main` / `/(root)`；
4. 访问 `https://<user>.github.io/gravity-sokoban/`。

根目录已放 `.nojekyll`，避免 Pages 走 Jekyll 处理。更新后浏览器缓存约 10 分钟，急用可加 `?v=2` 刷新。

## 结构

```
index.html          单页入口
css/app.css         布局与视觉
js/core.js          纯规则内核（结算/挡块/撤销/触发状态机），无 DOM
js/sensor.js        DeviceOrientation 输入：校准、配置、异常帧、后台重置
js/levels.js        12 关数据（由 scripts/gen-levels.mjs 从 docs/levels_v1.json 生成）
js/main.js          Canvas 渲染、拖拽、方向键、选关/撤销/重开、传感器接线
scripts/            关卡数据与求解器序列的生成脚本（开发期，不是构建步骤）
tests/              内核自测 + 真浏览器验收
shots/              验收截图
```

## 约定

- 阈值只存一套度数：触发 20.5°、回正 5.7°、回正保持 80ms、轴比 2.0（无单位）。
- 步数只统计倾斜；拖拽不计步、不进撤销栈；撤销 = 回到最近一次倾斜前的完整快照。
- 箱记 `B`、目标 `T`、墙 `#`、地板 `.`、挡块初始位 `K`；严格 7 列 × 9 行。
- 进度存 `localStorage`，key 前缀 `lb.gravity.`。
