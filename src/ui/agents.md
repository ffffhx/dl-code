# UI 模块

交互界面使用 OpenTUI Core。不要在主终端混用 Ink、ANSI Markdown 渲染器或直接 stdout 输出。

- terminal-app.ts：OpenTUI 节点、滚动区、多行输入、快捷键、主题及退出生命周期。
- transcript.ts：将 AgentSession 事件投影为消息和工具展示，按消息 ID 合并流式内容。
- themes/：共享主题配色。
- slash-commands/：命令解析和行为。

模型执行和持久化归 AgentSession 所有。文本增量只用于显示，完整消息才进入持久化历史。UI 更新以 33 ms 合并，历史消息保留节点，Markdown 的 streaming 标志在完成或中断时关闭。工具输出使用有长度上限的纯文本预览。

验证：npm test、npm run test:ui、npm run build。原生渲染测试使用项目内 Bun。详见 [TERMINAL_UI.md](../../docs/TERMINAL_UI.md)。
