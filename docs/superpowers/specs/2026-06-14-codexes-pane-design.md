# Codexes Pane Design

## Goal

Add a `Codexes` top-level pane to WebMux that acts like a browser tab for active Codex tmux sessions. It must not affect the existing `Terminals` grid or session collection.

## User Experience

The top bar will include `Terminals`, `Desktops`, and `Codexes`.

When `Codexes` is active:

- WebMux shows a compact session strip populated from `tmux -L codex list-sessions`.
- The first Codex session is selected automatically after sessions load.
- Clicking a session button switches the main terminal to that Codex tmux session.
- Only one Codex session is visible at a time.
- The visible Codex terminal uses roughly two thirds of the content width and the full available height.
- A scratch shell can be opened beside it, using roughly one third of the content width and the same full height.
- The scratch shell is optional and can be closed.
- There is no bottom filler area or add-cell grid in this pane.

## Backend Design

Add a Codex-specific API surface:

- `GET /api/codex/sessions`
  - Lists Codex tmux sessions from the `codex` tmux socket.
  - Returns structured JSON: session name, window count, attached count.
  - Uses `tmux -L codex list-sessions -F '#S\t#{session_windows}\t#{session_attached}'`.

- `POST /api/codex/attach`
  - Body: `{ "name": "<tmux-session-name>" }`.
  - Validates the requested name against the current Codex tmux session list.
  - Creates or reuses a WebMux terminal session backed by the exec transport.
  - Exec command: `tmux -L codex attach-session -t <validated-name>`.
  - Stores enough metadata to identify it as a Codex attach session and avoid duplicates.

- `POST /api/codex/scratch`
  - Creates or reuses a local scratch shell for the Codex pane.
  - Starts as a normal local shell through exec transport.
  - If safely available, it may start in the selected Codex pane's current directory; otherwise it starts in the default server working directory.

All Codex-created WebMux sessions remain isolated from `/api/sessions` responses used by the existing `Terminals` pane.

## Frontend Design

Add `codexes` to the workspace pane context and add a `Codexes` button in `TopBar`.

Create `CodexWorkspace`:

- Loads Codex tmux sessions from `GET /api/codex/sessions`.
- Maintains the selected tmux session name.
- Auto-selects the first returned session when none is selected.
- Calls `POST /api/codex/attach` for the selected session and renders the returned WebMux terminal session.
- Shows a session strip of buttons above the terminal area.
- Renders the selected Codex terminal through the existing `Tile`/`Terminal` stack where practical, but without the normal workspace grid.
- Supports an optional side scratch shell via `POST /api/codex/scratch`.

The main layout is a fixed two-column split when scratch is open:

- Codex terminal: `minmax(0, 2fr)`
- Scratch terminal: `minmax(0, 1fr)`

When scratch is closed, the Codex terminal fills the content width.

## Data Flow

1. User clicks `Codexes`.
2. `CodexWorkspace` loads tmux sessions.
3. The first tmux session is selected automatically.
4. Frontend asks the backend to attach to that tmux session.
5. Backend validates the tmux session still exists.
6. Backend creates or reuses an exec-backed WebMux session.
7. Frontend renders that session using the existing terminal WebSocket.
8. Selecting another session repeats steps 4-7 without touching the normal `Terminals` pane.

## Validation and Error Handling

- If `tmux` is missing, show an inline error in the `Codexes` pane.
- If there are no Codex tmux sessions, show an empty state with no terminal.
- If a selected tmux session disappears, refresh the list and select the first available session.
- Reject attach requests for names not returned by `tmux -L codex list-sessions`.
- Quote or avoid shell interpolation for tmux session names; validated names must not be passed through an unsafe shell string.
- If an exec-backed attach session exits, mark it disconnected and allow reconnect by selecting the session again.

## Testing

Backend tests should cover:

- Parsing tmux session list output.
- Empty tmux session lists.
- Rejecting unknown session names for attach.
- Reusing an existing Codex attach session instead of creating duplicates.
- Ensuring Codex sessions are excluded from the normal `/api/sessions` terminal list.

Frontend tests should cover:

- The `Codexes` top-bar button switches panes.
- The first Codex session auto-selects.
- Clicking a Codex session button requests an attach for that session.
- Opening and closing the scratch shell changes the split layout.

Manual verification should use Playwright against the running app:

- Confirm `Terminals` remains unchanged after visiting `Codexes`.
- Confirm Codex session buttons match `tmux -L codex list-sessions`.
- Confirm selecting a button renders the expected tmux session.
- Confirm the scratch shell appears to the right and both terminals use the full available height.
