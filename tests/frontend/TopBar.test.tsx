import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TopBar } from '@frontend/components/TopBar';
import { InputBroadcastProvider } from '@frontend/contexts/InputBroadcastContext';
import { WorkspacePaneProvider } from '@frontend/contexts/WorkspacePaneContext';
import type { AuthState } from '@frontend/hooks/useAuth';
import type { ReactNode } from 'react';

const wrapper = ({ children }: { children: ReactNode }) => (
  <InputBroadcastProvider>
    <WorkspacePaneProvider>{children}</WorkspacePaneProvider>
  </InputBroadcastProvider>
);

function makeAuth(overrides: Partial<AuthState> = {}): AuthState {
  return {
    isAuthenticated: true,
    isLoading: false,
    authStatus: { mode: 'local', bootstrap_required: false },
    error: null,
    login: vi.fn(),
    bootstrap: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
}

describe('TopBar', () => {
  const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

  const defaultTopBarProps = () => ({
    auth: makeAuth(),
    fontSize: 14,
    onFontSizeChange: vi.fn(),
    termCols: 80,
    termRows: 24,
    onTermSizeChange: vi.fn(),
    onNewAccount: vi.fn(),
    secureMode: true,
    currentUser: 'admin',
  });

  const withLocation = (hostname: string, run: () => void) => {
    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        protocol: 'https:',
        hostname,
        host: hostname,
        href: `https://${hostname}/`,
      },
      configurable: true,
    });
    try {
      run();
    } finally {
      if (originalLocation) {
        Object.defineProperty(window, 'location', originalLocation);
      }
    }
  };

  it('renders logo and controls', () => {
    render(<TopBar {...defaultTopBarProps()} />, { wrapper });
    expect(screen.getAllByText(/WebMux/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Terminals' }));
    expect(screen.getByText('14px')).toBeDefined();
  });

  it('shows secure badge in secure mode', () => {
    render(<TopBar {...defaultTopBarProps()} />, { wrapper });
    expect(screen.getByText(/Secure/)).toBeDefined();
  });

  it('shows trusted badge in trusted mode', () => {
    render(
      <TopBar {...defaultTopBarProps()} auth={makeAuth({ authStatus: { mode: 'none', bootstrap_required: false } })} secureMode={false} />,
      { wrapper },
    );
    expect(screen.getByText(/Trusted/)).toBeDefined();
  });

  it('calls onFontSizeChange when clicking A- or A+', () => {
    const onFontSizeChange = vi.fn();
    render(<TopBar {...defaultTopBarProps()} onFontSizeChange={onFontSizeChange} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Terminals' }));
    fireEvent.click(screen.getByText('A+'));
    expect(onFontSizeChange).toHaveBeenCalledWith(15);
    fireEvent.click(screen.getByText('A-'));
    expect(onFontSizeChange).toHaveBeenCalledWith(13);
  });

  it('shows Type to All button', () => {
    render(<TopBar {...defaultTopBarProps()} />, { wrapper });
    expect(screen.getByText('Type to All')).toBeDefined();
  });

  it('shows agent panes as top-level pane options', () => {
    render(<TopBar {...defaultTopBarProps()} />, { wrapper });
    expect(screen.getByText('Terminals')).toBeDefined();
    expect(screen.getByText('Desktops')).toBeDefined();
    expect(screen.getByText('Agents')).toBeDefined();
    expect(screen.getByText('Codexes')).toBeDefined();
    expect(screen.getByText('Claudes')).toBeDefined();
    expect(screen.getByText('Copilots')).toBeDefined();
  });

  it('toggles Type to All button on click', () => {
    render(<TopBar {...defaultTopBarProps()} />, { wrapper });
    fireEvent.click(screen.getByText('Type to All'));
    expect(screen.getByText('Type to All: ON')).toBeDefined();
  });

  it('shows current user badge', () => {
    render(<TopBar {...defaultTopBarProps()} currentUser="admin" />, { wrapper });
    expect(screen.getByText('admin')).toBeDefined();
  });

  it('shows + Account button', () => {
    render(<TopBar {...defaultTopBarProps()} />, { wrapper });
    expect(screen.getByText('+ Account')).toBeDefined();
  });

  it('calls onNewAccount when + Account clicked', () => {
    const onNewAccount = vi.fn();
    render(<TopBar {...defaultTopBarProps()} onNewAccount={onNewAccount} />, { wrapper });
    fireEvent.click(screen.getByText('+ Account'));
    expect(onNewAccount).toHaveBeenCalled();
  });

  it('shows term size and responds to C+/C-/R+/R-', () => {
    const onTermSizeChange = vi.fn();
    render(<TopBar {...defaultTopBarProps()} onTermSizeChange={onTermSizeChange} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Terminals' }));
    expect(screen.getByText('80×24')).toBeDefined();
    fireEvent.click(screen.getByText('C+'));
    expect(onTermSizeChange).toHaveBeenCalledWith(90, 24);
    fireEvent.click(screen.getByText('C-'));
    expect(onTermSizeChange).toHaveBeenCalledWith(70, 24);
    fireEvent.click(screen.getByText('R+'));
    expect(onTermSizeChange).toHaveBeenCalledWith(80, 29);
    fireEvent.click(screen.getByText('R-'));
    expect(onTermSizeChange).toHaveBeenCalledWith(80, 19);
  });

  it('shows sorted host buttons on the right for trent.me and disables the current host', () => {
    withLocation('nv1-webmux.trent.me', () => {
      render(<TopBar {...defaultTopBarProps()} />, { wrapper });

      const hostSwitcher = screen.getByTestId('host-switcher');
      expect(hostSwitcher.parentElement?.getAttribute('data-testid')).toBe('topbar');
      expect(Array.from(hostSwitcher.querySelectorAll('[data-testid="host-switch-link"], [data-testid="host-switch-current"]')).map(el => el.textContent)).toEqual([
        'dgx',
        'leopard',
        'nv1',
        'pi',
        'spark',
        'tiger',
        'viper',
      ]);

      expect(screen.getByTestId('host-switch-current')).toHaveTextContent('nv1');
      expect(screen.getByTestId('host-switch-current').tagName.toLowerCase()).toBe('span');
      expect(screen.getByRole('link', { name: 'dgx' })).toHaveAttribute('href', 'https://dgx-webmux.trent.me/');
      expect(screen.getByRole('link', { name: 'leopard' })).toHaveAttribute('href', 'https://leopard-webmux.trent.me/');
      expect(screen.getByRole('link', { name: 'pi' })).toHaveAttribute('href', 'https://pi-webmux.trent.me/');
      expect(screen.getByRole('link', { name: 'spark' })).toHaveAttribute('href', 'https://spark-webmux.trent.me/');
      expect(screen.getByRole('link', { name: 'tiger' })).toHaveAttribute('href', 'https://tiger-webmux.trent.me/');
      expect(screen.getByRole('link', { name: 'viper' })).toHaveAttribute('href', 'https://viper-webmux.trent.me/');
    });
  });

  it('keeps host switch links on tpn.nyc when the current instance is tpn.nyc', () => {
    withLocation('spark-webmux.tpn.nyc', () => {
      render(<TopBar {...defaultTopBarProps()} />, { wrapper });

      expect(screen.getByTestId('host-switch-current')).toHaveTextContent('spark');
      expect(screen.getByRole('link', { name: 'dgx' })).toHaveAttribute('href', 'https://dgx-webmux.tpn.nyc/');
      expect(screen.getByRole('link', { name: 'leopard' })).toHaveAttribute('href', 'https://leopard-webmux.tpn.nyc/');
      expect(screen.getByRole('link', { name: 'nv1' })).toHaveAttribute('href', 'https://nv1-webmux.tpn.nyc/');
      expect(screen.getByRole('link', { name: 'pi' })).toHaveAttribute('href', 'https://pi-webmux.tpn.nyc/');
      expect(screen.getByRole('link', { name: 'tiger' })).toHaveAttribute('href', 'https://tiger-webmux.tpn.nyc/');
      expect(screen.getByRole('link', { name: 'viper' })).toHaveAttribute('href', 'https://viper-webmux.tpn.nyc/');
    });
  });
});
