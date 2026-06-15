import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import * as pty from 'node-pty';
import { Session, CreateSessionRequest } from '../types';
import { transportLauncher } from './transportLauncher';
import { presenceService } from './presenceService';
import { persistence } from './persistenceManager';
import { compactPositions } from './gridLayout';
import { assertTerminalGridPosition, nextTerminalGridPosition } from './terminalGridLimits';
import type { AgentKind, AgentSessionRole, AgentWorkspaceName, CodexSessionRole, WorkspaceName } from '../types';

const AGENT_WORKSPACES = new Set<WorkspaceName>(['codexes', 'claudes', 'copilots']);

function isAgentWorkspace(workspace?: WorkspaceName): workspace is AgentWorkspaceName {
  return workspace !== undefined && AGENT_WORKSPACES.has(workspace);
}

function inferAgentKind(session: Session): AgentKind | undefined {
  if (session.agent_kind) return session.agent_kind;
  if (session.workspace === 'codexes' || session.codex_role) return 'codex';
  if (session.workspace === 'claudes') return 'claude';
  if (session.workspace === 'copilots') return 'copilot';
  return undefined;
}

function agentRole(session: Session) {
  return session.agent_role ?? session.codex_role;
}

function agentSessionName(session: Session) {
  return session.agent_session_name ?? session.codex_session_name;
}

interface InternalCreateSessionOptions {
  title?: string;
  persistent?: boolean;
  execArgv?: string[];
  execCwd?: string;
  workspace?: WorkspaceName;
  agentKind?: AgentKind;
  agentRole?: AgentSessionRole;
  agentSessionName?: string;
  codexRole?: CodexSessionRole;
  codexSessionName?: string;
}

export class SessionBroker extends EventEmitter {
  private sessions = new Map<string, Session>();
  private scrollback = new Map<string, string>();
  private launchGenerations = new Map<string, number>();
  private static readonly SCROLLBACK_SIZE = 64 * 1024;

  constructor() {
    super();
  }

  async initialize(): Promise<void> {
    const saved = persistence.loadSessions();
    saved.forEach(s => {
      this.sessions.set(s.id, s);
    });
    console.log(`Loaded ${saved.length} sessions from persistence`);

    // Auto-reconnect persistent sessions that were previously active
    const reconnectable = saved.filter(s => s.persistent && s.hostname && !isAgentWorkspace(s.workspace));
    if (reconnectable.length > 0) {
      console.log(`Auto-reconnecting ${reconnectable.length} persistent sessions...`);
      for (const session of reconnectable) {
        try {
          session.state = 'connecting';
          session.updated_at = new Date().toISOString();
          this.scrollback.delete(session.id);
          const generation = this.bumpLaunchGeneration(session.id);
          const ptyProcess = transportLauncher.launch(session, undefined, session.key_id || undefined);
          this.wireEvents(session, ptyProcess, undefined, generation);
          console.log(`  reconnected: ${session.title} (${session.id})`);
        } catch (err) {
          session.state = 'error';
          session.updated_at = new Date().toISOString();
          console.error(`  failed to reconnect ${session.title}: ${(err as Error).message}`);
        }
      }
      this.persistSessions();
    }
  }

  shutdown(): void {
    console.log('Persisting session state before shutdown...');
    for (const session of this.sessions.values()) {
      if (session.state === 'connected' || session.state === 'connecting') {
        session.state = 'disconnected';
        session.updated_at = new Date().toISOString();
      }
      this.bumpLaunchGeneration(session.id);
      transportLauncher.kill(session.id);
    }
    this.persistSessions();
  }

  async create(req: CreateSessionRequest, owner: string = 'anonymous', internal: InternalCreateSessionOptions = {}): Promise<Session> {
    const id = uuidv4();

    // Determine hostname
    let hostname = req.hostname || '';
    let port = req.port || 22;
    if (req.host_id) {
      try {
        const hostsConfig = persistence.loadHosts();
        const hostEntry = hostsConfig.hosts.find(h => h.id === req.host_id);
        if (hostEntry) {
          hostname = hostEntry.hostname;
          port = hostEntry.port;
        }
      } catch {
        // hosts.yaml not available
      }
    }

    // Determine layout position (scoped to this owner's sessions)
    const ownerSessions = Array.from(this.sessions.values()).filter(s => s.owner === owner && !isAgentWorkspace(s.workspace));
    const { row, col } = isAgentWorkspace(internal.workspace)
      ? { row: req.row ?? 0, col: req.col ?? 0 }
      : nextTerminalGridPosition(ownerSessions, req.row, req.col);

    const agentKind = internal.agentKind ?? (internal.codexRole ? 'codex' : undefined);
    const agentRoleValue = internal.agentRole ?? internal.codexRole;
    const agentSessionNameValue = internal.agentSessionName ?? internal.codexSessionName;

    // Determine transport: use mosh if host allows it and config prefers it
    let transport = req.transport || 'ssh';
    if (transport === 'ssh' && req.host_id) {
      try {
        const appConfig = persistence.loadApp();
        const hostsConfig = persistence.loadHosts();
        const hostEntry = hostsConfig.hosts.find(h => h.id === req.host_id);
        if (appConfig.app.transport.prefer_mosh && hostEntry?.mosh_allowed) {
          transport = 'mosh';
        }
      } catch {
        // config not available, stick with ssh
      }
    }

    const session: Session = {
      id,
      kind: 'terminal',
      owner,
      transport,
      host_id: req.host_id || '',
      hostname,
      port,
      username: req.username,
      key_id: req.key_id || '',
      exec_command: req.exec_command,
      exec_argv: internal.execArgv,
      exec_cwd: internal.execCwd,
      cols: req.cols || 80,
      rows: req.rows || 24,
      row,
      col,
      state: 'connecting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      title: internal.title ?? (transport === 'exec' ? `${hostname}:${port}` : `${req.username}@${hostname}`),
      persistent: internal.persistent ?? true,
      minimized: false,
      workspace: internal.workspace,
      agent_kind: agentKind,
      agent_role: agentRoleValue,
      agent_session_name: agentSessionNameValue,
      codex_role: agentKind === 'codex' ? agentRoleValue : internal.codexRole,
      codex_session_name: agentKind === 'codex' ? agentSessionNameValue : internal.codexSessionName,
    };

    this.sessions.set(id, session);

    // Launch the PTY process (state stays 'connecting' until first data arrives)
    try {
      const generation = this.bumpLaunchGeneration(session.id);
      const ptyProcess = transportLauncher.launch(session, req.password, req.key_id);
      // Resolve initial command: explicit > template lookup
      let initialCmd = req.initial_cmd;
      if (!initialCmd && req.template_id) {
        // Lazy import to avoid circular dep
        const { TEMPLATES } = await import('../api/templates.js');
        const tpl = TEMPLATES.find(t => t.id === req.template_id);
        if (tpl?.initialCmd) initialCmd = tpl.initialCmd;
      }
      this.wireEvents(session, ptyProcess, initialCmd, generation);
    } catch (err) {
      session.state = 'error';
      session.updated_at = new Date().toISOString();
      console.error(`Failed to launch session ${id}:`, err);
    }

    this.persistSessions();
    await persistence.appendEvent({ type: 'session_created', session_id: id, hostname, username: req.username });
    this.emit('session_created', session);
    return session;
  }

  private bumpLaunchGeneration(sessionId: string): number {
    const next = (this.launchGenerations.get(sessionId) ?? 0) + 1;
    this.launchGenerations.set(sessionId, next);
    return next;
  }

  private isCurrentLaunch(sessionId: string, generation: number): boolean {
    return this.launchGenerations.get(sessionId) === generation && this.sessions.has(sessionId);
  }

  private wireEvents(session: Session, ptyProcess: pty.IPty, initialCmd: string | undefined, generation: number): void {
    let firstData = true;
    let cmdInjected = false;

    ptyProcess.onData((data: string) => {
      if (!this.isCurrentLaunch(session.id, generation)) return;
      if (firstData) {
        firstData = false;
        session.state = 'connected';
        session.updated_at = new Date().toISOString();
        // Inject initial command after a brief delay so the shell prompt is ready
        if (initialCmd && !cmdInjected) {
          cmdInjected = true;
          setTimeout(() => {
            if (!this.isCurrentLaunch(session.id, generation)) return;
            try { ptyProcess.write(`${initialCmd}\r`); }
            catch { /* session may have closed */ }
          }, 800);
        }
        presenceService.broadcastToSession(session.id, {
          type: 'status',
          session_id: session.id,
          state: 'connected',
        });
        this.persistSessions();
      }

      // Accumulate scrollback for late-joining viewers. When trimming, advance
      // past the next newline so a replay doesn't begin in the middle of an ANSI
      // escape sequence or a multi-byte UTF-8 codepoint.
      let buf = (this.scrollback.get(session.id) || '') + data;
      if (buf.length > SessionBroker.SCROLLBACK_SIZE) {
        buf = buf.slice(buf.length - SessionBroker.SCROLLBACK_SIZE);
        const nl = buf.indexOf('\n');
        if (nl !== -1 && nl < 4096) {
          buf = buf.slice(nl + 1);
        }
      }
      this.scrollback.set(session.id, buf);

      presenceService.broadcastToSession(session.id, {
        type: 'output',
        session_id: session.id,
        data,
      });
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      if (!this.isCurrentLaunch(session.id, generation)) return;
      session.state = 'disconnected';
      session.updated_at = new Date().toISOString();
      presenceService.broadcastToSession(session.id, {
        type: 'status',
        session_id: session.id,
        state: 'disconnected',
        message: `Process exited with code ${exitCode}`,
      });
      this.persistSessions();
      persistence.appendEvent({ type: 'session_exited', session_id: session.id, exit_code: exitCode });
    });
  }

  async reconnect(sessionId: string, password?: string): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    if (transportLauncher.isAlive(sessionId)) {
      this.bumpLaunchGeneration(sessionId);
      transportLauncher.kill(sessionId);
    }

    session.state = 'connecting';
    session.updated_at = new Date().toISOString();

    try {
      this.scrollback.delete(session.id);
      const generation = this.bumpLaunchGeneration(session.id);
      const ptyProcess = transportLauncher.launch(session, password, session.key_id || undefined);
      this.wireEvents(session, ptyProcess, undefined, generation);
    } catch (err) {
      session.state = 'error';
      session.updated_at = new Date().toISOString();
      throw err;
    }

    this.persistSessions();
    return session;
  }

  getScrollback(sessionId: string): string {
    return this.scrollback.get(sessionId) || '';
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const owner = session?.owner;
    const wasAgentWorkspace = isAgentWorkspace(session?.workspace);
    this.bumpLaunchGeneration(sessionId);
    transportLauncher.kill(sessionId);
    this.sessions.delete(sessionId);
    this.launchGenerations.delete(sessionId);
    this.scrollback.delete(sessionId);
    if (owner && !wasAgentWorkspace) {
      const ownerSessions = Array.from(this.sessions.values()).filter(s => s.owner === owner && !isAgentWorkspace(s.workspace));
      compactPositions(ownerSessions);
    }
    this.persistSessions();
    this.updateLayout(sessionId);
    await persistence.appendEvent({ type: 'session_deleted', session_id: sessionId });
    this.emit('session_deleted', sessionId);
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  listByOwner(owner: string): Session[] {
    return Array.from(this.sessions.values()).filter(s => s.owner === owner && !isAgentWorkspace(s.workspace));
  }

  listAgentByOwner(owner: string, kind?: AgentKind): Session[] {
    return Array.from(this.sessions.values()).filter(s => {
      if (s.owner !== owner || !isAgentWorkspace(s.workspace)) return false;
      return !kind || inferAgentKind(s) === kind;
    });
  }

  findAgentAttach(owner: string, kind: AgentKind, name?: string): Session | undefined {
    const attachSessions = this.listAgentByOwner(owner, kind).filter(s => agentRole(s) === 'attach');
    if (name) {
      return attachSessions.find(s => agentSessionName(s) === name) ?? attachSessions[0];
    }
    return attachSessions[0];
  }

  findAgentScratch(owner: string, kind: AgentKind): Session | undefined {
    return this.listAgentByOwner(owner, kind).find(s => agentRole(s) === 'scratch');
  }

  async ensureAgentAttach(
    owner: string,
    kind: AgentKind,
    workspace: AgentWorkspaceName,
    name: string,
    cols: number,
    rows: number,
    execArgv: string[],
  ): Promise<{ session: Session; created: boolean }> {
    const attachSessions = this.listAgentByOwner(owner, kind).filter(s => agentRole(s) === 'attach');
    const existing = attachSessions.find(s => agentSessionName(s) === name) ?? attachSessions[0];
    if (existing) {
      const shouldRelaunch = agentSessionName(existing) !== name;
      for (const stale of attachSessions) {
        if (stale.id !== existing.id) {
          await this.delete(stale.id);
        }
      }
      existing.cols = cols;
      existing.rows = rows;
      existing.title = name;
      existing.exec_argv = execArgv;
      existing.agent_kind = kind;
      existing.agent_role = 'attach';
      existing.agent_session_name = name;
      if (kind === 'codex') {
        existing.codex_role = 'attach';
        existing.codex_session_name = name;
      }
      existing.updated_at = new Date().toISOString();
      if (shouldRelaunch || !transportLauncher.isAlive(existing.id) || existing.state === 'disconnected' || existing.state === 'error') {
        this.relaunch(existing);
      } else {
        transportLauncher.resize(existing.id, cols, rows);
      }
      this.persistSessions();
      return { session: existing, created: false };
    }

    const session = await this.create({
      username: kind,
      hostname: `${kind}.local`,
      port: 0,
      transport: 'exec',
      cols,
      rows,
      row: 0,
      col: 0,
    }, owner, {
      title: name,
      persistent: false,
      execArgv,
      workspace,
      agentKind: kind,
      agentRole: 'attach',
      agentSessionName: name,
      codexRole: kind === 'codex' ? 'attach' : undefined,
      codexSessionName: kind === 'codex' ? name : undefined,
    });
    return { session, created: true };
  }

  async ensureAgentScratch(
    owner: string,
    kind: AgentKind,
    workspace: AgentWorkspaceName,
    cols: number,
    rows: number,
    cwd?: string,
  ): Promise<{ session: Session; created: boolean }> {
    const shell = process.env.SHELL?.trim() || '/bin/sh';
    const execArgv = [shell, '-l'];
    const existing = this.findAgentScratch(owner, kind);
    if (existing) {
      existing.cols = cols;
      existing.rows = rows;
      existing.exec_argv = execArgv;
      existing.exec_cwd = cwd;
      existing.agent_kind = kind;
      existing.agent_role = 'scratch';
      existing.agent_session_name = undefined;
      if (kind === 'codex') {
        existing.codex_role = 'scratch';
        existing.codex_session_name = undefined;
      }
      existing.updated_at = new Date().toISOString();
      if (!transportLauncher.isAlive(existing.id) || existing.state === 'disconnected' || existing.state === 'error') {
        this.relaunch(existing);
      } else {
        transportLauncher.resize(existing.id, cols, rows);
      }
      this.persistSessions();
      return { session: existing, created: false };
    }

    const session = await this.create({
      username: 'shell',
      hostname: 'local.shell',
      port: 0,
      transport: 'exec',
      cols,
      rows,
      row: 0,
      col: 1,
    }, owner, {
      title: 'Scratch shell',
      persistent: false,
      execArgv,
      execCwd: cwd,
      workspace,
      agentKind: kind,
      agentRole: 'scratch',
      codexRole: kind === 'codex' ? 'scratch' : undefined,
    });
    return { session, created: true };
  }

  private relaunch(session: Session): void {
    const generation = this.bumpLaunchGeneration(session.id);
    transportLauncher.kill(session.id);
    session.state = 'connecting';
    session.updated_at = new Date().toISOString();
    this.scrollback.delete(session.id);
    try {
      const ptyProcess = transportLauncher.launch(session, undefined, session.key_id || undefined);
      this.wireEvents(session, ptyProcess, undefined, generation);
    } catch (err) {
      session.state = 'error';
      session.updated_at = new Date().toISOString();
      throw err;
    }
  }

  move(sessionId: string, row: number, col: number): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (isAgentWorkspace(session.workspace)) throw new Error('Agent workspace sessions cannot be moved');
    assertTerminalGridPosition(row, col);
    session.row = row;
    session.col = col;
    session.updated_at = new Date().toISOString();
    this.persistSessions();
    return session;
  }

  rename(sessionId: string, title: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.title = title;
    session.updated_at = new Date().toISOString();
    this.persistSessions();
    return session;
  }

  setMinimized(sessionId: string, minimized: boolean): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.minimized = minimized;
    session.updated_at = new Date().toISOString();
    this.persistSessions();
    return session;
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cols = cols;
    session.rows = rows;
    session.updated_at = new Date().toISOString();
    transportLauncher.resize(sessionId, cols, rows);
  }

  sendInput(sessionId: string, data: string): void {
    const handle = transportLauncher.getHandle(sessionId);
    if (handle) {
      handle.write(data);
    }
  }

  private persistSessions(): void {
    const sessions = Array.from(this.sessions.values());
    persistence.saveSessions(sessions);

    try {
      const layout = persistence.loadLayout();
      layout.layout.tiles = sessions.filter(s => !isAgentWorkspace(s.workspace)).map(s => ({
        session_id: s.id,
        row: s.row,
        col: s.col,
      }));
      persistence.saveLayout(layout);
    } catch {
      // Layout not yet initialized
    }
  }

  private updateLayout(removedSessionId: string): void {
    try {
      const layout = persistence.loadLayout();
      layout.layout.tiles = layout.layout.tiles.filter(t => t.session_id !== removedSessionId);
      persistence.saveLayout(layout);
    } catch {
      // ignore
    }
  }
}

export const sessionBroker = new SessionBroker();
