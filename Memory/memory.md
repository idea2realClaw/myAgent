# MyAgent 项目长期记忆

## 身份文件人称约定（用户 2026-07-19 确立）
- `Memory/ID.md` / `DNA.md` / `Soul.md` 等身份文件：设定 AI → 用「你是 xxx」；设定用户/角色人设 → 用「我是 xxx」。
- 理由：①身份文件由 `backend/identity-manager.js` 注入 system prompt，外层包裹用第二人称（"define who you are. Embody them fully"），内层用「你」才一致；②`DNA.md` 自身已全第二人称，ID.md 应跟它对齐；③「我是」在多轮拼接中可能被误判为用户发言（XML 包裹能缓解但不绝对）。
- MyAgent 现状：ID.md Name 段为「你是 MyAgent」（自主推理智能体）；DNA.md 本就全「你」；Soul.md「我是你师父，你是龙十三」中「我」=师父人设、「你」=AI，符合规则，未动。
- 记忆法：**设定 AI → 你是；设定用户/角色 → 我是**。

## MyAgent 重启方式（单进程自监控，无 daemon/无额外端口）

- **架构**：自 2026-08-01 起**无 daemon**。`node backend/server.js` 单进程既服务又自管理：
  重启与崩溃自愈都靠进程 re-exec 自身（spawn 新 node 跑同一份磁盘代码），只占用 **3737**
  一个端口，不再有 13737 控制端口，`backend/daemon.js` 已删除。
- **触发重启**（任选，端口都在 3737）：
  1. 控制 API：`curl -X POST http://127.0.0.1:3737/api/restart`（localhost + 同源防 CSRF）。
  2. 前端「重启」按钮（走 3737/api/restart）。
  3. WS 消息 `{type:'restart'}`。
  4. 信号 `kill -USR1 <pid>`（server.js 收到后 selfRestart）。
- **自重启流程**：旧进程 `server.close()` 释放 3737 → 新进程绑定 3737（自带 EADDRINUSE 重试）
  → 旧进程轮询新进程 `/api/health`，健康后旧进程退出。端口全程不变（3737）。
- **崩溃自愈**：`uncaughtException`/`unhandledRejection` 触发 selfRestart 重新拉起；
  启动 <5s 内崩溃则直接退出（防重启死循环）。偶发崩溃不会让 Agent 永久掉线。
- **改完 backend/server.js 后生效**：selfRestart 每次重新 spawn 读磁盘新代码，
  调一次 `/api/restart` 或 `start.sh restart` 即加载新代码（无需另起进程）。
- **⚠️ start.bat 前台场景**：自重启后旧 node 退出，cmd 会显示旧进程退出并 pause；
  新实例仍在原窗口后台服务，直到用户按键关闭窗口。服务器场景用 `start.sh`（setsid 脱离）无此现象。

## ChatStream 可见性事件协议（前端状态条 vs 聊天流卡片）
- **根因**：`thinking` 事件只走前端 `showStatus`（顶部状态条），`tool_result` 事件里的 `removeStatus()` 会清除它 → 用户经常"看不见"执行中消息（尤其 Web_Search 后、汇总前）。
- **正确做法**：凡要让用户在聊天流里"看见并打勾"的阶段，后端 `broadcast` 一个 `plan_append` 事件（带 `task:{id,title,type}`），前端 `appendPlanSubtask` 把它追加到当前任务分解卡片（`.subtasks-grid`）里，再用既有 `subtask_start`/`subtask_done`/`subtask_error` 更新打勾状态。
- **约定**：任务分解（plan）、自检（self-check）、汇总（synthesize）三阶段都在 ChatStream 可见、可打勾；自检/汇总阶段用 `plan_append`+`subtask_*` 取代原先只有 `thinking` 状态条的做法（见 `backend/server.js` `runPlannedLoop` + `frontend/dist/index.html` `appendPlanSubtask`）。
- **`appendPlanSubtask` 要点**：幂等（同 id 不重复）、无卡片兜底新建"执行进度"卡片、`escapeHtml` 防 XSS、更新 badge 计数、`scrollToBottom()`。
- **验证技巧（无 jsdom 时）**：从 `index.html` 抽取真实渲染函数源码 + 自写极简 DOM stub，用 `vm.Script`/`vm.runInContext` 真实执行跑断言（见历史任务：15 项断言全 PASS）。

## Windows 控制台命令输出乱码修复（重要，避坑）
- **现象**：`tracert`/`ping`/`netstat`/`ipconfig` 等 Windows 命令经 MyAgent 执行后，中文变成 `ͨ�����` 之类乱码。
- **根因**：这些控制台程序经**管道**捕获时，写出的是系统 **OEM 代码页**（中文 Windows = CP936/GBK）字节；而 `child_process.exec` 默认按 **UTF-8** 解码，字节错位 → 乱码。
- **⚠️ `chcp 65001` 无效**：它只改「控制台屏幕」代码页；管道里的字节仍是 GBK，`chcp` 救不了。
- **正确做法**：用 `backend/shell-decode.js` 的 `decodeShell(buf)` —— 先判原始字节是否合法 UTF-8（git/node/python/现代工具/ASCII 走 UTF-8），否则按系统 OEM 代码页（GBK）解码；代码页由 `chcp` 检测并缓存（`936→gbk`、`950→big5`、`932→shift_jis`、`949→euc-kr`）。
- **应用点（4 处，改命令执行必须同步）**：`tool-registry.js` 的 `shell_execute` 与 `python_execute`、`tool-executor.js` 的 `execStream`（累积原始 Buffer、关闭时整体解码，避免多字节跨块截断）、`skill-executor.js` 的技能命令。统一 `encoding: 'buffer'` + `decodeShell()`。
- **实测**：真实 `ping`(GBK) 输出正确还原「正在 Ping…」；`git`(UTF-8) 输出不乱码；node --check 全过；重启后新 server 接管 3737、/api/health=200。

## 重启竞态(EADDRINUSE)与空答案、start.bat 前台日志（2026-08-01 根治）
- **现象**：MyAgent「一直在总结、不能完成」+「重启后对话里 AI 输出都看不见」。
- **根因 1（致命）**：早期 daemon 重启逻辑先 spawn 新 server 再停旧 server，新 server 抢绑 3737 触发 `EADDRINUSE` 反复崩溃；多个 server 实例互踩，最终 3737 无人监听（实测 `netstat` 3737/13737 都无 LISTENING），server 处于假死 → 请求要么打到将崩实例、要么无服务响应。**2026-08-01 已彻底移除 daemon**：改为单进程 `server.js` 自重启（re-exec 自身，旧进程先 `server.close()` 释放 3737 再让新进程绑定，自带 EADDRINUSE 重试），不再有 13737 控制端口。
- **根因 2（空答案）**：`runPlannedLoop` 里 `planSynthesize` 偶尔返回空（模型空 completion/截断），导致 `done` 事件带空 `content` → 前端渲染空白气泡、界面卡在「正在汇总」。修复：汇总返回空时**重试一次**（缩短上下文）；仍空则兜底 assembled `context`（subtask 证据+小结），保证 `finalText` 永非空、`done` 必带内容。
- **根因 3（旧前端）**：重启后浏览器可能命中缓存的旧 `index.html`，使 `done` 渲染异常。修复：`express.static` 与 SPA fallback 加 `Cache-Control: no-cache`。
- **start.bat**：`do_start` 改为**前台运行** `node backend\server.js`（去掉 `Start-Process -WindowStyle Hidden -RedirectStandardOutput`），后端 log 实时打印到 cmd 窗口；`free_port` 在启动前先杀掉占用 3737 的旧进程；末尾保留 `pause`。
- **调试手段**：`Get-Process -Name node` + `netstat -ano | findstr ":3737 "` 看是否有多实例/端口监听；`logs/agent-webui-server.log` 查 `EADDRINUSE` 与 `[PlannedLoop] 汇总完成: 答案长度=`。
- **验证**：杀光残留 node 后干净启动 → health=200、3737 单一新 server 监听、新 server 启动无 EADDRINUSE；端到端 WS 测试 `done` 带回非空内容（28 字正确回答），8.3s 完成。

## 设计原则：MyAgent 与 WorkBuddy 是不同的人设，不合并（用户 2026-08-03 明确）
- **MyAgent（本产品）与 WorkBuddy（开发/运维它的助手 Agent）是刻意分离的两种人设**，身份与记忆文件**不可合并、不可互相镜像/软链**。
- MyAgent 的身份与长期记忆：`Memory/ID.md`、`DNA.md`、`Soul.md`、`memory.md`，由 `backend/identity-manager.js` 每轮注入 MyAgent 自己的 LLM 上下文。
- WorkBuddy 的工作记忆：`.workbuddy/memory/`（由 harness 注入助手本体，作为开发本项目时的项目知识），是另一个"人"的记忆。
- 两者内容可能都涉及 myAgent 项目事实，但服务于不同"人"；**不要把 MyAgent 的 ID/DNA/Soul 注入 WorkBuddy，也不要把两边 memory 互相覆盖/软链**。
