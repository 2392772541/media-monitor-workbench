# 个人自媒体监控工作台 V1.0

一套完全运行在你本机 Windows 电脑上的个人自媒体与网站内容监控工作台。采用独立自动化 Chromium 配置目录，**绝对不触碰、不读取、不干扰你的日常 Google Chrome**，所有内容与历史互动快照持久保存在本地 SQLite 数据库中。

## 一、核心特性与边界说明

- **本地访问地址**：默认绑定 `http://127.0.0.1:18910`（仅本机回环访问，不暴露公网）。
- **主浏览器完全隔离**：自动化浏览器配置独立存放在 `browser-profiles/` 下，按平台隔离（`douyin/`、`kuaishou/`、`wechat-channels/`、`x/`、`youtube/`、`other/`），内置任务互斥锁防止并发争抢配置目录。
- **网站内容采集**：按 `RSS 自动发现 → Sitemap → HTTP + Readability 正文提取 → 独立无界面浏览器降级` 优先级轻量采集。
- **去重与互动快照**：基于 `平台作品 ID → 标准化链接 → 内容指纹` 三层去重；同一内容的点赞、播放、评论等数据变化会保留完整历史快照，不覆盖旧记录。
- **平台能力诚实标记**：
  - **普通网站 / RSS**：已接入并验证
  - **YouTube 创作者**：已接入并验证（优先官方频道 RSS，支持独立浏览器）
  - **抖音 / 快手 / X**：已实现独立浏览器适配器与登录态检测，需在“浏览器与登录”页面打开独立窗口完成首次扫码/登录后方可稳定访问受限主页
  - **微信视频号**：受微信生态网页端权限边界限制，仅支持已扫码授权范围状态检测，不对未授权第三方任意博主主页进行绕过抓取

## 二、快速启动与停止

### 1. 一键启动（后台静默运行并打开工作台）
在新电脑克隆仓库后，确保已安装 **Node.js 22.13+（推荐 24+）**，直接双击项目根目录的 **`启动工作台.cmd`**（首次启动会自动安装依赖并编译前端），或手动运行：
```powershell
npm install
npm --prefix frontend install
npm run build
node scripts\start.mjs
```
仅启动后台服务（不自动弹浏览器）：
```powershell
node scripts\start.mjs --no-open
```

### 2. 安全停止服务
直接双击项目根目录的 **`停止工作台.cmd`**，或运行：
```powershell
node scripts\stop.mjs
```

### 3. 设置 Windows 开机自动后台启动（支持异常重启与睡眠恢复补查）
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\register-autostart.ps1"
```
取消开机自启：
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\unregister-autostart.ps1"
```

## 三、独立浏览器登录维护说明

1. 打开工作台左侧菜单 **「浏览器与登录」**。
2. 点击对应平台（如抖音、快手、X）的 **「打开登录窗口」**，系统会弹出一个**完全独立于日常 Chrome 的自动化窗口**。
3. 在弹出的独立窗口中完成扫码或账号验证。
4. 完成后关闭该独立窗口，点击工作台上的 **「检查状态」** 确认已变为“已登录”。
5. 登录凭证仅持久化保存在本机 `browser-profiles/<平台>/` 目录中，已列入 `.gitignore`，绝不会打印到日志或上传网络。

## 四、数据库与备份说明

- 数据库引擎：Node.js 25 原生 `node:sqlite` + WAL 模式 + FTS5 全文检索，数据文件位于 `data/workbench.db`。
- 手动备份：在工作台 **「系统设置」** 中点击 **「立即备份本地数据库」**，将在 `backups/` 生成一致的 `.db` 备份文件。

## 五、常见故障排查

- **端口 18910 被占用**：可设置环境变量 `$env:MMW_PORT = 18920` 后启动，或通过 `node scripts\stop.mjs` 停止旧实例。
- **某个博主采集提示“需要登录”**：平台会话已失效或遇到安全验证，前往「浏览器与登录」打开对应平台独立窗口重新扫码即可，后台会自动停止无效重试。
- **找不到 Playwright 浏览器**：工作台默认复用本机 `%LocalAppData%\ms-playwright` 中的 Chromium 缓存，也可设置环境变量 `$env:MMW_CHROMIUM_PATH` 指向任意独立 Chromium 可执行文件。

## 六、测试验证命令

- 构建前后端：`npm run build`
- 单元测试：`npm test`
- 独立浏览器隔离验证：`node tests/verify-browser-isolation.mjs`
- 全流程真实 UI 端到端测试：`node tests/e2e-real-workbench.mjs`

## 七、一体化视频批量发布与标题文案库（已内置 `sau-engine`）

本仓库已把原 `social-auto-upload` 发布引擎直接整合至 `sau-engine/` 目录，无需再开两个服务：

- **单入口一键全启**：运行 `启动工作台.cmd` 打开 `http://127.0.0.1:18910` 后，工作台后台会自动静默拉起内置发布引擎；运行 `停止工作台.cmd` 时会一并关闭所有托管进程。
- **多平台批量发布矩阵**：支持抖音、快手、小红书、微信视频号同时勾选账号、拖拽批量上传视频、按视频独立或统一配置标题/话题、并生成定时排期预览。
- **独立标题文案库 & 发布历史**：内置 SQLite 标题文案模板库（按分类增删改查、批量顺序/随机分配）以及发布历史记录与一键复用重发。
- **新电脑首次使用**：如果尚未配置 Python 环境，在工作台 **「视频发布」** 页面直接点击 **「一键配置发布环境」** 即可自动完成初始化。
