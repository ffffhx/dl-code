# Commands 模块

## 概述

`commands` 模块实现了 dl-code CLI 的命令行接口，使用 yargs 构建命令解析。提供会话管理和应用启动等功能。

## 文件结构

```
commands/
├── start.ts         # 启动命令
├── list.ts          # 列出会话命令
├── switch.ts        # 切换会话命令
├── delete.ts        # 删除会话命令
├── info.ts          # 会话信息命令
├── yargs-config.ts  # yargs 配置
└── index.ts         # 模块导出
```

## 命令说明

### start (start.ts)

启动 dl-code 应用的主命令。

**功能：**

1. 读取配置文件中的 MCP 服务器配置
2. 初始化 MCP 服务器连接
3. 可选创建新会话
4. 渲染 OpenTUI UI 界面

**选项：**

- `--new, -n` - 创建新会话
- `--name` - 指定会话名称

**执行流程：**

```
读取 MCP 配置 → 初始化 MCP 服务器 → 创建会话(可选) → 渲染 UI
```

### list (list.ts)

列出所有已保存的会话，显示会话 ID、名称、消息数量、创建/更新时间。

### switch (switch.ts)

切换到指定的会话，恢复历史对话上下文。

### delete (delete.ts)

删除指定的会话及其数据。

### info (info.ts)

显示当前或指定会话的详细信息。

## 依赖关系

```
commands
├── ui              # OpenTUI UI 组件
├── session         # 会话管理
├── mcp             # MCP 服务器初始化
├── config          # 配置读取
└── utils           # 启动日志
```

## 使用方式

CLI 命令（通过 yargs 配置）：

```bash
# 启动应用
dl-code start

# 创建新会话启动
dl-code start --new --name "my-session"

# 列出会话
dl-code list

# 切换会话
dl-code switch <session-id>

# 删除会话
dl-code delete <session-id>

# 查看会话信息
dl-code info [session-id]
```

## 设计要点

1. **模块化命令** - 每个命令独立文件，便于维护和扩展
2. **会话持久化** - 通过 SessionManager 管理会话生命周期
3. **MCP 预初始化** - 在应用启动时预连接 MCP 服务器
4. **OpenTUI 渲染** - 使用声明式 UI 框架构建终端界面
