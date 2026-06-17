import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

export type WorkspacePane = 'terminals' | 'desktops' | 'agents' | 'codexes' | 'claudes' | 'copilots';

export const DEFAULT_WORKSPACE_PANE: WorkspacePane = 'agents';

interface WorkspacePaneContextValue {
  activePane: WorkspacePane;
  setActivePane: (pane: WorkspacePane) => void;
}

const WorkspacePaneContext = createContext<WorkspacePaneContextValue>({
  activePane: DEFAULT_WORKSPACE_PANE,
  setActivePane: () => {},
});

export function WorkspacePaneProvider({ children }: { children: ReactNode }) {
  const [activePane, setActivePane] = useState<WorkspacePane>(DEFAULT_WORKSPACE_PANE);
  return (
    <WorkspacePaneContext.Provider value={{ activePane, setActivePane }}>
      {children}
    </WorkspacePaneContext.Provider>
  );
}

export function useWorkspacePane() {
  return useContext(WorkspacePaneContext);
}
