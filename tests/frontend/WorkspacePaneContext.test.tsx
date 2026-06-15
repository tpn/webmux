import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspacePaneProvider, useWorkspacePane } from '@frontend/contexts/WorkspacePaneContext';

function TestConsumer() {
  const { activePane, setActivePane } = useWorkspacePane();
  return (
    <div>
      <span data-testid="pane">{activePane}</span>
      <button onClick={() => setActivePane('desktops')}>go desktops</button>
      <button onClick={() => setActivePane('terminals')}>go terminals</button>
      <button onClick={() => setActivePane('codexes')}>go codexes</button>
      <button onClick={() => setActivePane('claudes')}>go claudes</button>
      <button onClick={() => setActivePane('copilots')}>go copilots</button>
    </div>
  );
}

describe('WorkspacePaneContext', () => {
  it('returns codexes as the default activePane', () => {
    render(
      <WorkspacePaneProvider>
        <TestConsumer />
      </WorkspacePaneProvider>,
    );
    expect(screen.getByTestId('pane').textContent).toBe('codexes');
  });

  it('updates activePane to desktops after setActivePane("desktops")', () => {
    render(
      <WorkspacePaneProvider>
        <TestConsumer />
      </WorkspacePaneProvider>,
    );
    fireEvent.click(screen.getByText('go desktops'));
    expect(screen.getByTestId('pane').textContent).toBe('desktops');
  });

  it('switches back to terminals after setActivePane("terminals")', () => {
    render(
      <WorkspacePaneProvider>
        <TestConsumer />
      </WorkspacePaneProvider>,
    );
    fireEvent.click(screen.getByText('go desktops'));
    expect(screen.getByTestId('pane').textContent).toBe('desktops');
    fireEvent.click(screen.getByText('go terminals'));
    expect(screen.getByTestId('pane').textContent).toBe('terminals');
  });

  it('useWorkspacePane returns context value from the provider', () => {
    render(
      <WorkspacePaneProvider>
        <TestConsumer />
      </WorkspacePaneProvider>,
    );
    // Initial render reflects provider default
    expect(screen.getByTestId('pane').textContent).toBe('codexes');
  });

  it('updates activePane to codexes after setActivePane("codexes")', () => {
    render(
      <WorkspacePaneProvider>
        <TestConsumer />
      </WorkspacePaneProvider>,
    );
    fireEvent.click(screen.getByText('go codexes'));
    expect(screen.getByTestId('pane').textContent).toBe('codexes');
  });

  it('updates activePane to agent panes', () => {
    render(
      <WorkspacePaneProvider>
        <TestConsumer />
      </WorkspacePaneProvider>,
    );
    fireEvent.click(screen.getByText('go claudes'));
    expect(screen.getByTestId('pane').textContent).toBe('claudes');
    fireEvent.click(screen.getByText('go copilots'));
    expect(screen.getByTestId('pane').textContent).toBe('copilots');
  });
});
