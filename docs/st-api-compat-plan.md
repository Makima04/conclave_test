# ST API 自动提取与兼容层计划书

## 目标

让 Conclave 不再靠人工逐个排查角色卡交互依赖，而是从角色卡 JSON 的 HTML/JS 模板中自动提取 SillyTavern API 依赖，再参考 `/Users/makima/program/SillyTavern-release` 源码实现 iframe 容器的 ST 兼容层。

## 约束

- 所有代码定位、调用链分析和修改前先使用 CodeGraph。
- Conclave 本项目优先查询 `/Users/makima/program/Conclave` 的 CodeGraph。
- 涉及 SillyTavern API 语义时，优先查询 `/Users/makima/program/SillyTavern-release` 的 CodeGraph。
- 角色卡 JSON 只能可靠提供“依赖名称和调用形态”，真实语义必须以 SillyTavern 源码或兼容层设计为准。

## 执行计划

- [x] 1. 确认 Conclave 与 SillyTavern CodeGraph 状态。
- [x] 2. 创建计划书和日志文档。
- [x] 3. 从角色卡 JSON 扫描 ST API 依赖。
- [x] 4. 用 SillyTavern 源码核对 API 语义。
- [x] 5. 实现后端依赖扫描接口。
- [x] 6. 实现前端 iframe ST shim 注入。
- [ ] 7. 验证构建和交互路径。
  - [x] 7.1 命令行构建验证。
  - [x] 7.2 修复用户侧控制台暴露的 iframe 脚本挂载崩溃。
  - [x] 7.3 修复用户侧二次脚本执行错误。
  - [ ] 7.4 用户侧浏览器交互复测。
- [x] 8. 更新最终日志和交付说明。
- [x] 9. 迁移为 ST 风格宿主。
  - [x] 9.1 修复后端正则替换 `$` 被误当捕获组的问题。
  - [x] 9.2 移除前端 React/iframe 运行链路。
  - [x] 9.3 新建原生 DOM 的 STHost 页面入口。
  - [x] 9.4 在同一 window 注入 ST/TavernHelper 兼容 runtime。
  - [x] 9.5 按 ST 顺序写入 HTML、加载样式、执行脚本。
  - [x] 9.6 命令行构建和测试验证。
- [x] 10. 用真实前端依赖替代 lite 运行时。
  - [x] 10.1 本地安装并注入 `jquery@3.7.1`。
  - [x] 10.2 本地安装并注入 `lodash@4.17.21`。
  - [x] 10.3 本地安装并注入 `@fortawesome/fontawesome-free@6.4.2`。
  - [x] 10.4 跳过卡片内 Font Awesome CDN 链接，避免被拦截资源继续污染控制台。
  - [x] 10.5 参考 JS-Slash-Runner 补齐当前卡片依赖的 ST 全局对象和变量 API。
  - [x] 10.6 实现首楼 `swipes` / `swipe_id` 切换后的页面刷新。
- [x] 11. 修复 alternate greeting 开场白渲染。
  - [x] 11.1 将 Rust 正则替换改为 JS/ST 风格的安全 `$` 展开。
  - [x] 11.2 保留卡片 HTML/JS 中的 `$fabaoGrid`、`${fb.id}` 等字面量。
  - [x] 11.3 展开对话美化、事件卡片等 regex replacement 中的 `$1`、`$2`、`$10` 捕获组。
  - [x] 11.4 首楼纯 `swipe_id` 切换延迟刷新，避免卡片脚本异步关闭 modal 时 DOM 已被替换。
  - [x] 11.5 调整 ST Host 消息容器布局，避免普通文本节点被 flex 横向挤压成窄列。
  - [ ] 11.6 用户侧浏览器复测。
- [x] 12. 导入、世界书预览和状态栏原因分析。
  - [x] 12.1 后端当前卡片从编译期固定值改为运行时 `RwLock<CardData>`。
  - [x] 12.2 新增 `/api/import-card`，导入 JSON 后切换当前卡片并重置初始状态。
  - [x] 12.3 `/api/init` 和 `/api/import-card` 返回世界书条目与 TavernHelper 脚本摘要。
  - [x] 12.4 前端支持导入 JSON，以及从 PNG 的 `tEXt`/未压缩 `iTXt` 中抽取角色卡 JSON。
  - [x] 12.5 初版左侧/右侧布局和返回开场。
  - [x] 12.6 分析“灵”悬浮按钮缺失原因：状态栏来自 `data.extensions.tavern_helper.scripts` 外部导入脚本，旧宿主未加载该脚本来源。
  - [x] 12.7 初版本地“灵”按钮 fallback 已验证方向错误，后续由 Step 13 废弃。
  - [ ] 12.8 用户侧浏览器复测。
- [x] 13. 修正为卡片自带 ST/TavernHelper 行为。
  - [x] 13.1 后端维护已导入角色卡/世界书包列表，并支持切换当前导入项。
  - [x] 13.2 `/api/init`、`/api/import-card`、`/api/select-card` 返回导入列表、当前导入项和 TavernHelper 脚本原文。
  - [x] 13.3 左侧栏改为“已导入世界书”列表，不再显示当前卡内部 `character_book.entries` 明细。
  - [x] 13.4 前端按顺序执行卡片自带 `data.extensions.tavern_helper.scripts[].content`。
  - [x] 13.5 移除本地硬编码“灵”悬浮按钮和状态面板 fallback。
  - [ ] 13.6 用户侧浏览器复测。
- [x] 14. 修复开场白切换后的状态栏变量同步。
  - [x] 14.1 分析状态栏数值不更新原因：文本 swipe 已切换，但 `swipes_data` 仍是默认 MVU 数据。
  - [x] 14.2 前端从每个开场白原文的 `<UpdateVariable><initvar>` 解析缩进变量块，生成对应 `stat_data`。
  - [x] 14.3 初始化首楼 `swipes_data` 时按 swipe 写入对应变量数据。
  - [x] 14.4 `setChatMessages` 只切换 `swipe_id` 时同步 `message.data`、`runtimeState.mvuData` 并广播 MVU 更新事件。
  - [x] 14.5 TavernHelper 脚本加载完成后主动广播一次当前变量，避免状态栏漏掉初始值。
  - [ ] 14.6 用户侧浏览器复测。
- [x] 15. 修复多导入卡运行隔离与存档。
  - [x] 15.1 导入 JSON/PNG 后把解析出的原始角色卡 JSON 保存到 `backend/data/imported_cards/`。
  - [x] 15.2 后端启动时扫描 `backend/data/imported_cards/`，把历史导入卡恢复到左侧导入列表。
  - [x] 15.3 切换卡片前清理上一张卡追加到 `body/head` 的运行时 DOM 和脚本节点。
  - [x] 15.4 保护宿主 `body/#root/.st-host` 的基础布局，降低卡片 CSS 外溢导致窄栏或背景污染的概率。
  - [x] 15.5 增加通用首楼 opening swipe 左右切换控件，支持依赖 ST 右滑开场的普通角色卡。
  - [ ] 15.6 用户侧浏览器复测。
- [x] 16. 修复非苍玄界卡的 prompt/display 正则差异。
  - [x] 16.1 检查已落盘导入卡，确认不是导入次数限制，而是开场字段和局部正则形态不同。
  - [x] 16.2 显示渲染管线跳过 `promptOnly`-only 脚本，避免 Prompt 清理脚本抢先覆盖 UI。
  - [x] 16.3 代码围栏剥离支持 ` ```html <...` 和 ` ``` <...` 等非换行写法。
  - [x] 16.4 增加回归测试覆盖同一匹配下 promptOnly/display 脚本顺序，以及 inline/unlabeled HTML 代码围栏。
  - [ ] 16.5 用户侧浏览器复测。
- [x] 17. 修复卡片自带状态栏 UI 触发。
  - [x] 17.1 按 SillyTavern 源码修正显示正则为普通显示阶段 + `markdownOnly` 阶段。
  - [x] 17.2 让 `promptOnly + markdownOnly` 脚本在显示阶段继续运行，避免变量更新块外露。
  - [x] 17.3 对定义了 `<StatusPlaceHolderImpl/>` 显示正则、但开场未携带占位的卡，渲染时补入占位并使用卡片自己的状态栏 HTML。
  - [x] 17.4 为 `promptOnly + markdownOnly` 显示脚本增加回归测试。
  - [ ] 17.5 用户侧浏览器复测。
- [x] 18. 修复内含三反引号的整页 HTML 围栏。
  - [x] 18.1 检查 `路人女主...` 卡，确认替换结果是外层 HTML 代码围栏，内部脚本还包含三反引号正则。
  - [x] 18.2 围栏剥离优先识别整段外层 HTML fence，保留内部 JS 正则字面量。
  - [x] 18.3 增加回归测试覆盖外层 HTML fence + 内部 `/```...```/g`。
  - [ ] 18.4 用户侧浏览器复测。
- [x] 19. 修复 `_.set(...)` 变量更新未进入状态栏数据。
  - [x] 19.1 检查 `变身少女...` 状态栏脚本，确认它读取 `getChatMessages(getCurrentMessageId())[0].data.stat_data`。
  - [x] 19.2 前端解析 `<UpdateVariable>` 内的 `_.set(path, old, new)`，写入对应 swipe 的 `stat_data`。
  - [x] 19.3 `_.set` 三参数按 `[current, previous]` 存储，满足状态栏 `SafeGetValue(...)[0]` 读取当前值。
  - [x] 19.4 暴露 `getCurrentMessageId()` 到全局和 `TavernHelper`。
  - [ ] 19.5 用户侧浏览器复测。
- [x] 20. 修复动态状态栏初始化与空状态栏误触发。
  - [x] 20.1 收窄 `<StatusPlaceHolderImpl/>` 自动补入条件：仅对携带 `<initvar>` 或 `<UpdateVariable>` 的消息补入。
  - [x] 20.2 增加回归测试，覆盖说明页不触发状态栏、变量消息触发状态栏。
  - [x] 20.3 前端兼容动态卡片脚本晚注册 `DOMContentLoaded` 的情况，确保状态栏自带初始化脚本会执行。
  - [x] 20.4 命令行验证：`cargo test`、`npm run lint`、`npm run build`。
  - [ ] 20.5 用户侧浏览器复测。
- [x] 21. 修复整页卡 UI 打包残留全局依赖。
  - [x] 21.1 用内置浏览器复现 `路人女主...` 空白，确认后端已返回完整 HTML、前端报 `ReferenceError: Vue is not defined`。
  - [x] 21.2 前端在 classic script 环境注册全局 `Vue` 标识，兼容打包产物里残留的裸 `Vue;` external marker。
  - [x] 21.3 对 inline module 卡脚本提供按当前卡隔离的 `localStorage` / `indexedDB` / `BroadcastChannel` 视图，避免同源残留存档污染整页 UI 初始化。
  - [x] 21.4 命令行验证：`npm run lint`、`npm run build`。
  - [x] 21.5 内置浏览器复测。

## 设计草案

### 后端

- 在 Rust 后端新增 ST 运行时依赖分析模块。
- 输入来源：
  - `data.extensions.regex_scripts[].replaceString`
  - `data.first_mes`
  - `data.alternate_greetings`
  - 后续可扩展到 `character_book.entries[].content`
- 输出结构：
  - `globals`: 直接访问的全局对象或函数，例如 `triggerSlash`、`Mvu`、`eventEmit`
  - `parent_globals`: `parent.*` 访问，例如 `parent.Mvu`
  - `window_globals`: `window.*` 访问，例如 `window._`
  - `libraries`: jQuery、lodash 等库依赖
  - `events`: 事件名，例如 `VARIABLE_UPDATE_ENDED`
  - `slash_commands`: 可静态识别的 slash command
  - `warnings`: 不能静态确认但需要运行时捕获的依赖

### 前端

- `IframeSandbox` 接收后端返回的 runtime requirements。
- 在写入角色卡 HTML 前注入 `stRuntimeShim`。
- shim 负责：
  - 提供 `triggerSlash` bridge。
  - 提供基础 `eventEmit`/`eventSource` 兼容。
  - 提供最小可用 `Mvu` 对象。
  - 提供 lodash 子集或运行时替代。
  - 记录未实现 API，并通过 `postMessage` 发回 React 外层。

### ST Host 前端修订

- 通用库不再手写 lite 版本：
  - `$` / `jQuery` 使用本地 `jquery@3.7.1`。
  - `_` / `lodash` 使用本地 `lodash@4.17.21`。
  - 图标使用本地 `@fortawesome/fontawesome-free@6.4.2`。
- Conclave 仍需自己实现 ST 专属宿主能力：
  - `TavernHelper`
  - `SillyTavern.getContext`
  - `getChatMessages` / `setChatMessages` / `setChatMessage`
  - `getLorebookEntries` / `setLorebookEntries`
  - `eventOn` / `eventOnce` / `eventEmit`
  - `initializeGlobal` / `waitGlobalInitialized`
  - `getVariables` / `insertVariables` / `insertOrAssignVariables`
  - `Mvu.getMvuData` / `Mvu.replaceMvuData`

### 验证

- 后端测试：扫描当前 `cangxuan_v1.0.20.json` 能输出关键依赖。
- 前端测试：启动页面后按钮点击不因缺 API 报错。
- 构建测试：Rust 后端和 Vite 前端至少完成编译或 lint/build 验证。
