import { AgentService, agentService, AgentTmuxSession } from './agentService';

export type CodexTmuxSession = AgentTmuxSession;

export class CodexService {
  parseTmuxSessions(output: string): CodexTmuxSession[] {
    return agentService.parseTmuxSessions(output);
  }

  listSessions(): CodexTmuxSession[] {
    return agentService.listSessions('codex');
  }

  hasSession(name: string): boolean {
    return agentService.hasSession('codex', name);
  }

  buildAttachExecArgv(name: string): string[] {
    return agentService.buildAttachExecArgv('codex', name);
  }

  getPaneCurrentPath(name: string): string | undefined {
    return agentService.getPaneCurrentPath('codex', name);
  }
}

export { AgentService };
export const codexService = new CodexService();
