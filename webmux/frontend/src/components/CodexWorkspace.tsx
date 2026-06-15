import { AgentWorkspace } from './AgentWorkspace';
import type { NamedTheme } from '../types';

interface CodexWorkspaceProps {
  fontSize: number;
  termCols: number;
  termRows: number;
  themes: NamedTheme[];
  globalTheme: string | null;
}

export function CodexWorkspace(props: CodexWorkspaceProps) {
  return <AgentWorkspace agentKind="codex" {...props} />;
}
