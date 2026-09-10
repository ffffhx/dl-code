# System Prompt Module

这个模块实现了一个灵活、可扩展的 system prompt 系统，参考了 Claude Code 和 Blade 的设计理念。

当前运行时已接入按目录加载的项目规则、按实际工具生成的使用建议以及验证/完成条件。使用方式、边界及回归评测见 [Prompt 运行机制与评测](../../docs/PROMPTS.md)。下方构建器示例不代表运行时模式或权限配置。

## 架构设计

### 核心组件

1. **types.ts** - 类型定义
   - `PromptContext`: 上下文信息
   - `ToolInfo`: 工具信息
   - `PromptSection`: 自定义提示词段落
   - `SystemPromptConfig`: 配置选项

2. **base-prompt.ts** - 基础提示词
   - `BASE_SYSTEM_PROMPT`: 核心系统提示词
   - `FIRST_MESSAGE_ADDENDUM`: 首次对话附加内容
   - `SUBSEQUENT_MESSAGE_ADDENDUM`: 后续对话附加内容

3. **tool-prompt.ts** - 工具相关提示词
   - `generateToolListPrompt()`: 生成工具列表
   - `generateToolUsageGuidelines()`: 生成工具使用指南

4. **context-prompt.ts** - 上下文提示词
   - `generateContextPrompt()`: 生成上下文信息
   - `generateEnvironmentPrompt()`: 生成环境信息
   - `generateSecurityPrompt()`: 生成安全指南

5. **system-prompt-builder.ts** - 提示词构建器
   - `SystemPromptBuilder`: 可配置的构建器类
   - `createSystemPrompt()`: 快速创建函数

## 使用方法

### 基础使用

```typescript
import { createSystemPrompt, ToolInfo } from '../prompts/index.js';

const tools: ToolInfo[] = [
  { name: 'bash', description: 'Execute bash commands', category: 'builtin' },
  { name: 'grep', description: 'Search for patterns', category: 'builtin' },
];

const prompt = createSystemPrompt({
  userName: 'John',
  projectRoot: '/path/to/project',
  isFirstMessage: true,
  availableTools: tools,
});
```

### 高级配置

```typescript
import { SystemPromptBuilder } from '../prompts/index.js';

const builder = new SystemPromptBuilder({
  includeToolList: true,
  includeProjectInfo: true,
  includeUserInfo: true,
  customSections: [
    {
      name: 'Project Guidelines',
      content: 'Follow the team coding standards...',
      enabled: true,
      priority: 10,
    },
  ],
});

const prompt = builder.build({
  userName: 'John',
  projectRoot: '/path/to/project',
  isFirstMessage: false,
  availableTools: tools,
  customInstructions: 'Use TypeScript strict mode',
});
```

### 动态更新配置

```typescript
const builder = new SystemPromptBuilder();

builder.updateConfig({
  includeToolList: false,
});

const prompt = builder.build(context);
```

## 设计原则

### 1. 模块化设计
每个功能独立成模块，便于维护和扩展：
- 基础提示词
- 工具提示词
- 上下文提示词
- 安全提示词

### 2. 可配置性
通过 `SystemPromptConfig` 灵活控制：
- 是否包含工具列表
- 是否包含项目信息
- 是否包含用户信息
- 自定义段落

### 3. 可扩展性
支持多种扩展方式：
- 自定义段落（`customSections`）
- 自定义指令（`customInstructions`）
- 工具分类（builtin/mcp/custom）

### 4. 上下文感知
根据对话状态调整提示词：
- 首次对话：介绍能力
- 后续对话：避免重复信息

## 提示词结构

生成的 system prompt 包含以下部分：

```
1. 基础系统提示词
   - 角色定义
   - 核心能力
   - 行为准则
   - 代码风格
   - 任务管理
   - 工具使用
   - 响应语言

2. 上下文信息
   - 用户名
   - 项目根目录

3. 工具列表
   - 内置工具
   - MCP 工具
   - 自定义工具

4. 工具使用指南
   - 文件操作
   - 命令执行
   - 搜索操作
   - 任务管理

5. 环境信息
   - 操作系统
   - Node 版本
   - 工作目录

6. 安全指南
   - 关键安全规则
   - 敏感操作处理

7. 自定义段落
   - 按优先级排序

8. 自定义指令

9. 对话状态提示
   - 首次对话 / 后续对话
```

## 最佳实践

### 1. 工具信息准确性
确保工具描述清晰、准确：
```typescript
const tools: ToolInfo[] = [
  {
    name: 'bash',
    description: 'Execute bash commands in the terminal',
    category: 'builtin',
  },
];
```

### 2. 自定义段落优先级
使用优先级控制段落顺序（数字越大优先级越高）：
```typescript
customSections: [
  { name: 'Critical Rules', priority: 100, ... },
  { name: 'Best Practices', priority: 50, ... },
  { name: 'Tips', priority: 10, ... },
]
```

### 3. 避免信息过载
只包含必要的信息，避免提示词过长：
```typescript
const builder = new SystemPromptBuilder({
  includeToolList: true,
  includeProjectInfo: true,
  includeUserInfo: false, // 如果不需要用户信息
});
```

### 4. 动态调整
根据场景动态调整配置：
```typescript
if (isPlanMode) {
  builder.updateConfig({
    customSections: [planModeSection],
  });
}
```

## 与 Claude Code 的对比

| 特性 | Claude Code | 本实现 |
|------|------------|--------|
| 基础提示词 | ✅ | ✅ |
| 工具列表 | ✅ | ✅ |
| 工具分类 | ❌ | ✅ |
| 自定义段落 | ❌ | ✅ |
| 配置系统 | 有限 | 完整 |
| 安全指南 | 内置 | 独立模块 |
| 环境信息 | 动态 | 动态 |

## 未来扩展

1. **Plan 模式提示词**
   - 专门的规划模式提示词
   - 任务分解指导

2. **压缩提示词**
   - 上下文压缩时的特殊提示词
   - 保留关键信息的策略

3. **多语言支持**
   - 根据用户语言动态切换
   - 本地化提示词

4. **提示词模板**
   - 预定义的场景模板
   - 快速切换不同模式

## 参考资料

- [Claude Code 深度解析](https://bytedance.larkoffice.com/docx/XszbdUrjJoHAhLxGgfwcBi3pnPS)
- [实现自己的 Claude Code](https://bytedance.larkoffice.com/wiki/NR58wnK1qiXa3ZklGfPc6eaenqh)
