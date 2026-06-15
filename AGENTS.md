# AGENTS.md instructions for /Users/makima/program/Conclave

处理任何代码相关问题、定位实现、分析调用链或进行代码修改前，必须先使用 CodeGraph。

- 先调用 `codegraph status` 确认索引健康。
- 再使用 `codegraph query` 查询相关符号、引用关系和上下文。
- 定位代码时优先使用 CodeGraph，只有在 CodeGraph 结果不足以支撑判断时，才允许补充使用 `rg`、`find`、`grep` 或手动通读文件。

## SillyTavern API reference

SillyTavern 源码位于 `/Users/makima/program/SillyTavern-release`。当需要实现、模拟、排查或解释 SillyTavern API、插件接口、slash command、事件、全局对象、MVU、变量系统或前端运行时行为时，也必须优先使用该源码的 CodeGraph。

- 在 `/Users/makima/program/SillyTavern-release` 中先运行 `codegraph status`；若未初始化，先运行 `codegraph init`。
- 使用 `codegraph query` 查询相关 API、事件名、函数、模块和调用关系。
- 只有 CodeGraph 结果不足以支撑判断时，才补充使用文本搜索或人工阅读 SillyTavern 源码。
- Conclave 的 iframe/ST 兼容层应以 SillyTavern 源码中的真实 API 语义为准，不只依赖角色卡 JSON 中扫描出的 API 名称。
