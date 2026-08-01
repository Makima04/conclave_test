# ST API 自动提取与兼容层执行日志

## 2026-06-14

### Step 1: CodeGraph 状态确认

- Conclave: CodeGraph 索引正常，`13` 个文件，`73` 个节点，状态为 up to date。
- SillyTavern: 源码目录 `/Users/makima/program/SillyTavern-release` 已初始化 CodeGraph；普通沙箱无法直接打开数据库，授权上下文可读取。
- SillyTavern 索引规模：`373` 个文件，`10905` 个节点，`42980` 条边。
- 查询结果：
  - `executeSlashCommands` 命中 `public/scripts/slash-commands.js`。
  - `eventEmit` 没有直接命中同名函数，但命中事件系统 `EventEmitter` 和 `eventSource`。
  - `triggerSlash`、`Mvu` 暂无直接命中，后续需要结合角色卡扫描和文本补查确认来源。

### Step 2: 文档创建

- 已创建计划书：`docs/st-api-compat-plan.md`。
- 已创建执行日志：`docs/st-api-compat-log.md`。

### Step 3: 当前角色卡 JSON 依赖扫描

- 扫描来源：
  - `data.first_mes`
  - `data.alternate_greetings[]`
  - `data.extensions.regex_scripts[].findRegex`
  - `data.extensions.regex_scripts[].replaceString`
  - `data.character_book.entries[].content`
- 当前卡片关键依赖：
  - `triggerSlash` / `parent.triggerSlash`
  - `window.Mvu` / `parent.Mvu`
  - `window.eventEmit` / `parent.eventEmit`
  - `window._` / `parent._`
  - `setChatMessages`
  - `setChatMessage`
  - `getChatMessages`
  - `getLorebookEntries`
  - `setLorebookEntries`
- 静态可识别 slash command：
  - `/echo title="苍玄界" severity=${severity} ${safeText}`
  - `/trigger`
- 静态可识别事件：
  - `VARIABLE_UPDATE_ENDED`
- 关键脚本行为：
  - 角色卡用 `triggerSlash` 执行 ST slash command；失败时退回卡片内部 toast。
  - 自由开局会通过 `Mvu.getMvuData`、`lodash.set`、`Mvu.replaceMvuData` 写入 MVU 状态。
  - 写入后尝试触发 `eventEmit(mvuObj.events.VARIABLE_UPDATE_ENDED, mvuData, mvuData)`。
  - 开场切换依赖 `setChatMessages`、`setChatMessage`、`getChatMessages`。
  - USER 档案写入依赖世界书读写接口 `getLorebookEntries` 和 `setLorebookEntries`。

### Step 4: SillyTavern 源码语义核对

- Slash command：
  - `public/scripts/slash-commands.js` 中 `executeSlashCommandsWithOptions(text, options)` 是核心执行入口。
  - `public/scripts/extensions/third-party/JS-Slash-Runner/src/function/slash.ts` 中 `triggerSlash(command)` 包装 `executeSlashCommandsWithOptions(command)`，错误时抛出异常，成功时返回 `result.pipe`。
  - `/echo` 实现在 `public/scripts/slash-commands.js` 的 `echoCallback(args, value)`，主要调用 `toastr`。
- 事件系统：
  - `public/scripts/events.js` 导出 `eventSource = new EventEmitter(...)`。
  - `public/lib/eventemitter.js` 的 `emit(event, ...args)` 会异步按顺序调用监听器。
  - 卡片里的 `eventEmit` 更接近 JS-Slash-Runner/TavernHelper 暴露的辅助函数，而不是 ST 核心同名导出。
- 聊天消息接口：
  - `public/scripts/extensions/third-party/JS-Slash-Runner/src/function/chat_message.ts` 定义 `getChatMessages`、`setChatMessages`、`setChatMessage`。
  - `getChatMessages(range, options)` 返回规范化后的消息对象，可选 `include_swipes`。
  - `setChatMessages([...], { refresh })` 根据 `message_id` 合并写入 `chat` 数组，并按 `refresh` 刷新 UI。
  - `setChatMessage` 是单消息写入便捷接口。
- 世界书接口：
  - `public/scripts/extensions/third-party/JS-Slash-Runner/src/function/lorebook_entry.ts` 定义 `getLorebookEntries`、`setLorebookEntries` 等。
  - `getLorebookEntries(lorebook)` 读取指定世界书并转换成 JS-Slash-Runner 的 `LorebookEntry` 形状。
  - `setLorebookEntries(lorebook, entries)` 按 `uid` 合并条目后保存。
- MVU：
  - `public/scripts/extensions/third-party/JS-Slash-Runner/@types/iframe/exported.mvu.d.ts` 只提供类型和期望全局 API。
  - 当前卡片实际用到 `Mvu.getMvuData`、`Mvu.replaceMvuData`、`Mvu.events.VARIABLE_UPDATE_ENDED`。
- TavernHelper 全局对象：
  - `public/scripts/extensions/third-party/JS-Slash-Runner/src/function/index.ts` 的 `initTavernHelperObject()` 会执行 `globalThis.TavernHelper = getTavernHelper()`。
  - `getTavernHelper()` 返回的对象包含 `triggerSlash`、聊天消息、世界书、事件等函数集合。

### Step 5: 后端依赖扫描接口

- 新增 `backend/src/st_api_scanner.rs`。
- 新增结构化输出 `StRuntimeRequirements`：
  - `globals`
  - `window_globals`
  - `parent_globals`
  - `libraries`
  - `events`
  - `slash_commands`
  - `required_shims`
  - `warnings`
- `/api/init` 现在会返回 `runtime_requirements`。
- 新增 `GET /api/runtime-requirements`，用于单独调试当前角色卡需要的 ST 兼容层能力。
- 新增单元测试 `st_api_scanner::tests::scans_opening_card_dependencies`。
- 验证：
  - 已运行 `cargo fmt`。
  - 已运行 `cargo test`，结果：`1 passed`。
  - 当前只有既有未使用代码警告，没有新增测试失败。
  - 已运行 `codegraph sync` 同步 Conclave 索引。

### Step 6: 前端 iframe ST shim 注入

- `frontend/src/App.jsx`：
  - 保存 `/api/init` 返回的 `runtime_requirements`。
  - 将 `runtimeRequirements` 传入开场和聊天两个 `IframeSandbox`。
  - `handleSlashCommand` 改为 async，并识别 `/trigger`。
- `frontend/src/components/IframeSandbox.tsx`：
  - 将角色卡 HTML 拆成 `headHtml`、`bodyHtml` 和 `scripts`。
  - 先注入 Conclave ST runtime shim，再执行角色卡脚本，避免脚本早于 bridge 初始化。
  - 内置最小 `jQuery`/`$` 兼容层，覆盖当前卡片需要的事件绑定、class、data、DOM 插入、表单和显示隐藏操作。
  - 注入 `lodash` 子集：`get`、`set`、`unset`、`merge`、`clamp`、`range` 等。
  - 注入 ST/TavernHelper 兼容 API：
    - `triggerSlash`
    - `getChatMessages`
    - `setChatMessages`
    - `setChatMessage`
    - `getLorebookEntries`
    - `setLorebookEntries`
    - `eventOn`
    - `eventEmit`
    - `eventSource`
    - `Mvu`
    - `TavernHelper`
    - `SillyTavern.getContext`
  - 运行时错误通过 `postMessage` 发回 React 外层并记录 console warning。
- `frontend/components/IframeSandbox.tsx` 改为转发新版组件，避免旧副本继续漂移。
- 验证：
  - 已运行 `npm run build`，Vite 构建通过。
  - 已运行 `codegraph sync` 同步 Conclave 索引。

### Step 7.2: 用户侧控制台报错修复

- 用户提供的浏览器控制台关键错误：
  - `IframeSandbox.tsx:541 Uncaught TypeError: Cannot read properties of null (reading 'appendChild')`
  - React 随后报告 `<IframeSandbox>` 组件发生未捕获错误。
- 判断：
  - 报错点位于角色卡脚本执行阶段，旧实现直接调用 `doc.body.appendChild(script)`。
  - 若 `doc.write` 后 iframe 文档壳不完整，或某段卡片脚本执行中改写了 iframe 文档，`doc.body` 可能变为 `null`，从而让 React effect 崩溃。
  - 控制台中的 `allow-scripts` + `allow-same-origin` 是浏览器安全警告，不是本次 `appendChild` 崩溃的直接原因。
- 修复：
  - `frontend/src/components/IframeSandbox.tsx` 新增 `ensureDocumentBody()`，确保 iframe 内存在 `html/head/body`。
  - 新增 `ensureScriptRoot()`，为卡片脚本创建专用隐藏挂载点 `#__conclave-script-root`。
  - 执行每段卡片脚本前重新确认挂载点；如果脚本改写文档，也会重建基本文档壳。
  - 脚本挂载失败时通过 `ST_RUNTIME_ERROR` 上报，而不是让 React 组件未捕获异常崩溃。
- 验证边界：
  - 已运行 `npm run build`，Vite 构建通过。
  - 已运行 `codegraph sync`，同步本次 `IframeSandbox.tsx` 修改。
  - 按用户要求检查并停止本地服务端口：`5173` 上的 Node 进程已停止，`3001` 无监听进程。
  - 按用户要求不启动服务、不使用浏览器验证。
  - 后续交互验证由用户本地执行并反馈控制台结果。

### Step 7.3: 用户侧二次控制台报错修复

- 用户提供的新错误：
  - `Failed to execute 'appendChild' on 'Node': Unexpected token '='`
  - 后续点击触发 `switchView is not defined`。
  - Font Awesome CDN 请求被客户端拦截：`net::ERR_BLOCKED_BY_CLIENT`。
- 判断：
  - `switchView` 是卡片 HTML 内联 `onclick` 依赖的全局入口。
  - 原始卡片业务脚本在本地 Node 解析中语法通过，第 92 行为合法的 `const $fabaoGrid = ...`。
  - 因此问题更可能出在浏览器对动态插入内联 `<script>` 的执行路径，而不是卡片脚本文本本身。
- 修复：
  - `IframeSandbox` 对内联脚本不再创建 `<script>` 后 append。
  - 改为使用 `iframe.contentWindow.Function(...)` 在 iframe window 上下文同步编译执行。
  - 执行后显式将 `switchView` 暴露到 `window.switchView`，满足 HTML 内联 `onclick`。
  - 外部非 jQuery 脚本仍保留 `<script src>` 挂载路径。
  - 执行失败会走 `ST_RUNTIME_ERROR` 上报，不再让动态 append 的语法错误变成未捕获异常。
- 验证：
  - 已运行 `npm run build`，Vite 构建通过。
  - 已运行 `codegraph sync`，同步本次 `IframeSandbox.tsx` 修改。
  - 按用户要求不启动服务、不使用浏览器验证。
- 备注：
  - `allow-scripts` + `allow-same-origin` 仍是浏览器安全警告，不是这次 `switchView` 缺失的直接原因。
  - Font Awesome CDN 被拦截会影响图标显示，但不应阻断核心交互；后续可考虑本地化图标或提供 CSS fallback。

### Step 9: 迁移为 ST 风格宿主

- 决策：
  - 放弃 React + iframe 作为角色卡运行区。
  - 改为原生 DOM 的 STHost：卡片 HTML、CSS、脚本都运行在同一个 `window`，更接近 SillyTavern 的宿主模型。
  - 保留 Rust 后端 `/api/init`、`/api/chat`、`/api/runtime-requirements`。
- 关键根因修复：
  - `backend/src/pipeline/regex_engine.rs` 原先使用 Rust `regex::Regex::replace_all` 的字符串替换模式。
  - Rust regex replacement 会把 `$fabaoGrid`、`${fb.id}` 当作捕获组语法处理，可能把 JS 变量名替空，生成 `const  = ...`，直接导致浏览器 `Unexpected token '='`。
  - 已改为 `regex::NoExpand(...)`，与 ST/JS 卡片模板的字面量替换需求一致。
  - 新增测试 `replacement_keeps_javascript_dollar_identifiers`，覆盖 `$fabaoGrid` 和 `${fb.id}` 不被破坏。
- 前端迁移：
  - 新增 `frontend/src/main.js` 作为唯一入口。
  - `frontend/index.html` 改为加载 `/src/main.js`。
  - `frontend/vite.config.js` 移除 React 插件。
  - `frontend/package.json` 和 `package-lock.json` 移除 React、React DOM、React Vite 插件和 React ESLint 插件依赖。
  - 删除旧 React 入口与 iframe 组件：
    - `frontend/src/main.jsx`
    - `frontend/src/App.jsx`
    - `frontend/src/components/IframeSandbox.tsx`
    - `frontend/components/IframeSandbox.tsx`
- STHost 行为：
  - 直接渲染 `#st-message-area`，不再创建 iframe。
  - 先安装本地 `$`/jQuery-lite、lodash-lite、`triggerSlash`、`eventSource`、`Mvu`、`TavernHelper`、`SillyTavern.getContext`。
  - 再插入卡片 head 资源和 body HTML。
  - 最后按顺序执行卡片脚本，跳过外部 jQuery CDN，避免依赖网络加载 jQuery。
  - 聊天输入继续调用 `/api/chat`，返回 HTML 以同一宿主方式追加渲染。
- 验证：
  - `cargo fmt` 通过。
  - `cargo test` 通过：`2 passed`。
  - `npm run lint` 通过。
  - `npm run build` 通过，Vite 产物 JS 约 `12.91 kB gzip 4.88 kB`。
  - 已运行 `codegraph sync`，同步本次前端删除/新增和后端修改。
  - 按用户要求停止本地监听进程：`5173`、`3000`、`3001` 均已确认无监听。
- 验证边界：
  - 按用户要求不启动服务、不使用浏览器验证。
  - 浏览器交互复测仍需用户本地执行。

### Step 10: 真实依赖与 ST 全局对象修订

- 用户反馈：
  - 当前 ST Host 页面按钮图标没有显示。
  - 角色轮盘可以切换人物，但点击“选定此缘”后无法继续互动。
  - 用户明确要求不要继续手写 `jquery-lite`，改用真实 jQuery；ST 全局对象参考 SillyTavern 源码自行实现一套兼容层。
- CodeGraph / 源码核对：
  - Conclave CodeGraph 定位到 `frontend/src/main.js` 中的 `createJqueryLite`、`createLodashLite`、`setChatMessages`。
  - SillyTavern CodeGraph 可用，但未直接命中 JS-Slash-Runner 聚合符号；补充文本查询后定位：
    - `public/scripts/extensions/third-party/JS-Slash-Runner/src/function/index.ts`
    - `public/scripts/extensions/third-party/JS-Slash-Runner/src/function/chat_message.ts`
    - `public/scripts/extensions/third-party/JS-Slash-Runner/src/function/global.ts`
    - `public/scripts/extensions/third-party/JS-Slash-Runner/src/function/variables.ts`
    - `public/scripts/extensions/third-party/JS-Slash-Runner/src/function/event.ts`
- 依赖调整：
  - 新增并固定 `jquery@3.7.1`。
  - 新增并固定 `lodash@4.17.21`。
  - 新增并固定 `@fortawesome/fontawesome-free@6.4.2`。
  - `frontend/src/main.js` 顶部导入本地 Font Awesome CSS，卡片的 `fa-solid` 图标不再依赖外部 CDN。
  - `installHeadNodes` 跳过卡片内 Font Awesome CDN `<link>`，避免 `ERR_BLOCKED_BY_CLIENT` 持续出现。
- 前端 runtime 调整：
  - 删除手写 `createJqueryLite`。
  - 删除手写 `createLodashLite`。
  - `window.$` / `window.jQuery` 指向真实 jQuery。
  - `window._` / `window.lodash` 指向真实 lodash。
  - 保留并扩展 Conclave 自己负责的 ST 专属 API：
    - `TavernHelper`
    - `SillyTavern.getContext`
    - `getChatMessages` / `setChatMessages` / `setChatMessage`
    - `getLorebookEntries` / `setLorebookEntries`
    - `eventOn` / `eventOnce` / `eventEmit` / `eventRemoveListener`
    - `initializeGlobal` / `waitGlobalInitialized`
    - `getVariables` / `replaceVariables` / `updateVariablesWith`
    - `insertVariables` / `insertOrAssignVariables` / `deleteVariable`
    - `formatAsTavernRegexedString`
    - `Mvu.getMvuData` / `Mvu.replaceMvuData`
  - 首楼消息现在维护 `swipes`、`swipes_data`、`swipes_info` 和本地扩展的 `rendered_swipes`。
  - `setChatMessages([{ message_id: 0, swipe_id }], { refresh: 'affected' })` 会按 ST 语义切换当前首楼 swipe，并重渲染开场消息节点。
- 后端接口调整：
  - `/api/init` 新增 `first_message`，用于前端构造 `swipes[0]`。
  - `/api/init` 和 `/api/greetings` 保留 `rendered_greetings`，用于前端切换首楼时直接渲染对应 alternate greeting。
- 验证：
  - `cargo fmt` 通过。
  - `cargo test` 通过：`2 passed`。
  - `npm run lint` 通过。
  - `npm run build` 通过，Vite 已将 Font Awesome 字体打包进 `dist/assets`。
  - 按用户要求未启动服务、未使用浏览器验证。
  - 已检查并停止本地监听进程：`5173`、`3000`、`3001` 最终均无监听。

### Step 11: alternate greeting 开场白渲染修复

- 用户反馈：
  - 选定角色后的开场白页面显示为横向挤压的窄列。
  - 页面中仍出现 `$1`、`$2` 字面量。
  - 控制台报错：`Cannot read properties of null (reading 'classList')`，来源为卡片脚本延迟关闭 `#cx-char-modal`。
- CodeGraph 定位：
  - 后端替换入口：`backend/src/pipeline/regex_engine.rs::RegexPipeline::process`。
  - 前端刷新入口：`frontend/src/main.js::setChatMessages`、`refreshDisplayedMessage`、`renderCardHtml`。
- 根因：
  - Step 9 为保护 `GameStart` HTML/JS 中的 `$fabaoGrid`、`${fb.id}`，将 Rust regex replacement 改为 `NoExpand`。
  - 这会导致对话美化、事件卡片等真正依赖捕获组的 `$1`、`$2`、`$10` 不再展开。
  - 角色选择脚本在 `setOpeningSwipe` 后 500ms 再执行 `charModal.classList.remove('show')`；Conclave 之前立即重渲染首楼，提前移除了 modal。
  - `.st-assistant-message` 使用 flex 布局，alternate greeting 的普通文本节点和气泡元素被当作横向 flex items 排列，形成截图中的窄列。
- 修复：
  - `RegexPipeline` 新增自定义 replacement 展开：
    - 展开合法数字捕获组 `$1` 到 `$99`。
    - 支持 `$&` 和 `$$`。
    - 捕获组不存在时保留原字面量。
    - `${...}` 仅在命中命名捕获时替换，否则保留为 JS 模板字面量。
  - 新增测试：
    - 保留 `$fabaoGrid` 和 `${fb.id}`。
    - 展开对话正则中的 `$1`、`$2`。
    - 展开 `$10` 两位捕获组。
  - `setChatMessages` 对首楼纯 `swipe_id` 更新延迟 `650ms` 后刷新 DOM，匹配当前卡片的关闭 modal 收尾逻辑。
  - `.st-assistant-message` 改为 block 布局，并只对首屏卡片 wrapper 做居中，避免普通开场文本被 flex 挤压。
- 验证边界：
  - 按用户要求不启动服务、不启用浏览器。
- 命令行验证：
  - `cargo fmt` 通过。
  - `cargo test` 通过：`5 passed`。
  - `npm run lint` 通过。
  - `npm run build` 通过。
  - 已运行 `codegraph sync` 同步本次后端和前端修改。

### Step 12: 导入、世界书预览和状态栏原因分析（旧 fallback 已废弃）

- 用户需求：
  - 需要返回页面。
  - 需要导入 SillyTavern JSON/PNG。
  - 页面布局改为左侧世界书、右侧对应渲染。
  - 苍玄界 JSON 内有通过“灵”按钮触发的小界面，按钮应为悬浮可拖动，但当前缺失，需要分析原因。
- CodeGraph 定位：
  - 后端卡片加载：`backend/src/main.rs::init_handler` 和 `backend/src/card_loader.rs::CardData`。
  - 前端宿主入口：`frontend/src/main.js::renderShell`、`renderCardHtml`、`createRuntime`。
  - 世界书结构：`backend/src/card_loader.rs::BookEntry`、`CardData::all_book_entries`。
- “灵”按钮缺失原因：
  - 角色卡 regex 中的 `<StatusPlaceHolderImpl/>` 相关脚本只负责占位清理，`replaceString` 为空，不会生成按钮。
  - 真正状态栏脚本位于 `data.extensions.tavern_helper.scripts[3]`：
    - `name`: `状态栏`
    - `info`: `全局悬浮窗状态栏脚本，外部导入版。`
    - `content`: `import 'https://testingcf.jsdelivr.net/gh/suosuosaku/st@cangxuan-v1.0.19/dist/cangxuan/statusbar/index.js'`
  - 旧 Conclave ST Host 只执行 regex 渲染产物里的 `<script>`，没有读取或执行 `tavern_helper.scripts`，因此外部状态栏入口从未运行。
  - 当时误判为需要本地 fallback 来规避远程 CDN 依赖；该方向已在 Step 13 废弃，当前以执行卡片自带脚本为准。
- 后端改动：
  - `AppState.card` 改为 `Arc<RwLock<CardData>>`，支持运行时切换当前卡片。
  - 新增 `POST /api/import-card`，接收前端解析出的 `card_json`，校验后切换当前卡片并重置初始 `game_state`。
  - `/api/init` 和 `/api/import-card` 返回：
    - `worldbook_entries`
    - `tavern_helper_scripts`
    - 既有开场渲染、alternate greetings 和 runtime requirements。
  - `CardData` 新增 `from_value` 和 `tavern_helper_scripts`。
  - `st_api_scanner` 开始扫描 `tavern_helper.scripts`，并对远程 import 产生 warning。
  - Axum JSON body limit 提高到 `25MB`，避免大角色卡导入失败。
- 前端改动：
  - 顶部新增“返回开场”和“导入 JSON/PNG”控件。
  - 主布局改为左侧世界书列表、右侧渲染区。
  - 点击世界书条目后，右侧渲染对应条目内容；点击返回开场恢复当前角色卡开场渲染。
  - JSON 导入：直接解析文件内容后提交 `/api/import-card`。
  - PNG 导入：解析 PNG `tEXt` 和未压缩 `iTXt` 文本块，优先读取 `chara`、`ccv3`、`character`、`card` 关键字，支持 JSON 明文、URI 编码和 base64 JSON。
  - TavernHelper 的世界书读写 runtime 改为基于当前导入卡片的世界书条目初始化。
  - 初版曾在检测到 TavernHelper “状态栏”脚本时安装本地 `灵` 悬浮按钮 fallback：
    - fixed 悬浮按钮。
    - 支持拖动并保存位置。
    - 点击打开状态面板。
    - 面板读取本地 `Mvu`/消息变量中的 `stat_data`。
- 验证：
  - `cargo fmt` 通过。
  - `cargo test` 通过：`5 passed`。
  - `npm run lint` 通过。
  - `npm run build` 通过。
  - 按用户要求未启动服务、未使用浏览器。

### Step 13: 修正为卡片自带 ST/TavernHelper 行为

- 用户纠正：
  - `灵` 状态栏不是 Conclave 应该固定写死的 UI，卡片本身已经通过 TavernHelper 脚本提供。
  - 左侧栏不应展示当前世界书内部明细条目，而应展示已导入过的世界书/角色卡包。
- 判断修正：
  - Step 12 的本地 `灵` fallback 方向错误，会让 Conclave 和 SillyTavern 自带状态栏行为继续分叉。
  - 世界书内部 `character_book.entries` 仍可作为 runtime 的 `getLorebookEntries` 数据源，但不应作为主导航列表。
- 后端改动：
  - `AppState` 从单个当前 `CardData` 改为 `CardStore`，保存已导入卡片列表、当前导入项和递增导入 ID。
  - 新增 `POST /api/select-card`，用于从左侧导入列表切换当前卡片，并重置该卡片的初始状态。
  - `/api/init`、`/api/import-card`、`/api/select-card` 返回 `imported_worldbooks` 和 `current_worldbook_id`。
  - `tavern_helper_scripts` 返回脚本 `content` 原文，前端可以执行卡片自带脚本。
  - 远程 TavernHelper 脚本扫描 warning 改为提示“加载原模块或提供本地镜像”，不再建议固定 fallback。
- 前端改动：
  - 左侧标题改为“已导入世界书”，列表项来自后端导入列表，只显示导入包名、条目数量和当前状态。
  - 点击非当前导入项会调用 `/api/select-card`，后端切换当前卡片后重新渲染对应开场。
  - 删除 `installSpiritStatusFallback`、`renderSpiritStatusPanel` 及所有 `cx-spirit-*` 固定 UI/CSS。
  - 新增 `executeTavernHelperScripts()`，在 ST runtime 和开场 DOM 初始化后，按数组顺序动态导入执行 `data.extensions.tavern_helper.scripts[].content`。
  - TavernHelper 脚本失败只记录 warning 并继续执行后续脚本，避免一个远程模块失败阻断其它卡片脚本。
- 验证边界：
  - 按用户要求不启动服务、不使用浏览器。

### Step 14: 开场白切换后的状态栏变量同步

- 用户反馈：
  - 选择不同开场白后，正文已经切换，但状态栏里的修为、所在地、运势等数值没有更新。
  - 当前截图中状态栏仍显示默认/未知数据，例如 `未知秘境`、`推演中`。
- CodeGraph 定位：
  - 前端首楼运行时：`frontend/src/main.js::createRuntime`。
  - 开场 swipe 切换：`frontend/src/main.js::setChatMessages`。
  - 消息变量读取：`frontend/src/main.js::getMessageVariables`、`getVariables`、`Mvu.getMvuData`。
  - 后端 MVU patch 当前只处理 `<JSONPatch>`：`backend/src/pipeline/mvu_patch.rs::apply_mvu_patch`。
- 根因：
  - 开场白原文中每个 greeting 都带有 `<UpdateVariable><initvar>...` 初始变量块。
  - 后端 regex 渲染会隐藏/清理这些变量标签用于展示，但 Conclave 前端没有把 `<initvar>` 写入首楼 `swipes_data`。
  - 因此切换 `swipe_id` 只改变了 `message.swipes` / `rendered_swipes` 展示文本，`message.data` 和 `runtimeState.mvuData` 仍停留在默认空数据。
  - 卡片自带状态栏读取 `Mvu` / `getVariables` / `getChatMessages(... include_swipes)` 的变量数据，所以显示不会跟着开场白变。
- 前端修复：
  - 新增 `parseInitVarStatData()`，从每个开场白原文提取 `<initvar>...</initvar>`。
  - 新增缩进键值解析器 `parseIndentedKeyValueBlock()`，支持当前卡片的 YAML-like 变量结构：
    - 嵌套对象。
    - `- ` 列表项。
    - 数字、布尔值、`{}`、`[]` 和单双引号字符串。
  - 新增 `buildOpeningMvuData()`，把解析出的变量块合并到默认 MVU 结构的 `stat_data`。
  - `createRuntime()` 初始化首楼 `swipes_data` 时，按每个 opening swipe 写入对应变量数据，而不是所有 swipe 共用默认空数据。
  - `normalizeSwipeArrays()` 在补齐缺失 `swipes_data` 时，也会尝试从对应原文解析 `<initvar>`。
  - `setChatMessages()` 处理纯 `swipe_id` 切换后，同步：
    - `message.data`
    - `runtimeState.mvuData`
    - `Mvu.events.VARIABLE_UPDATE_ENDED` 事件广播
  - `Mvu.replaceMvuData()` 现在也会广播变量更新事件。
  - TavernHelper 脚本按顺序加载完成后，主动广播一次当前变量，避免状态栏初始化时错过已有数据。
- 验证边界：
  - 按用户要求不启动服务、不使用浏览器。
  - 浏览器中状态栏是否即时刷新仍需用户侧复测。

### Step 15: 多导入卡存档、切卡清理和通用 opening swipe

- 用户反馈：
  - 苍玄界卡当前已基本修复，但其他导入卡存在开场空白、只显示说明页或样式异常的问题。
  - 用户要求导入卡的 JSON 直接保存到项目文件夹，方便后续存放和调试读取。
- CodeGraph 定位：
  - 后端导入和切换链路：`backend/src/main.rs::import_card_handler`、`CardStore::import_card`、`build_init_response`。
  - 前端初始化和开场渲染链路：`frontend/src/main.js::applyInitData`、`showOpeningView`、`renderCardHtml`、`setChatMessages`。
- 判断：
  - 其他普通 ST 卡很多不自带苍玄界那种角色选择 UI，而是依赖 SillyTavern 首楼 swipe / 右滑切换 `alternate_greetings`。
  - Conclave 已维护首楼 `swipes`，但缺少可见的通用切换控件，所以这类卡会停留在空白 first_mes 或说明页。
  - 苍玄界的 TavernHelper 状态栏脚本会在宿主 `body/head` 追加浮动按钮、样式和脚本；切换到其他卡前如果不清理，会造成上一卡 UI 残留。
  - 一些卡片 CSS 会覆盖 `body`、`#root` 或宿主布局，导致截图中类似窄栏/透明棋盘背景的外溢效果。
- 后端改动：
  - 新增 `backend/data/imported_cards/` 作为导入卡 JSON 存档目录。
  - `POST /api/import-card` 现在先保留原始 `serde_json::Value`，校验为 `CardData` 后写入 pretty JSON 文件，再切换内存当前卡。
  - 存档文件名使用时间戳和清理后的卡名，避免覆盖同名导入。
  - 后端启动时扫描 `backend/data/imported_cards/*.json`，可解析的历史导入卡会恢复到左侧导入列表；解析失败的文件会跳过并打印 warning。
  - `imported_worldbooks[]` 增加 `source_file` 字段，便于调试时知道导入项对应的本地 JSON 路径。
- 前端改动：
  - `applyInitData()` 在切换卡片前执行 `cleanupCardArtifacts()`：
    - 停止上一轮 MutationObserver。
    - 移除上一张卡被记录的 `body/head` 外部运行时节点。
    - 移除 `data-conclave-card-head` 和 `data-conclave-card-script` 节点。
    - 恢复宿主 `html/body` 初始 class/style。
  - 卡片运行期间开启 MutationObserver，记录卡片脚本追加到 `document.head` 和 `document.body`、且不属于 `#root` 的节点，供下一次切卡清理。
  - 新增通用 `.st-opening-swipe-controls`：
    - 当首楼 swipes 数量大于 1 时显示左右箭头和当前位置。
    - 点击后调用 `setChatMessages([{ message_id: 0, swipe_id }], { refresh: 'none' })`，再立即刷新首楼展示。
    - 这补齐了普通 ST 卡依赖酒馆右滑开场的基础交互。
  - `refreshDisplayedMessage()` 刷新首楼后同步重绘 swipe 控件，保证卡片脚本自行切换 opening 时计数也跟着更新。
  - `frontend/src/index.css` 与 `frontend/src/App.css` 加强宿主基础布局保护，避免卡片 CSS 把 `body/#root/.st-host` 改成窄容器或透明背景。
  - `.gitignore` 增加 `backend/data/imported_cards/`，保存本地文件但避免误提交用户导入卡。
- 验证边界：
  - 按用户要求不启动服务、不使用浏览器。
  - 其他导入卡的具体 JSON 尚未在项目目录中，需用户重新导入后才可直接读取分析。
- 命令行验证：
  - `cargo fmt` 通过。
  - `cargo test` 通过：`5 passed`，仅保留既有 unused warning。
  - `npm run lint` 通过。
  - `npm run build` 通过。

### Step 16: 非苍玄界卡 prompt/display 正则差异修复

- 用户反馈：
  - 导入列表中第 2 张卡正常，第 3/4 张卡出现开场空白、只显示 ` ``` ` 或只显示“开场”的情况。
  - 用户询问是否只能导入一次。
- 结论：
  - 不是只能导入一次；当前 `backend/data/imported_cards/` 已保存 3 张导入卡。
  - `变身少女...`：`first_mes` 是说明页，`alternate_greetings` 有 17 条真实开场。
  - `路人女主...`：`first_mes` 只有 `[开局]`，没有 alternate greetings，真实首屏依赖局部正则“替换开局”生成 HTML UI。
  - `大荒z`：`first_mes` 是 `<customized>\s*(.*?)\s*</customized>` 形态，真实首屏依赖局部正则“大荒志·全能面板”生成 HTML UI。
- 根因：
  - 后端 `RegexPipeline::process()` 之前执行所有未禁用脚本，包括 `promptOnly: true` 的 Prompt 专用清理脚本。
  - `大荒z` 中“去开场白代码、防止未来楼层重复出现”脚本是 `promptOnly: true`，它会先把 `<customized>...</customized>` 替换成“开场”，导致后面的显示 UI 正则再也匹配不到。
  - 代码围栏剥离只支持严格的 ` ```html\n...\n``` `，但导入卡实际存在：
    - ` ``` <!doctype html>...``` `
    - ` ```html <!DOCTYPE html>...``` `
  - 因此 `路人女主...` 的 HTML UI 被当成代码围栏文本显示，只剩 ` ``` `。
- 后端修复：
  - `RegexPipeline::process()` 显示渲染时跳过 `promptOnly`-only 脚本；后续 Step 17 已修正为完整的 ST 两阶段显示规则。
  - 保留 `markdownOnly` 显示脚本执行，符合当前 ST Host 的渲染用途。
  - `strip_markdown_fences()` 改为支持 inline `html` 标记和无语言标记代码围栏。
  - 仅当围栏内容看起来是 HTML（`<!doctype`、`<html`、`<style`、`<div` 等）时才剥离，避免误吞普通代码块。
- 回归测试：
  - 新增 `display_pipeline_skips_prompt_only_scripts`，覆盖同一匹配下 promptOnly 清理脚本和显示 UI 脚本的顺序问题。
  - 新增 `markdown_fence_stripping_accepts_inline_or_unlabeled_html`，覆盖 inline ` ```html <!doctype...` 和无语言 ` ``` <!doctype...`。
- 验证：
  - `cargo fmt` 通过。
  - `cargo test` 通过：`7 passed`，仅保留既有 unused warning。
  - 按用户要求不启动服务、不使用浏览器。

### Step 17: 卡片自带状态栏 UI 触发和显示正则阶段修正

- 用户反馈：
  - `变身少女...` 开场正文已显示，但状态栏 UI 没有渲染出来。
  - 同一截图里 `<UpdateVariable>` 内容被显示成普通文本，说明显示阶段正则筛选仍不符合 ST。
- ST 源码核对：
  - `public/scripts/extensions/regex/engine.js::getRegexedString()` 的筛选语义：
    - `script.markdownOnly && isMarkdown` 时运行。
    - `script.promptOnly && isPrompt` 时运行。
    - 两个 only 都没勾时，仅在非 Markdown、非 Prompt 的普通阶段运行。
  - 因此 `promptOnly + markdownOnly` 的脚本在显示 Markdown 阶段也必须运行。
- 导入卡检查：
  - `变身少女...` 的开场 alternate greetings 没有 `<StatusPlaceHolderImpl/>`。
  - 卡片定义了启用的 `状态栏美化` 局部正则：
    - `findRegex`: `<StatusPlaceHolderImpl/>`
    - `markdownOnly`: `true`
    - `replaceString`: 卡片自带完整状态栏 HTML/CSS/JS。
  - 由于当前开场文本没有占位，状态栏 UI 正则没有触发。
- 后端修复：
  - `RegexPipeline::process()` 改为两阶段显示渲染：
    - `DisplaySource`: 运行既不是 `markdownOnly` 也不是 `promptOnly` 的普通显示脚本。
    - `MarkdownDisplay`: 运行所有 `markdownOnly` 脚本，包括 `promptOnly + markdownOnly`。
  - 新增 `render_card_message()`，统一 `/api/init`、`/api/greetings`、`/api/chat` 的显示渲染入口。
  - 新增 `append_card_status_placeholder_if_needed()`：
    - 如果消息已经包含 `<StatusPlaceHolderImpl/>`，不处理。
    - 如果卡片已有 TavernHelper 脚本，不补入，避免和苍玄界这类外部状态栏重复。
    - 如果卡片定义了启用的 `<StatusPlaceHolderImpl/>` + `markdownOnly` 显示正则，则只在渲染副本里追加占位，交给卡片自己的状态栏 HTML 渲染。
  - 原始 `first_message` / `greetings` 不被改写，避免污染 raw swipe 数据。
- 回归测试：
  - 新增 `markdown_display_runs_scripts_that_are_also_prompt_only`，覆盖 `promptOnly + markdownOnly` 的变量隐藏脚本在显示阶段仍运行。
- 验证：
  - `cargo fmt` 通过。
  - `cargo test` 通过：`8 passed`，仅保留既有 unused warning。
  - 按用户要求不启动服务、不使用浏览器。

### Step 18: 内含三反引号的整页 HTML 围栏修复

- 用户反馈：
  - `路人女主的养成方法测试版v0.09` 仍只显示一个代码围栏标记 ` ``` `，整页 UI 没有渲染出来。
- 导入卡检查：
  - 该卡唯一局部正则“替换开局”把 `[开局]` 替换成一段约 `428KB` 的整页 HTML。
  - 替换内容外层是：
    - 起始：` ```\n<!doctype html>...`
    - 结束：`...\n````
  - 但 HTML 内部脚本里还包含 JS 正则字面量：`/```[\s\S]*?```/g`。
  - 因此外层和内部总共有 4 个三反引号位置。
- 根因：
  - 之前 `strip_markdown_fences()` 用非贪婪正则匹配第一个闭合围栏。
  - 它会把内部 JS 正则里的三反引号误判成外层结束，只剥掉前半截，剩余残片进入前端 `DOMParser` 后只留下 ` ``` ` 文本。
- 后端修复：
  - `strip_markdown_fences()` 先调用 `strip_outer_html_fence()`。
  - 如果整段文本以代码围栏开头、内容看起来是 HTML，并且末尾有外层闭合围栏，则优先剥最外层。
  - 这样内部 JS 里的 `/```...```/g` 会被完整保留，不参与 Markdown fence 切分。
  - 对非整页 HTML 的普通 fenced HTML 片段，仍保留原有局部替换逻辑。
- 回归测试：
  - 新增 `markdown_fence_stripping_prefers_outer_html_fence`，覆盖外层 HTML fence + 内部 `/```[\s\S]*?```/g`。
- 验证：
  - `cargo fmt` 通过。
  - `cargo test` 通过：`9 passed`，仅保留既有 unused warning。
  - 按用户要求不启动服务、不使用浏览器。

### Step 19: `_.set(...)` 变量更新进入状态栏数据

- 用户反馈：
  - `变身少女...` 的状态栏 UI 已经渲染出来，但内容为空，只有栏目和默认等级。
- CodeGraph 定位：
  - 首楼变量构造：`frontend/src/main.js::buildOpeningMvuData`。
  - 已有 `<initvar>` 解析：`frontend/src/main.js::parseInitVarStatData`。
  - 状态读取 API：`frontend/src/main.js::getChatMessages`、`getVariables`、`Mvu.getMvuData`。
- 卡片脚本检查：
  - 状态栏脚本通过 `getChatMessages(getCurrentMessageId())` 读取当前消息。
  - 读取路径为 `message.data.stat_data || message.data.display_data`。
  - 具体字段用 `SafeGetValue(d, '<user>.称号')`、`SafeGetValue(d, '<user>.精神状态数值.反抗意志')` 等。
  - 该卡开场的变量更新不是 `<initvar>`，而是 `<UpdateVariable>` 内的 `_.set('<user>.路径', old, new)`。
- 前端修复：
  - `buildOpeningMvuData()` 现在合并两类开场变量：
    - `<initvar>...</initvar>` 缩进块。
    - `<UpdateVariable>...</UpdateVariable>` 中的 `_.set(...)` 调用。
  - 新增 `parseUpdateVariableStatData()`：
    - 扫描所有 `<UpdateVariable>` 块。
    - 提取 `_.set(path, old, new)` 调用。
    - JS 字符串参数按字面量解析，避免直接执行卡片脚本。
    - 三参数更新写成 `[current, previous]`，匹配状态栏 `SafeGetValue(...)[0]` 读取当前值的模式。
  - 新增轻量参数解析器：
    - `extractFunctionCallArguments()`
    - `splitJsArguments()`
    - `parseJsArgument()`
    - `parseJsStringLiteral()`
  - `TavernHelper` 和 `window` 暴露 `getCurrentMessageId()`，当前返回 runtime 最新消息 id；开场阶段为 `0`。
- 验证：
  - `npm run lint` 通过。
  - `npm run build` 通过。
  - 按用户要求不启动服务、不使用浏览器。

### Step 20: 动态状态栏初始化与空状态栏误触发修复

- 用户反馈：
  - `变身少女...` 的状态栏 UI 壳体已经出现，但栏目内容仍为空。
  - `first_mes` 说明页也被渲染出一块空状态栏，观感不符合卡片预期。
  - 用户指出“苍玄界能跑但这张卡不行”，需要解释获取方式差异。
- 根因：
  - 苍玄界主要走 TavernHelper/MVU 脚本和事件广播路径。
  - `变身少女...` 这张卡走局部正则状态栏路径：
    - 后端用 `<StatusPlaceHolderImpl/>` 触发卡片自带状态栏 HTML。
    - 状态栏脚本用 `getChatMessages(getCurrentMessageId())[0].data.stat_data` 读取当前消息变量。
  - 之前 Step 17 的占位符兜底过宽，只要卡片有状态栏正则就给所有开场文本补占位，导致没有变量的说明页也出现空状态栏。
  - 该状态栏 HTML 的初始化脚本写法是 `document.addEventListener('DOMContentLoaded', initDisplay)`。
  - Conclave ST Host 是在页面加载完成后动态插入卡片 HTML，浏览器原生 `DOMContentLoaded` 已经触发过，晚注册的监听器不会再执行，所以状态栏 UI 壳出现但 `initDisplay()` 没跑，变量内容保持空。
- 后端修复：
  - `append_card_status_placeholder_if_needed()` 增加 `message_has_status_variable_payload()` 条件。
  - 只有消息包含 `<initvar>` 或 `<UpdateVariable>` 时，才会给缺失占位符的状态栏正则补 `<StatusPlaceHolderImpl/>`。
  - 普通说明页、菜单页不再被强行挂空状态栏。
- 前端修复：
  - 新增 `installDomReadyCompatibility()`。
  - 对 `document` 和 `window` 的 `addEventListener('DOMContentLoaded', ...)` 做兼容包装。
  - 当卡片脚本在 `document.readyState !== 'loading'` 后才注册 DOMContentLoaded 监听器时，Conclave 会异步调用该监听器，模拟卡片在新文档中加载的初始化语义。
  - 这使状态栏自带的 `initDisplay()` 能在动态插入后执行，从当前消息 `stat_data` 读取并填充内容。
- 回归测试：
  - 新增 `status_placeholder_injection_requires_variable_payload`。
  - 新增 `statusbar_regex_runs_only_for_messages_with_variable_payload`，覆盖同一张卡：
    - 说明页不触发状态栏 HTML。
    - 带 `<UpdateVariable>` 的消息触发状态栏 HTML。
- 验证：
  - `npm run lint` 通过。
  - `npm run build` 通过。
  - `cargo fmt` 通过。
  - `cargo test` 通过：`11 passed`，仅保留既有 unused warning。
  - 按用户要求不启动服务、不使用浏览器。

### Step 21: 整页卡 UI 打包残留全局依赖修复

- 用户反馈：
  - `路人女主的养成方法测试版v0.09` 选中后主区域空白，没有渲染出卡片自带 UI。
- 内置浏览器复现：
  - 页面已从 `/api/init` 收到完整 `rendered_html`，说明后端正则替换和 HTML fence 剥离已经生效。
  - DOM 中宿主 shell 正常，消息区为空。
  - 控制台报错：`ReferenceError: Vue is not defined`。
- 根因：
  - 这张卡不是苍玄界那种 TavernHelper/MVU 状态栏脚本，而是一个完整的打包前端应用。
  - 打包产物里残留了一个裸 `Vue;` external marker。
  - Conclave ST Host 当前没有 classic global `Vue` 标识，模块脚本执行到该 marker 时直接中断，后续 `#app` 渲染函数没有运行。
- 前端修复：
  - 新增 `installClassicGlobalIdentifier()`，通过 classic script 注册真正的全局标识。
  - 新增 `installBundledCardGlobalCompatibility()`，当前为 `Vue` 提供空对象兜底。
  - 该兜底只解决裸标识引用中断问题；如果后续卡片真正调用 Vue API，仍会暴露更具体的缺 API 错误，避免把完整框架伪装成已实现。
- 第二轮复测：
  - `Vue` 错误消失后，卡片继续报 `TypeError: e.minor is not iterable`。
  - 该错误来自卡片自己的存档迁移逻辑：它读取固定名 `islandmilfcode` IndexedDB 和 `islandmilfcode:*` localStorage 键，再把旧/脏的 `summaryStore` 当作 `{ minor: [], major: [] }` 使用。
  - 在 Conclave 中多张导入卡共享同一个 `localhost` origin，整页卡自带存储容易互相污染或吃到此前调试残留。
- 第二轮前端修复：
  - 新增 `createScopedLocalStorage()` 和 `createScopedIndexedDB()`。
  - 对 inline module 卡脚本，如果内容引用 `localStorage` 或 `indexedDB`，执行前注入按当前卡隔离的局部绑定。
  - 同步隔离 `BroadcastChannel` 名称，避免多个整页卡或多个标签互相触发存档刷新消息。
  - 这样卡片仍能使用浏览器存储，但数据库名、键空间和广播通道会按导入卡隔离，避免不同卡、不同调试阶段的同源数据互相破坏初始化。
- 待验证：
  - `npm run lint` 通过。
  - `npm run build` 通过。
  - 内置浏览器复测 `路人女主...` 通过：
    - `#app` 已由卡片脚本填充。
    - 出现卡片自带标题页按钮：`新建角色 →`、`读取存档`。
    - 刷新后新增 warn/error 日志为空。

## 2026-08-01 — ST scoped regex_scripts multi-card parity

### ST 源码事实（CodeGraph）

- 卡内正则存于 `data.extensions.regex_scripts`（SCOPED）。
- 引擎：`public/scripts/extensions/regex/engine.js`
  - `getScriptsByType(SCOPED)` → 当前角色 `characters[chid].data.extensions.regex_scripts`
  - `getRegexedString` / `runRegexScript`：placement、markdownOnly/promptOnly、depth、`trimStrings`、`substituteRegex`、`{{match}}`→`$0`、`$n` / `$<name>`
- 全局 / 预设脚本另存，不跟单张导出卡走；真卡差异主要来自 **scoped** 列表。

### 四套真卡 inventory（tracked）

| id | total | display AI_OUTPUT | 备注 |
|----|------:|------------------:|------|
| cangxuan | 21 | 9 | 开场白 HTML、对话气泡、状态栏… |
| dahuang-z | 17 | 11 | 思维链/变量美化、全能面板… |
| bianshen-shaonu | 5 | 3 | 状态栏 + 正文美化 |
| luren-nvzhu | 1 | 1 | 仅「替换开局」 |

全部 `substituteRegex=0` 且 `trimStrings` 为空；引擎仍补齐 ST 边角以免未来卡踩坑。

### Conclave 实现

- FE `RegexEngine`：`trimStrings`、`$0`、`$<name>`、placement 数值强制、`substituteRegex` RAW/ESCAPED（需 macros/characterOverride）
- Oracle 改为 re-export FE `processDisplay`（消灭双实现漂移）
- BE `RegexScript.trim_strings` + expand `$0` / `$<name>` + trim
- `scripts/real-card-regex-inventory.mjs` + golden `fixtures/golden/real-regex-inventory/inventory.json`
- matrix 断言：各卡 display signature 互不相同（防单卡特化）
