# Agents 模块

`CodingAgent` 组装模型、工具和请求前中间件，使用 LangChain `createAgent` / LangGraph 执行模型与工具循环（Agent Loop）。会话输入、运行状态、取消与持久化由 `src/runtime/AgentSession.ts` 负责。

## 文件与职责

- `coding-agent.ts`：初始化模型；注册内置/MCP 工具；每轮发现 Skills；构造规则与上下文中间件；消费 `messages` 和 `updates`。
- `subagents/SubagentManager.ts`：只读子任务的启动、取消、并发与邮箱。当前也维护根 Agent 记录，以支持父子通信和统一恢复。
- `subagents/AgentJournal.ts`：每个根会话的日志、元数据与 owner 约束。
- `subagents/runtime.ts`：创建使用独立 CodingAgent 的子任务执行器。
- `subagents/tools.ts`：主 Agent 可调用的委派工具。

## 执行流程

`AgentSession.run` → `CodingAgent.execute` → 组装工具和中间件 → `createAgent` → 每次请求前整理规则/Skills/邮箱/上下文 → 模型与工具循环。

`model_request` 的文本增量通过 `onTextDelta` 提供给 AgentSession，完整模型消息及工具结果通过 `updates` 更新会话。摘要模型的内部输出不作为主回答展示。

## 约束

- 只读子 Agent 不注册 shell、编辑器、Todo、MCP 或委派工具。
- `cleanup()` 仅释放当前 CodingAgent 的上下文与 shell 资源。应用退出时统一关闭 MCP。
- 上下文检查发生在每次模型请求前，包括工具调用后的请求。
- `recursionLimit: 100` 限制图步数，不代表任务验收。
- 独立工具集合不等于文件系统或 OS 沙箱。

验证：`npm test`。整体架构见 [Agent Runtime](../../docs/AGENT_RUNTIME.md)。

## 新增能力

`CodingAgent` 每次执行创建 ToolCatalog 和统一执行策略，每次模型请求召回作用域内的 Memory。MemoryRuntime 主 Agent 可读写、子 Agent 只读。工具定义先按激活状态过滤再计算上下文预算。子任务支持验收标准、显式 review 和已验收依赖；详情见 docs/ARCHITECTURE.md。
