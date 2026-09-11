# Tools 模块

## 概述

`tools` 模块实现了 dl-code 的内置工具集，基于 LangChain 的 `DynamicStructuredTool` 构建。这些工具让 AI Agent 能够与文件系统、终端和任务管理系统交互。

## 文件结构

```
tools/
├── terminal/
│   ├── bash-terminal.ts  # Bash 终端实现
│   ├── tool.ts           # bash 工具定义
│   └── index.ts
├── fs/
│   ├── grep.ts           # grep 搜索工具
│   ├── ls.ts             # ls 列目录工具
│   ├── tree.ts           # tree 目录树工具
│   ├── ignore.ts         # 忽略模式配置
│   └── index.ts
├── edit/
│   ├── text-editor.ts    # 文本编辑器实现
│   ├── tool.ts           # text_editor 工具定义
│   └── index.ts
├── todo/
│   ├── tool.ts           # todo_write 工具定义
│   ├── types.ts          # TODO 类型定义
│   └── index.ts
└── index.ts              # 模块导出
```

## 内置工具

### bash (terminal/tool.ts)

执行 Bash 命令的工具，使用保活的 Shell 进程。

**参数：**
- `command: string` - 要执行的命令
- `reset_cwd?: boolean` - 是否重置工作目录

**特点：**
- 保活 Shell 进程，保持工作目录和环境变量
- 可选重置到项目根目录

**实现：** `BashTerminal` 类封装了 PTY 进程管理

### grep (fs/grep.ts)

基于 ripgrep 的内容搜索工具。

**参数：**
- `pattern: string` - 正则表达式模式
- `path?: string` - 搜索路径
- `glob?: string` - 文件过滤 glob
- `output_mode?: 'content' | 'files_with_matches' | 'count'`
- `B/A/C?: number` - 上下文行数
- `n?: boolean` - 显示行号
- `i?: boolean` - 忽略大小写
- `type?: string` - 文件类型
- `head_limit?: number` - 结果限制
- `multiline?: boolean` - 多行模式

**特点：**
- 自动应用忽略模式（node_modules、.git 等）
- 支持多种输出模式

### ls (fs/ls.ts)

列出目录内容的工具。

**参数：**
- `path: string` - 目录路径
- `all?: boolean` - 显示隐藏文件

### tree (fs/tree.ts)

显示目录树结构的工具。

**参数：**
- `path: string` - 根目录
- `depth?: number` - 最大深度

### text_editor (edit/tool.ts)

文件编辑工具，支持查看、创建、替换和插入。

**命令：**
- `view` - 查看文件内容
- `create` - 创建/覆盖文件
- `str_replace` - 字符串替换
- `insert` - 在指定行插入

**参数：**
- `command: 'view' | 'create' | 'str_replace' | 'insert'`
- `path: string` - 文件绝对路径
- `file_text?: string` - 文件内容（create）
- `view_range?: [number, number]` - 查看范围（view）
- `old_str?: string` - 要替换的文本（str_replace）
- `new_str?: string` - 新文本（str_replace/insert）
- `insert_line?: number` - 插入行号（insert）

**实现：** `TextEditor` 类封装了文件操作

### todo_write (todo/tool.ts)

更新 TODO 列表的工具。

**参数：**
- `todos: TodoItem[]` - 完整的 TODO 列表

**TodoItem 结构：**
```typescript
interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
  created_at?: number;
}
```

## 工具创建模式

所有工具使用 LangChain 的 `DynamicStructuredTool`：

```typescript
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

const myTool = new DynamicStructuredTool({
  name: 'tool_name',
  description: '工具描述',
  schema: z.object({
    param: z.string().describe('参数描述'),
  }),
  func: async ({ param }) => {
    // 工具实现
    return '结果字符串';
  },
});
```

## 忽略模式 (fs/ignore.ts)

定义搜索时忽略的目录/文件模式：

```typescript
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  // ...
];
```

## 依赖关系

```
tools
├── @langchain/core  # DynamicStructuredTool
├── zod              # Schema 定义
├── child_process    # 命令执行
└── project          # 项目根目录
```

## 使用方式

```typescript
import {
  bashTool,
  grepTool,
  lsTool,
  treeTool,
  textEditorTool,
  todoWriteTool,
} from './tools';

// 在 Agent 中使用
const agent = createReactAgent({
  llm: model,
  tools: [bashTool, grepTool, lsTool, treeTool, textEditorTool, todoWriteTool],
});

// 单独调用工具
const result = await grepTool.invoke({
  pattern: 'function',
  path: './src',
  type: 'ts',
});
```

## 设计要点

1. **Zod Schema** - 使用 Zod 定义工具参数，自动生成类型和验证
2. **描述丰富** - 详细的工具和参数描述帮助 AI 正确使用
3. **错误处理** - 所有工具返回友好的错误信息字符串
4. **保活进程** - Bash 工具使用保活进程提高效率
5. **默认忽略** - 搜索工具自动忽略无关目录
