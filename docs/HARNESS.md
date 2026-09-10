# Harness Runtime（第一阶段）

HarnessRuntime 是单个会话的运行入口，负责执行生命周期、上下文持久化、取消和恢复。LangChain / CodingAgent 继续负责模型与工具循环；已有压缩、Skills 和子 Agent 能力接入运行时。React / Ink 只提交输入并订阅事件，Zustand 保存界面投影。

```text
CLI / Ink / 无界面调用方
          ↓ run / resume / cancel / subscribe
    HarnessRuntime
      ├─ CodingAgent → LangChain → 模型与工具
      ├─ AgentManager → 子 Agent、邮箱、恢复日志
      └─ SessionManager → 兼容会话快照
```

## 无界面调用

```typescript
import { createDefaultHarness } from '../src/harness/default.js';

const harness = await createDefaultHarness();
try {
  for await (const event of harness.run({ text: '检查项目并说明下一步' })) {
    if (event.type === 'run_finished') console.log(event.run);
  }
} finally {
  await harness.shutdown();
}
```

默认工厂复用当前会话和模型配置；CLI 在创建它之前初始化 MCP。其他入口若需要 MCP，也应先初始化连接。测试可直接构造 HarnessRuntime，注入 AgentEngine、AgentManager 和保存函数，不需要真实模型凭据。

## 生命周期与事件

- `run({ text })` 返回异步迭代器，开始消费时启动执行；同一会话只允许一个活动运行。输入由运行时追加一次。
- `subscribe(listener)` 订阅事件，返回取消订阅函数。`snapshot()` 返回脱离运行时内部对象的上下文副本。
- 事件包含 `sessionId`、可选 `runId`、递增 `sequence` 和时间戳。序号仅限当前运行时实例，不是持久化重放游标。
- `session_updated` 提供完整上下文快照；`message`、`tool_requested`、`tool_result` 提供执行展示信息；`context_compacted` 报告压缩次数；`agent_updated` 报告子 Agent 状态。
- `tool_requested` 表示模型提出调用，不保证工具已经开始执行。当前事件来自 LangChain updates，不是逐 token 输出。
- `run_finished` 的状态为 `completed`、`failed` 或 `cancelled`。`completed` 只表示本轮执行正常结束，不代表需求已经通过验收。
- `cancel(runId)` 中止主运行及活动子 Agent，并等待退出；取消依赖模型、工具响应 AbortSignal。退出迭代器也会取消未结束的运行。事件消费者暂时不读取不会阻塞取消。
- `shutdown()` 幂等地释放运行、Agent、shell 和 MCP 连接。

## 持久化与恢复

AgentManager 的 journal 是恢复上下文的权威来源。每次上下文变化（包括压缩和实际 Todo 写入）都会更新日志，再写 SessionManager 的兼容 JSON 快照。JSON 使用同目录临时文件替换，保存失败不会静默报告成功。两种存储不是跨文件事务；底层存储全面不可用时无法保证最终状态落盘。

启动时发现 `lastRun.status === 'running'`，会标记为 `interrupted`。通过 `resume(lastRun.id)` 从最新上下文开始新运行，记录 `resumedFrom`，不再追加原始用户输入。恢复不是从工具调用指令位置继续执行：未匹配结果的历史工具调用会补充“结果未知”的错误消息，要求模型检查当前状态，不自动重放。普通新输入也会修复此类未完成调用。

`clear()` 清空主会话消息、Todo、Skills 激活状态、压缩检查点和主 Agent 邮箱，并更新恢复日志；子 Agent 历史记录保留。活动运行期间不允许清空。

## 终端操作

- `Escape`：取消当前运行。
- `/resume`：继续最近一次失败、取消或中断的运行。
- `/clear`：清空主会话。
- `Ctrl+C`、`/exit`：清理资源后退出。

## 后续边界

本阶段完成运行时与 UI 分离。统一 ToolExecutor、工具级幂等与重试策略、执行预算、独立验收状态和持久化事件重放尚未实现，应分别在后续阶段接入，避免把本轮模型结束当作任务完成。

验证：`npm test`（包含 `tests/harness.test.ts` 的无界面、取消、恢复、持久化与真实 CodingAgent 的离线集成用例），`npm run build`。
