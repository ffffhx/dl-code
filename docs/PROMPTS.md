# Prompt 运行机制与回归评测

dl-code 的主 Agent 和只读子 Agent 共用 prompt 构建器。基础规则规定工作流程，实际工具注册表提供工具名称、说明和参数，项目规则按目录加载，激活的 Skills 在每次模型请求前注入。

## 基础行为

`src/prompts/base-prompt.ts` 包含：修改前阅读实现和项目规则、保留用户修改、按实际错误调整操作、执行相关验证、检查最终变更、如实报告已运行和未运行的检查。分析任务不要求修改文件；简单任务不强制列计划。

`tool-prompt.ts` 只为本次已注册的工具生成选择建议。工具 schema 是参数说明的权威来源。只读 Agent 不会收到对未注册编辑器或 shell 工具的使用推荐；父 Agent 只有实际注册了相关工具才会收到子 Agent 协作说明。

`includeProjectInfo` 与 `includeUserInfo` 分别控制上下文中的项目根目录与用户名。这两个开关不控制环境信息或项目规则加载。`customSections` 的 priority 只控制段落顺序，不表示模型消息权限。`examples.ts` 仍为独立示例，不是已接入的 Plan/Review 模式；真正的执行限制由工具集合及执行层落实。

## 项目规则

默认按以下来源加载：

1. 用户全局目录：`~/.dl-code/`。
2. 当前项目根目录。
3. 初始工作目录的祖先目录，以及后续访问的目标文件/目录的祖先目录。

每个目录使用第一个非空文件，顺序为：`AGENTS.override.md`、`AGENTS.md`、`agents.md`、`CLAUDE.md`。小写名称兼容本仓库的既有约定；在不区分大小写的文件系统上不会重复加载。错误或超限的 override 不会静默回退到另一份文件。

更深目录的规则只覆盖其子树中的项目惯例。用户当前明确要求和工具限制优先；项目规则和 Skills 不能授予权限。模型收到的每份规则都有独立的 `source`、`scope` 和正文。

例如：

```text
~/.dl-code/AGENTS.md       # 个人通用惯例
repo/AGENTS.md              # 构建命令、通用约定
repo/src/ui/AGENTS.md       # 仅 UI 子树的规范
repo/src/tools/AGENTS.md    # 仅工具子树的规范
```

加载器不递归扫描整仓库。访问 UI 时不会加载尚未访问的 tools 目录规则。已经加载的规则保留在本轮上下文中，但其目录范围始终标明。新一轮执行根据历史文件工具调用恢复相关范围，并重新读取磁盘文件；不同 Agent/会话不共用加载器状态。

`text_editor`、`read_file`、`grep`、`ls`、`tree` 的路径会在工具执行前检查。相对路径统一按项目根目录解析。首次发现新规则或规则发生变化时，该操作返回“未执行”，下一次模型请求注入规则后允许重试。同一批并行调用不会因为另一个调用发现了规则就提前绕过提示。

对于 shell、MCP 或其他自定义工具，模型必须先调用：

```json
{"paths": ["src/ui/Button.tsx", "src/tools"]}
```

工具名称为 `load_project_instructions`。这里不猜测 shell 文本内的目标路径，也不拦截任意 shell/MCP 副作用；这是当前自动范围检查的边界。它不是沙箱或通用权限系统。扫描一个上级目录也不会自动激活扫描结果涉及的所有后代目录规则。

规则正文合计默认最多 32 KiB（UTF-8 字节），最多跟踪 128 个目录。加载器不截断正文；超限、非文本或不可读规则会显示错误并暂停受检查的文件操作，需先由用户修正规则或调整配置。每次请求重读已加载规则；项目规则文件不能通过符号链接导入项目外正文。项目外普通文件访问不加载该外部目录的项目规则。

嵌入使用时可给 `ProjectInstructionLoader` 传 `userRoot`、`cwd`、`maxBytes`；`userRoot: null` 禁用个人规则，评测使用此设置以避免个人配置干扰。此轮没有新增 YAML 配置项。

## 不调用模型 API 的回归检查

```sh
npm run eval:prompts
npm run typecheck:prompts
```

覆盖目录范围、覆盖顺序、错误预算、符号链接、规则修改、并行调用、历史恢复、实际 LangChain Agent 工具循环、工具列表，以及评测判分器。脚本模型只验证运行机制，不证明真实模型的成功率提高。

## 真实模型行为评测

先配置现有 `config.yaml` 中的 `models.chat_model`，沿用项目的模型初始化入口。评测不会读取或使用当前仓库文件作为任务数据，而是在临时目录创建小型 JSON 编辑任务，只开放目标文件读取/精确替换、项目规则加载和固定断言检查，不开放 shell、MCP 或执行生成代码。

```sh
npm run eval:prompts:live -- --live --repeat 3 --label candidate --output .dl-code/evals/candidate.json
```

`--live` 显式启用模型调用。默认每个场景一次，每场景最多 40 个图步骤、120 秒；重复次数允许 1–10。每完成一个场景即写报告，失败也会记录并继续其他场景，最终有失败时退出码为 1。临时任务目录在场景结束后清理。

Windows PowerShell 若通过 `npm.ps1` 丢失了 `--` 后的参数，可将命令中的 `npm` 换成 `npm.cmd`。

四个场景：

| 场景 | 检查 |
| --- | --- |
| `fix-settings` | 修改目标设置、保留其他键、读取后编辑、验证最终版本 |
| `scoped-rules` | 遵循目标目录规则额外设置 backoff，同时保留其他设置 |
| `edit-recovery` | 注入一次并发修改错误，确认重新读取并保留用户最新内容 |
| `read-only` | 仅提供读取工具，确认文件未改并正确报告当前值 |

可用 `--case scoped-rules` 单独运行一个场景。报告记录文件/工具证据判分、耗时、模型请求数、工具错误、验证次数、最终回答及 provider 返回的 token 用量；缺少用量时数字可能为 0，不表示免费。发生异常时已收集的部分指标可能不完整。

判分不会接受“测试通过”这句话作为验证证据：修改场景必须在最后一次编辑后实际调用检查且通过。最终回答中更一般的无依据声明仍需人工审阅。这个小型套件评测工具使用和规则遵循，不代表真实代码仓库的修复成功率；通过离线脚本测试更不等于通过真实模型评测。

比较 prompt 文案时，把基线基础提示词保存在文件中：

```sh
npm run eval:prompts:live -- --live --repeat 3 --label baseline --prompt-file baseline.txt --output .dl-code/evals/baseline.json
```

`--prompt-file` 替换基础 prompt，实际工具说明、项目规则中间件和场景保持相同。固定模型版本、模型参数和重复次数比较成功率、工具错误及成本；报告中的 prompt hash 用于追踪模板。比较整个运行机制的变化需要在相应代码版本分别运行，而不仅替换文案。

Data-directory compatibility: `.dl-code` is preferred; if absent, an existing `.deer-code` directory is reused in place. See [rename compatibility](../README.md).
