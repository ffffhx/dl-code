# Context 模块

负责每次模型请求的预算、增量任务摘要和长工具输出回查。配置和完整流程见 [Token 管理](../../docs/TOKEN_MANAGEMENT.md)。

## 文件

- ContextManager.ts：输出/安全预留、工具 schema 预算、按 Token 保留近期消息、分块结构化摘要。
- TokenCounter.ts：本地 Token 估算，包含工具调用参数。
- history.ts：ContextCheckpoint 与原始非 system 历史前缀校验。
- ContextArtifacts.ts：按会话隔离的原文文件与 read_context_artifact 工具。
- index.ts：公共导出。

## 约束

1. 原始会话历史和模型输入视图分开；摘要不覆盖原文。
2. 新压缩只处理已有摘要和新增旧消息，checkpoint 随会话持久化。
3. 系统提示与激活的 Skill 每次请求重建；最新用户请求不静默裁剪。
4. 按 Token 预算选择近期消息，工具调用及其全部结果不可拆开。
5. 接受的摘要必须确实缩小上下文；超出硬预算时明确失败。
6. 长文本工具结果先成功落盘再返回引用；多模态内容不转成文本。
7. 摘要请求本身也受输入预算约束。取消时不提交摘要。
8. 模型返回无效摘要时明确标记未验证摘录，保留原始历史引用供回查。

会话中间件位于 src/skills/middleware.ts。离线测试位于 tests/context.test.ts，运行 npm test。
