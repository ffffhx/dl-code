import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'node:crypto';
import { BaseMessage } from '@langchain/core/messages';
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { SessionContext, SessionMetadata } from './types.js';

const STORAGE_DIR = path.join(os.homedir(), '.deer-code');

export function serializeMessages(messages: BaseMessage[]): any[] {
  return messages.map((msg) => ({
    type: msg._getType(),
    id: msg.id,
    name: msg.name,
    content: msg.content,
    additional_kwargs: msg.additional_kwargs,
    response_metadata: (msg as any).response_metadata,
    tool_call_id: (msg as any).tool_call_id,
    tool_calls: (msg as AIMessage).tool_calls,
    status: (msg as ToolMessage).status,
  }));
}

export function deserializeMessages(serialized: any[]): BaseMessage[] {
  if (!Array.isArray(serialized)) return [];

  return serialized.map((msg) => {
    const baseProps = {
      id: msg.id,
      name: msg.name,
      content: msg.content,
      additional_kwargs: msg.additional_kwargs || {},
    };

    switch (msg.type) {
      case 'human':
        return new HumanMessage(baseProps);
      case 'ai':
        return new AIMessage({
          ...baseProps,
          tool_calls: msg.tool_calls,
          response_metadata: msg.response_metadata || {},
        });
      case 'system':
        return new SystemMessage(baseProps);
      case 'tool':
        return new ToolMessage({
          ...baseProps,
          tool_call_id: msg.tool_call_id || '',
          status: msg.status,
          response_metadata: msg.response_metadata || {},
        });
      default:
        return new HumanMessage(baseProps);
    }
  });
}

export class SessionManager {
  private currentSessionId: string | null = null;
  private sessionsDir: string;
  private currentSessionFile: string;

  constructor(storageDir = STORAGE_DIR) {
    this.sessionsDir = path.join(storageDir, 'sessions');
    this.currentSessionFile = path.join(storageDir, 'current-session.txt');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.loadCurrentSessionId();
  }

  private loadCurrentSessionId(): void {
    try {
      if (fs.existsSync(this.currentSessionFile)) {
        this.currentSessionId = fs.readFileSync(this.currentSessionFile, 'utf-8').trim();
      }
    } catch (error) {
      console.error('Error loading current session ID:', error);
    }
  }

  private saveCurrentSessionId(sessionId: string): void {
    try {
      fs.writeFileSync(this.currentSessionFile, sessionId, 'utf-8');
      this.currentSessionId = sessionId;
    } catch (error) {
      console.error('Error saving current session ID:', error);
    }
  }

  private getSessionFilePath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  createSession(userName: string | null = null): SessionContext {
    const sessionId = `session-${randomUUID()}`;
    const now = Date.now();

    const context: SessionContext = {
      sessionId,
      messages: [],
      userName,
      todos: [],
      createdAt: now,
      updatedAt: now,
    };

    this.saveSession(context);
    this.saveCurrentSessionId(sessionId);

    return context;
  }

  saveSession(context: SessionContext, strict = false): void {
    const temporary = this.getSessionFilePath(context.sessionId) + `.${randomUUID()}.tmp`;
    try {
      const filePath = this.getSessionFilePath(context.sessionId);
      const data = {
        ...context,
        messages: serializeMessages(context.messages),
        updatedAt: Date.now(),
      };
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (strict) throw error;
      console.error('Error saving session:', error);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  loadSession(sessionId: string): SessionContext | null {
    try {
      const filePath = this.getSessionFilePath(sessionId);
      if (!fs.existsSync(filePath)) {
        return null;
      }

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return {
        ...data,
        messages: deserializeMessages(data.messages || []),
      };
    } catch (error) {
      console.error('Error loading session:', error);
      return null;
    }
  }

  getCurrentSession(): SessionContext {
    if (this.currentSessionId) {
      const session = this.loadSession(this.currentSessionId);
      if (session) {
        return session;
      }
    }

    return this.createSession();
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  listSessions(): SessionMetadata[] {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      const sessions: SessionMetadata[] = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.sessionsDir, file);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          sessions.push({
            sessionId: data.sessionId,
            userName: data.userName,
            messageCount: data.messages?.length || 0,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
          });
        }
      }

      return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (error) {
      console.error('Error listing sessions:', error);
      return [];
    }
  }

  deleteSession(sessionId: string): boolean {
    try {
      const filePath = this.getSessionFilePath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        if (this.currentSessionId === sessionId) {
          this.currentSessionId = null;
          if (fs.existsSync(this.currentSessionFile)) {
            fs.unlinkSync(this.currentSessionFile);
          }
        }
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error deleting session:', error);
      return false;
    }
  }

  switchSession(sessionId: string): SessionContext | null {
    const session = this.loadSession(sessionId);
    if (session) {
      this.saveCurrentSessionId(sessionId);
      return session;
    }
    return null;
  }

  updateSessionContext(
    context: SessionContext,
    updates: Partial<Omit<SessionContext, 'sessionId' | 'createdAt'>>
  ): SessionContext {
    const updatedContext: SessionContext = {
      ...context,
      ...updates,
      updatedAt: Date.now(),
    };
    this.saveSession(updatedContext);
    return updatedContext;
  }
}
