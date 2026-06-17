import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentKind, AgentWorkspaceName } from '../types';
import { DATA_DIR } from './persistenceManager';

export type AgentRuntimeStatus = 'waiting' | 'working' | 'unknown' | 'stale';
export type AgentStatusSource = 'hook' | 'tmux' | 'webmux' | 'none';

export interface AgentTmuxSession {
  name: string;
  kind: AgentKind;
  display_name: string;
  windows: number;
  attached: number;
  created_at?: string;
  last_output_at?: string;
  status: AgentRuntimeStatus;
  status_source: AgentStatusSource;
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

const AGENT_KINDS: AgentKind[] = ['codex', 'claude', 'copilot'];
const STATUS_STALE_MS = 24 * 60 * 60 * 1000;
const STATUS_RECENT_MS = 5 * 60 * 1000;
const STATUS_ACTIVITY_SLOP_MS = 1500;

interface AgentStatusMetadata {
  kind?: AgentKind;
  name?: string;
  status?: AgentRuntimeStatus;
  source?: AgentStatusSource;
  updated_at?: string;
  last_input_at?: string;
  last_output_at?: string;
  last_output_source?: 'live';
  last_ready_at?: string;
}

function isNoTmuxServerError(err: unknown): boolean {
  const error = err as NodeJS.ErrnoException & { stderr?: string };
  const text = `${error.message ?? ''}\n${error.stderr ?? ''}`.toLowerCase();
  return text.includes('no server running') ||
    (text.includes('error connecting to') && text.includes('no such file or directory'));
}

function epochSecondsToIso(raw: string | undefined): string | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value * 1000).toISOString();
}

function isoTime(value: string | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function latestIso(...values: (string | undefined)[]): string | undefined {
  let latest = 0;
  let latestValue: string | undefined;
  for (const value of values) {
    const time = isoTime(value);
    if (time > latest) {
      latest = time;
      latestValue = value;
    }
  }
  return latestValue;
}

function metadataLastOutput(metadata: AgentStatusMetadata | undefined): string | undefined {
  if (metadata?.source === 'webmux' && metadata.last_output_source !== 'live') return undefined;
  return metadata?.last_output_at;
}

function statusFileName(name: string): string {
  return Buffer.from(name, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function statusDir(kind: AgentKind): string {
  return path.join(DATA_DIR, 'agent-status', kind);
}

function statusPath(kind: AgentKind, name: string): string {
  return path.join(statusDir(kind), `${statusFileName(name)}.json`);
}

function normalizeDisplayBase(kind: AgentKind, name: string): string {
  const withoutPrefix = name.startsWith(`${kind}-`) ? name.slice(kind.length + 1) : name;
  return withoutPrefix.replace(/-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/, '') || name;
}

export class AgentService {
  getConfig(kind: string): AgentConfig | undefined {
    return CONFIGS[kind as AgentKind];
  }

  getAgentKinds(): AgentKind[] {
    return [...AGENT_KINDS];
  }

  parseTmuxSessions(output: string, kind: AgentKind): AgentTmuxSession[] {
    const sessions = output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [name, windowsRaw, attachedRaw, createdRaw, activityRaw] = line.split('\t');
        const createdAt = epochSecondsToIso(createdRaw);
        const activityAt = epochSecondsToIso(activityRaw);
        return {
          name,
          kind,
          display_name: normalizeDisplayBase(kind, name),
          windows: Number(windowsRaw) || 0,
          attached: Number(attachedRaw) || 0,
          created_at: createdAt,
          last_output_at: activityAt,
          status: this.inferStatus(activityAt),
          status_source: activityAt ? 'tmux' as AgentStatusSource : 'none' as AgentStatusSource,
        };
      })
      .filter(session => session.name.length > 0);
    return this.assignDisplayNames(sessions);
  }

  private execFileOutput(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          (err as NodeJS.ErrnoException & { stderr?: string }).stderr = String(stderr ?? '');
          reject(err);
          return;
        }
        resolve(String(stdout));
      });
    });
  }

  private assignDisplayNames(sessions: AgentTmuxSession[]): AgentTmuxSession[] {
    const byBase = new Map<string, AgentTmuxSession[]>();
    for (const session of sessions) {
      const base = normalizeDisplayBase(session.kind, session.name);
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base)!.push(session);
      session.display_name = base;
    }

    for (const [base, group] of byBase) {
      if (group.length <= 1) continue;
      const ordered = [...group].sort((a, b) => {
        const createdDiff = isoTime(a.created_at) - isoTime(b.created_at);
        return createdDiff || a.name.localeCompare(b.name);
      });
      ordered.forEach((session, index) => {
        session.display_name = `${base} (${index + 1})`;
      });
    }

    return sessions;
  }

  private inferStatus(lastOutputAt: string | undefined, metadata?: AgentStatusMetadata): AgentRuntimeStatus {
    const now = Date.now();
    const lastOutputMs = isoTime(lastOutputAt);
    const metadataUpdatedMs = isoTime(metadata?.updated_at);

    if (metadata?.status === 'waiting') {
      if (!lastOutputMs || metadataUpdatedMs + STATUS_ACTIVITY_SLOP_MS >= lastOutputMs) {
        return 'waiting';
      }
      return 'working';
    }

    if (metadata?.status === 'working') return 'working';

    if (lastOutputMs && now - lastOutputMs <= STATUS_RECENT_MS) return 'working';
    if (!metadata?.status && lastOutputMs && now - lastOutputMs >= STATUS_STALE_MS) return 'stale';
    return 'unknown';
  }

  private inferStatusSource(lastOutputAt: string | undefined, metadata?: AgentStatusMetadata): AgentStatusSource {
    const metadataUpdatedMs = isoTime(metadata?.updated_at);
    const lastOutputMs = isoTime(lastOutputAt);
    if (metadata?.status === 'waiting' && (!lastOutputMs || metadataUpdatedMs + STATUS_ACTIVITY_SLOP_MS >= lastOutputMs)) {
      return metadata.source ?? 'hook';
    }
    if (metadata?.status === 'working') return metadata.source ?? 'webmux';
    return lastOutputAt ? 'tmux' : 'none';
  }

  private async readStatus(kind: AgentKind, name: string): Promise<AgentStatusMetadata | undefined> {
    try {
      const content = await fs.promises.readFile(statusPath(kind, name), 'utf8');
      const parsed = JSON.parse(content) as AgentStatusMetadata;
      if (parsed.kind && parsed.kind !== kind) return undefined;
      if (parsed.name && parsed.name !== name) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async mergeStatusMetadata(session: AgentTmuxSession): Promise<AgentTmuxSession> {
    const metadata = await this.readStatus(session.kind, session.name);
    const lastOutputAt = latestIso(session.last_output_at, metadataLastOutput(metadata), metadata?.last_ready_at);
    return {
      ...session,
      last_output_at: lastOutputAt,
      status: this.inferStatus(lastOutputAt, metadata),
      status_source: this.inferStatusSource(lastOutputAt, metadata),
    };
  }

  async recordStatus(
    kind: AgentKind,
    name: string,
    update: {
      status: AgentRuntimeStatus;
      source: AgentStatusSource;
      last_input_at?: string;
      last_output_at?: string;
      last_output_source?: 'live';
      last_ready_at?: string;
    },
  ): Promise<void> {
    const updatedAt = new Date().toISOString();
    const file = statusPath(kind, name);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const previous = await this.readStatus(kind, name);
    const lastOutputSource = update.last_output_source ?? (update.last_output_at === undefined ? previous?.last_output_source : undefined);
    const next: AgentStatusMetadata = {
      ...previous,
      kind,
      name,
      status: update.status,
      source: update.source,
      updated_at: updatedAt,
      last_input_at: update.last_input_at ?? previous?.last_input_at,
      last_output_at: update.last_output_at ?? previous?.last_output_at,
      last_output_source: lastOutputSource,
      last_ready_at: update.last_ready_at ?? previous?.last_ready_at,
    };
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
  }

  async listSessions(kind: AgentKind): Promise<AgentTmuxSession[]> {
    const config = CONFIGS[kind];
    try {
      const output = await this.execFileOutput('tmux', [
        '-L',
        config.socket,
        'list-sessions',
        '-F',
        '#S\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}',
      ]);
      const sessions = this.parseTmuxSessions(output, kind);
      const enriched = await Promise.all(sessions.map(session => this.mergeStatusMetadata(session)));
      return this.assignDisplayNames(enriched);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('tmux is not installed');
      }
      if (isNoTmuxServerError(err)) return [];
      throw err;
    }
  }

  async listAllSessions(): Promise<AgentTmuxSession[]> {
    const sessions: AgentTmuxSession[] = [];
    for (const kind of AGENT_KINDS) {
      try {
        sessions.push(...await this.listSessions(kind));
      } catch (err) {
        console.warn(`Failed to list ${kind} sessions for combined agent list:`, err);
      }
    }
    return this.assignDisplayNames(sessions);
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
