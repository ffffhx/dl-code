import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** One persistent non-interactive shell per owner; never share its buffers across agents. */
export class BashTerminal {
  private child: ChildProcessWithoutNullStreams;
  private pending?: { marker: string; output: string; resolve: (value: string) => void; reject: (error: Error) => void; dispose: () => void };
  private closed = false;
  private exited: Promise<void>;

  constructor(cwd = process.cwd()) {
    const windows = process.platform === 'win32';
    this.child = spawn(windows ? 'powershell.exe' : '/bin/bash', windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] : ['--noprofile', '--norc'], {
      cwd, stdio: 'pipe', windowsHide: true, detached: !windows,
    });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.stdout.on('data', chunk => this.receive(chunk.toString()));
    this.child.stderr.on('data', chunk => this.receive(chunk.toString()));
    this.child.on('error', error => this.fail(error));
    this.child.on('close', () => { this.closed = true; this.fail(new Error('Shell exited')); });
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.dispose();
    pending?.reject(error);
  }

  private receive(text: string): void {
    const pending = this.pending;
    if (!pending) return;
    pending.output += text;
    if (pending.output.length > 2_000_000) {
      this.fail(new Error('Shell output exceeded 2 MB')); void this.close(); return;
    }
    const markerPattern = new RegExp(`${pending.marker}:(-?\\d+)\\r?\\n`, 'g');
    const matches = [...pending.output.matchAll(markerPattern)];
    // Both pipes must reach their marker; otherwise late stderr can leak into the next command.
    if (matches.length === 2) {
      this.pending = undefined;
      pending.dispose();
      pending.resolve(`${pending.output.replace(markerPattern, '').trim()}\n[exit_code: ${matches[0][1]}]`);
    }
  }

  execute(command: string, timeout = 30000, signal?: AbortSignal): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Shell is closed'));
    if (this.pending) return Promise.reject(new Error('This agent already has a running shell command'));
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const marker = `DL_DONE_${randomUUID().replaceAll('-', '')}`;
      const abort = () => { this.fail(new Error('Shell command cancelled')); void this.close(); };
      const timer = setTimeout(() => { this.fail(new Error('Shell command timed out')); void this.close(); }, timeout);
      this.pending = { marker, output: '', resolve, reject, dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
      signal?.addEventListener('abort', abort, { once: true });
      const encoded = Buffer.from(command).toString('base64');
      const script = process.platform === 'win32'
        ? `$global:LASTEXITCODE=0; try { Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))); $dlCommandStatus=if ($?) { $global:LASTEXITCODE } else { 1 } } catch { [Console]::Error.WriteLine($_.ToString()); $dlCommandStatus=1 }; [Console]::Out.WriteLine('${marker}:' + $dlCommandStatus); [Console]::Error.WriteLine('${marker}:' + $dlCommandStatus)\n`
        : `eval "$(printf '%s' '${encoded}' | base64 --decode)"; dl_command_status=$?; printf '\\n${marker}:%s\\n' "$dl_command_status"; printf '\\n${marker}:%s\\n' "$dl_command_status" >&2\n`;
      this.child.stdin.write(script, error => { if (error) this.fail(error); });
    });
  }

  async getcwd(): Promise<string> { return this.execute(process.platform === 'win32' ? '(Get-Location).Path' : 'pwd'); }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.fail(new Error('Shell closed'));
      const pid = this.child.pid;
      if (pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => this.child.kill());
        } else {
          try { process.kill(-pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
        }
      }
    }
    await this.exited;
  }
}
