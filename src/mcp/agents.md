# MCP 模块

## 概述

`mcp` 模块实现了 Model Context Protocol (MCP) 客户端，允许 dl-code 连接外部 MCP 服务器，动态加载和调用外部工具。支持 stdio 和 HTTP 两种传输方式。

## 文件结构

```
mcp/
├── client.ts          # MCP 客户端实现
├── manager.ts         # 服务器管理器
├── tool-converter.ts  # 工具转换器
├── types.ts           # 类型定义
└── index.ts           # 模块导出
```

## 核心组件

### MCPClient (client.ts)

单个 MCP 服务器的客户端实现。

**支持的传输方式：**

1. **stdio** - 通过子进程的标准输入/输出通信
2. **streamable_http** - 通过 HTTP POST 请求通信

**通信协议：** JSON-RPC 2.0

**核心方法：**

- `connect()` - 建立连接（自动选择传输方式）
- `initialize()` - 发送初始化握手
- `listTools()` - 获取服务器提供的工具列表
- `callTool(name, args)` - 调用指定工具
- `disconnect()` - 断开连接

**消息处理流程（stdio）：**

```
发送请求 → JSON 序列化 + 换行符 → stdin
                                    ↓
stdout → 按行解析 → JSON 反序列化 → 匹配 pending request → resolve
```

### MCPServerManager (manager.ts)

管理多个 MCP 服务器连接。

**核心方法：**

- `addServer(name, config)` - 添加并连接服务器
- `removeServer(name)` - 断开并移除服务器
- `getAllTools()` - 获取所有服务器的工具
- `callTool(serverName, toolName, args)` - 调用指定服务器的工具
- `disconnectAll()` - 断开所有连接

**全局实例：**

```typescript
const manager = getGlobalMCPManager();
await initializeMCPServers(config);
```

### Tool Converter (tool-converter.ts)

将 MCP 工具转换为 LangChain 的 DynamicStructuredTool。

**转换过程：**

1. 解析 MCP 工具的 JSON Schema
2. 保留原始 JSON Schema，使用 Ajv 校验参数
3. 创建 DynamicStructuredTool 包装器

**工具命名规则：** `mcp_{serverName}_{toolName}`

### Types (types.ts)

定义 MCP 协议相关的类型：

```typescript
interface MCPServerConfig {
  command?: string;        // stdio 命令
  args?: string[];         // 命令参数
  env?: Record<string, string>;  // 环境变量
  transport?: 'stdio' | 'streamable_http';
  url?: string;            // HTTP URL
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: JSONSchema;
}

interface MCPToolCallResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}
```

## 依赖关系

```
mcp
├── child_process     # 子进程管理（stdio 传输）
├── @langchain/core   # DynamicStructuredTool
├── zod               # Schema 验证
└── utils             # 启动日志
```

## 使用方式

```typescript
import { initializeMCPServers, loadMCPTools, getGlobalMCPManager } from './mcp';

// 从配置初始化所有 MCP 服务器
const config = {
  context7: {
    command: 'npx',
    args: ['-y', '@context7/mcp'],
    transport: 'stdio',
  },
};
await initializeMCPServers(config);

// 加载 MCP 工具为 LangChain 工具
const manager = getGlobalMCPManager();
const tools = await loadMCPTools(manager);

// 直接调用工具
const result = await manager.callTool('context7', 'search', { query: 'react hooks' });
```

## 设计要点

1. **协议协商** - 初始化请求版本 2025-03-26，后续 HTTP 请求携带服务端协商版本
2. **双传输支持** - stdio 适合本地进程，HTTP 适合远程服务
3. **请求超时** - stdio 和 HTTP 请求默认 30 秒超时，支持调用者取消
4. **错误处理** - 连接失败不影响其他服务器
5. **按需暴露** - 工具对象预先登记，模型只看到 ToolCatalog 激活的定义
6. **自动转换** - MCP 工具自动转换为 LangChain 工具格式

新增架构见 [ARCHITECTURE](../../docs/ARCHITECTURE.md)。HTTP 支持 JSON/SSE 响应、初始化通知和会话头；stdio 使用增量 UTF-8 解码并清理请求计时器。工具目录支持分页。
