# Session 模块

## 概述

`session` 模块负责管理用户会话，包括会话的创建、保存、加载、切换和删除。会话数据持久化存储在用户目录下。

## 文件结构

```
session/
├── SessionManager.ts  # 会话管理器实现
├── types.ts           # 类型定义
└── index.ts           # 模块导出
```

## 存储位置

```
~/.dl-code/
├── sessions/
│   ├── session-1234567890.json
│   └── session-1234567891.json
└── current-session.txt
```

## 核心组件

### SessionManager (SessionManager.ts)

会话管理器类，处理所有会话相关操作。

**核心方法：**

- `createSession(userName?)` - 创建新会话
- `saveSession(context)` - 保存会话到文件
- `loadSession(sessionId)` - 从文件加载会话
- `getCurrentSession()` - 获取当前会话（不存在则创建）
- `listSessions()` - 列出所有会话元数据
- `deleteSession(sessionId)` - 删除会话
- `switchSession(sessionId)` - 切换当前会话
- `updateSessionContext()` - 更新会话上下文

**消息序列化：**

会话保存时需要将 LangChain 的 `BaseMessage` 对象序列化为 JSON，加载时反序列化恢复。

支持的消息类型：
- `HumanMessage` - 用户消息
- `AIMessage` - AI 响应
- `SystemMessage` - 系统消息
- `ToolMessage` - 工具调用结果

### Types (types.ts)

**SessionContext - 完整会话上下文：**

```typescript
interface SessionContext {
  sessionId: string;           // 会话 ID
  messages: BaseMessage[];     // 消息历史
  userName: string | null;     // 用户名
  todos: TodoItem[];           // TODO 列表
  createdAt: number;           // 创建时间戳
  updatedAt: number;           // 更新时间戳
  tokenUsage?: TokenUsage;     // Token 使用统计
  compressionCount?: number;   // 压缩次数
}
```

**SessionMetadata - 会话列表元数据：**

```typescript
interface SessionMetadata {
  sessionId: string;
  userName: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}
```

## 依赖关系

```
session
├── fs                     # Node.js 文件系统
├── os                     # 获取用户目录
├── @langchain/core/messages  # 消息类型
└── tools/todo/types       # TodoItem 类型
```

## 使用方式

```typescript
import { SessionManager } from './session';

const sessionManager = new SessionManager();

// 创建新会话
const newSession = sessionManager.createSession('developer');

// 获取当前会话
const current = sessionManager.getCurrentSession();

// 添加消息并保存
current.messages.push(new HumanMessage('Hello'));
sessionManager.saveSession(current);

// 列出所有会话
const sessions = sessionManager.listSessions();

// 切换会话
sessionManager.switchSession('session-1234567890');

// 删除会话
sessionManager.deleteSession('session-1234567890');
```

## 设计要点

1. **文件持久化** - 会话保存为 JSON 文件，应用重启后可恢复
2. **当前会话追踪** - 使用单独文件记录当前活跃会话 ID
3. **消息序列化** - 正确处理 LangChain 消息的序列化和反序列化
4. **自动创建** - 获取当前会话时，不存在则自动创建
5. **按更新时间排序** - 会话列表按最后更新时间倒序

Data-directory compatibility: `.dl-code` is preferred; if absent, an existing `.deer-code` directory is reused in place. See [rename compatibility](../../README.md).
