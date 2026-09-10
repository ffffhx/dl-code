# Token 管理与上下文压缩

每次模型调用（包括工具调用后的下一步）都经过上下文中间件。系统提示和已激活 Skill 重新生成；完整历史用于持久化和回查，模型输入使用可复用的任务摘要与近期消息。

## 配置

上下文窗口和模型最大输出分开配置：

~~~yaml
models:
  chat_model:
    # model、api_key、api_base 等配置略
    max_tokens: 8192 # 模型最大输出

context:
  max_tokens: 100000 # 总窗口，按实际模型/提供方限制设置
  # reserve_output_tokens: 8192 # 默认取上面的模型最大输出
  safety_margin_tokens: 2048
  compression_threshold: 0.8
  target_ratio: 0.56
  recent_tokens: 12000
  summary_tokens: 2000
  tool_output_tokens: 4000
~~~

- 可用输入预算 = 总窗口 - 输出预留 - 安全余量。
- 系统指令、Skill、历史消息、工具参数和工具 schema 都计入输入估算。
- 上例的可用输入预算是 89,760 tokens，超过其 80%（71,808）触发摘要。目标为可用预算的 56%，在必须保留的信息较多时可以高于该目标。
- recent_tokens 是近期历史的软预算；最新用户请求和最后一个完整工具交换优先保留。
- summary_tokens 限制保存的摘要正文。摘要请求也会分块控制输入大小，避免导入超长历史时摘要调用本身超窗。
- 省略 context 时，总窗口默认 100,000；输出预留默认取模型最大输出（未设置时 8,192），安全余量最多 2,048。近期预算默认可用输入的 30%，摘要最多 2,000，工具输出最多 4,000。
- 旧的 models.chat_model.compression_threshold 仍作为阈值回退值；models.chat_model.max_tokens 现在只表示输出上限，不再被误用作上下文窗口。

计数使用 js-tiktoken。不支持的模型退回 GPT-4 编码器；多模态和提供方格式开销无法做到精确计费级估算，请配置合适的窗口和余量。tokenUsage 表示**下一次请求的本地输入估算**，历史 AI 回复也属于输入，outputTokens 为 0；它不是累计账单，也不包含摘要调用的费用。

## 稳定的摘要与压缩边界

SessionContext.contextCheckpoint 保存：

- version：格式版本，目前为 1。
- summary：任务交接摘要。
- coveredMessages：已覆盖的原始非 system 消息数量。
- prefixHash：原始前缀的 SHA-256，用来识别编辑、分支、历史截断等变化。
- historyArtifact：已覆盖原文的回查文件 ID（主 Agent 运行时提供）。

会话 JSON 和 Zustand 都保存这份记录。后续请求先验证前缀，再使用：

~~~text
系统指令 + 已激活 Skill
任务交接摘要 + 原始历史引用
最新用户请求（如果它的位置已被摘要覆盖）
尚未覆盖的近期完整消息
仍需保留的异步 Agent 消息
~~~

再次达到阈值时，只把“已有摘要 + 新增的旧消息”交给摘要模型。原始 messages 保留，不把模型输入视图写回覆盖原文。框架自动生成的消息 ID 不参与前缀校验；正文或工具调用变化会使旧摘要失效。清空聊天会清除摘要、计数和 Skill；旧版无摘要的会话可以直接加载。

异步 Agent 消息与图中新产生的消息按到达顺序合并进持久化历史，避免临时拼接导致摘要边界在恢复后错位。执行中的消息保持可见且计入预算。

## 任务交接摘要

摘要模型收到消息角色、正文、工具调用名/参数及调用 ID，而不仅是正文。输出要求为七个 JSON 数组字段，并在客户端校验后转成有长度限制的文本：

| 字段 | 保留的信息 |
| --- | --- |
| Goal | 当前目标与范围 |
| Constraints | 用户要求、授权、禁止事项、最新纠正 |
| Completed | 真正完成的工作、决策与原因 |
| Pending | 未完成事项、阻塞、问题、失败路径 |
| Files | 精确路径、符号、参数、原文文件 ID |
| Validation | 已执行检查及实际结果，区分推测 |
| Next | 下一步具体操作 |

每个字段分配预算，过长的字段标注需要回查原文。模型调用失败、返回非结构化内容或空摘要时，使用明确标记为“未验证摘录”的有界回退内容，并保留原文引用；不把摘录伪装成已完成事项。取消操作会直接传播，不提交新摘要。

摘要必须确实节省 tokens 且最终输入不超预算，才会提交新的压缩边界、增加 compressionCount。如果系统/工具定义、最新请求或不能拆开的工具交换本身太大，会明确报错，不静默裁掉活跃规则和最新请求。

## 长工具输出与原文回查

主 Agent 为每个会话创建 ContextArtifacts：

~~~text
~/.deer-code/context/<session-id 的 SHA-256>/
  output-<内容 SHA-256>.txt
  history-<内容 SHA-256>.txt
~~~

过长的文本工具结果先写入文件，模型输入替换为文件 ID、读取说明及首尾预览。工具调用 ID、错误状态等保留；图状态和会话 JSON 仍保存完整原始消息。同一内容复用同一文件。图片等非文本内容不转成文本摘要。

Agent 可调用：

~~~json
{"id":"output-<64位哈希>.txt","offset":0,"limit":2000}
~~~

工具名称为 read_context_artifact。offset/limit 按 JavaScript 字符位置计算，返回 nextOffset 供继续读取。单次读取最多 4,000 字符，还会按配置的输出预算降低上限。ID 只能访问当前会话目录，不能指定任意路径。

文件写入失败会报错，不返回一个不存在的引用。原始文件保留用于恢复和审计，不自动过期；清空聊天或删除会话不会自动删除这些归档。确认无需回查后可手动清理对应的会话归档目录。

## 代码与验证

- src/context/ContextManager.ts：预算、工具结果处理、摘要、增量上下文视图。
- src/context/TokenCounter.ts：消息/工具参数计数、有界文本截取。
- src/context/history.ts：摘要记录及原始前缀校验。
- src/context/ContextArtifacts.ts：原文存储和分页读取工具。
- src/skills/middleware.ts：每次请求重建指令、合并消息和更新摘要记录。
- tests/context.test.ts：离线模型与真实 LangChain 图集成测试。

~~~bash
npm test
npm run typecheck
npm run build
~~~

测试覆盖会话恢复后摘要复用、只处理新增前缀、历史变化失效、完整工具交换保留、原文无损回读、写盘失败、模型回退、取消、工具 schema 预算及多次模型请求。使用离线模型，不产生真实 API 费用；摘要的实际语义质量仍取决于所选模型。
