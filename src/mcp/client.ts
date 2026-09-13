import { spawn, ChildProcess } from 'child_process';
import {
  MCPServerConfig,
  MCPRequest,
  MCPResponse,
  MCPInitializeResult,
  MCPTool,
  MCPToolCallResult,
} from './types.js';
import { startupLogger } from '../utils/startup-logger.js';
import { StringDecoder } from 'node:string_decoder';

export class MCPClient {
  private config: MCPServerConfig; // mcp服务器配置
  private process?: ChildProcess; // 子进程引用
  private requestId = 0; //请求id计数器
  private pendingRequests = new Map<
    string | number,
    {
      resolve: (value: any) => void;
      reject: (error: any) => void;
    }
  >();
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private initialized = false; // 初始化状态
  private serverInfo?: MCPInitializeResult; // 服务器信息
  private httpSessionId?: string;
  private httpRequests = new Set<AbortController>();

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  // 主连接入口
  async connect(): Promise<void> {
    if (this.config.transport === 'streamable_http') {
      await this.connectHTTP();
    } else {
      await this.connectStdio();
    }
  }

  private async connectStdio(): Promise<void> {
    // 检查config.yaml配置中是否提供了command(npx必须存在)
    if (!this.config.command) {
      throw new Error('Command is required for stdio transport');
    }

    // 启动mcp服务
    this.process = spawn(this.config.command, this.config.args || [], {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // 验证stdin（父写子读即mcp客户端向mcp服务器发送请求）和stdout（子写父读即服务器向客户端响应）管道是否成功创建， 否则无法通信
    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('Failed to create process pipes');
    }
    this.process.stdin.on('error', error => this.rejectAllPending(error));

    // 接受服务器响应
    this.process.stdout.on('data', (data: Buffer) => {
      this.handleStdioData(data);
    });

    // 处理错误/警告日志
    this.process.stderr?.on('data', (data: Buffer) => {
      const message = data.toString();
      const lowerMessage = message.toLowerCase();
      
      let type: 'info' | 'error' | 'warning' = 'info';
      if (lowerMessage.includes('error') || lowerMessage.includes('failed') || lowerMessage.includes('fatal')) {
        type = 'error';
      } else if (lowerMessage.includes('warn') || lowerMessage.includes('warning') || lowerMessage.includes('avoid')) {
        type = 'warning';
      }
      
      if (!this.initialized) {
        startupLogger.log(`MCP Server stderr: ${message}`, type);
      }
    });

    // 监听进程错误事件
    this.process.on('error', (error) => {
      startupLogger.log(`MCP Server process error: ${error.message}`, 'error');
      console.error('MCP Server process error:', error);
      this.rejectAllPending(error);
    });

    // 监听进程退出事件
    this.process.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        const message = `MCP Server exited with code ${code}`;
        startupLogger.log(message, 'error');
        console.error(message);
      }
      this.rejectAllPending(new Error(`Process exited with code ${code}`));
    });

    // 执行MCP初始化握手
    await this.initialize();
  }

  private async connectHTTP(): Promise<void> {
    if (!this.config.url) {
      throw new Error('URL is required for HTTP transport');
    }
    await this.initialize();
  }

  private handleStdioData(data: Buffer): void {
    this.buffer += this.decoder.write(data);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse MCP message:', error);
        }
      }
    }
  }

  private handleMessage(message: MCPResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (pending) {
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(`MCP Error: ${message.error.message}`)
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async sendRequest(method: string, params?: any, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    const id = ++this.requestId;
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    if (this.config.transport === 'streamable_http') {
      return this.sendHTTPRequest(request, signal);
    } else {
      return this.sendStdioRequest(request, signal);
    }
  }

  private async sendNotification(method: string, params?: any): Promise<void> {
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };

    if (this.config.transport === 'streamable_http') {
      await this.sendHTTPRequest(notification);
      return;
    }

    if (!this.process?.stdin) {
      throw new Error('Process not initialized');
    }

    const message = JSON.stringify(notification) + '\n';
    this.process.stdin.write(message, error => { if (error) this.rejectAllPending(error); });
  }

  private async sendStdioRequest(request: MCPRequest, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('Process not initialized'));
        return;
      }
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pendingRequests.delete(request.id); };
      const abort = () => {
        cleanup();
        void this.sendNotification('notifications/cancelled', { requestId: request.id, reason: 'Caller cancelled' }).catch(() => {});
        reject(signal?.reason ?? new Error('MCP request cancelled; outcome unknown'));
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('MCP request timeout; outcome unknown')); }, 30000);
      this.pendingRequests.set(request.id, {
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); },
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }

      // 通过stdin发送请求
      const message = JSON.stringify(request) + '\n';
      this.process.stdin.write(message, (error) => {
        if (error) {
          cleanup();
          reject(error);
        }
      });

    });
  }

  private async sendHTTPRequest(request: Omit<MCPRequest, 'id'> & { id?: string | number }, signal?: AbortSignal): Promise<any> {
    if (!this.config.url) {
      throw new Error('URL not configured');
    }

    const controller = new AbortController();
    this.httpRequests.add(controller);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('MCP HTTP timeout; outcome unknown')), 30000);
    try {
      const response = await fetch(this.config.url, {
        signal: controller.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.httpSessionId ? { 'Mcp-Session-Id': this.httpSessionId } : {}),
          ...(this.serverInfo ? { 'MCP-Protocol-Version': this.serverInfo.protocolVersion } : {}),
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }
      if (request.method === 'initialize') this.httpSessionId = response.headers.get('mcp-session-id') ?? undefined;
      if (request.id === undefined) { await response.body?.cancel(); return undefined; }
      let result: MCPResponse;
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        if (!response.body) throw new Error('Empty MCP event stream');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = ''; let bytes = 0; let found: MCPResponse | undefined;
        try {
          while (!found) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 8 * 1024 * 1024) throw new Error('MCP response exceeds 8 MiB');
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const frame = buffer.slice(0, boundary.index);
              buffer = buffer.slice(boundary.index + boundary[0].length);
              const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
              if (!data) continue;
              const message = JSON.parse(data);
              if (message.id === request.id && ('result' in message || 'error' in message)) { found = message; break; }
            }
          }
        } finally { await reader.cancel(); }
        if (!found) throw new Error('MCP stream ended without the requested result');
        result = found;
      } else {
        result = await response.json() as MCPResponse;
      }
      if (result.id !== request.id) throw new Error('MCP response ID mismatch');
      if (result.error) {
        throw new Error(`MCP Error: ${result.error.message}`);
      }

      return result.result;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.httpRequests.delete(controller); }
  }

  private async initialize(): Promise<void> {
    // 发送初始化请求
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: 'dl-code',
        version: '0.1.0',
      },
    });

    // 保存服务器信息
    this.serverInfo = result;
    this.initialized = true;

    // 发送初始化完成通知
    await this.sendNotification('notifications/initialized');
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.initialized) {
      throw new Error('Client not initialized');
    }

    const tools: MCPTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.sendRequest('tools/list', cursor ? { cursor } : undefined);
      tools.push(...(result.tools || []));
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('MCP tool pagination repeated a cursor');
      if (cursor) cursors.add(cursor);
      if (cursors.size > 100) throw new Error('MCP tool pagination exceeds 100 pages');
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, any>,
    signal?: AbortSignal,
  ): Promise<MCPToolCallResult> {
    if (!this.initialized) {
      throw new Error('Client not initialized');
    }

    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }, signal);

    return result;
  }

  async disconnect(): Promise<void> {
    this.rejectAllPending(new Error('Client disconnected'));
    for (const controller of this.httpRequests) controller.abort(new Error('MCP client disconnected; outcome unknown'));
    this.httpSessionId = undefined;

    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }

    this.initialized = false;
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  getServerInfo(): MCPInitializeResult | undefined {
    return this.serverInfo;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
