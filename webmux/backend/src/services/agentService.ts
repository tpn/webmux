import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentKind, AgentWorkspaceName } from '../types';

export interface AgentTmuxSession {
  name: string;
  windows: number;
  attached: number;
}

export interface AgentConfig {
  kind: AgentKind;
  label: string;
  pluralLabel: string;
  workspace: AgentWorkspaceName;
  socket: string;
}

const CONFIGS: Record<AgentKind, AgentConfig> = {
  codex: {
    kind: 'codex',
    label: 'Codex',
    pluralLabel: 'Codexes',
    workspace: 'codexes',
    socket: process.env.CODEX_TMUX_SOCKET || 'codex',
  },
  claude: {
    kind: 'claude',
    label: 'Claude',
    pluralLabel: 'Claudes',
    workspace: 'claudes',
    socket: process.env.CLAUDE_TMUX_SOCKET || 'claude',
  },
  copilot: {
    kind: 'copilot',
    label: 'Copilot',
    pluralLabel: 'Copilots',
    workspace: 'copilots',
    socket: process.env.COPILOT_TMUX_SOCKET || 'copilot',
  },
};

export class AgentService {
  getConfig(kind: string): AgentConfig | undefined {
    return CONFIGS[kind as AgentKind];
  }

  parseTmuxSessions(output: string): AgentTmuxSession[] {
    return output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [name, windowsRaw, attachedRaw] = line.split('\t');
        return {
          name,
          windows: Number(windowsRaw) || 0,
          attached: Number(attachedRaw) || 0,
        };
      })
      .filter(session => session.name.length > 0);
  }

  private execFileOutput(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { encoding: 'utf8' }, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(String(stdout));
      });
    });
  }

  async listSessions(kind: AgentKind): Promise<AgentTmuxSession[]> {
    const config = CONFIGS[kind];
    try {
      const output = await this.execFileOutput('tmux', [
        '-L',
        config.socket,
        'list-sessions',
        '-F',
        '#S\t#{session_windows}\t#{session_attached}',
      ]);
      return this.parseTmuxSessions(output);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('tmux is not installed');
      }
      return [];
    }
  }

  async hasSession(kind: AgentKind, name: string): Promise<boolean> {
    return (await this.listSessions(kind)).some(session => session.name === name);
  }

  buildAttachExecArgv(kind: AgentKind, name: string): string[] {
    return ['tmux', '-L', CONFIGS[kind].socket, 'attach-session', '-t', name];
  }

  async getPaneCurrentPath(kind: AgentKind, name: string): Promise<string | undefined> {
    try {
      const output = await this.execFileOutput('tmux', [
        '-L',
        CONFIGS[kind].socket,
        'display-message',
        '-p',
        '-t',
        name,
        '#{pane_current_path}',
      ]);
      const cwd = output.trim();
      if (!cwd || !path.isAbsolute(cwd)) return undefined;
      const stat = await fs.promises.stat(cwd);
      return stat.isDirectory() ? cwd : undefined;
    } catch {
      return undefined;
    }
  }
}

export const agentService = new AgentService();
