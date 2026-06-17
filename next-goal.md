# /goal: WebMux Unified Agent Session List

  ## Summary

  Build a new default Agents top-row pane for WebMux on dgx first. It combines Codex, Claude, and Copilot sessions into one vertical left Session List, with the selected agent terminal on the right. Keep the existing Codexes, Claudes, and Copilots panes available, but migrate
  them to the same vertical list component filtered by kind so the horizontal button sprawl is gone everywhere.

  Use Codex hooks plus tmux timestamps for status and ordering. The Codex hook plan is based on the current official Codex Hooks docs: https://developers.openai.com/codex/hooks

  ## Key Changes

  - Add agents as a frontend workspace pane, add an Agents top-row button, and set DEFAULT_WORKSPACE_PANE = 'agents'.
  - Add GET /api/agents/sessions returning all agent sessions across codex, claude, and copilot; keep existing GET /api/agents/:kind/sessions for filtered panes.
  - Extend AgentTmuxSession with kind, display_name, created_at, last_output_at, status, and status_source.
  - Normalize display names by stripping <kind>- and trailing -YYYY-MM-DD-HH-MM-SS; if names collide, suffix by creation order as name (1), name (2).
  - Implement statuses:
      - waiting: Codex Stop hook has fired after latest working/input signal.
      - working: User input or output activity happened after the last waiting signal.
      - unknown: No reliable hook state yet, mainly Claude/Copilot or old Codex sessions.
      - stale: No recent activity and no useful hook signal.

  - Store status metadata under WEBMUX_HOME/data/agent-status/<kind>/<encoded-session-name>.json.
  - Add a small WebMux status-writer script used by Codex hooks. It should resolve the tmux session from TMUX_PANE/TMUX, falling back to explicit env if later added by codex-tools.
  - Install Codex UserPromptSubmit and Stop hooks on dgx during deployment:
      - UserPromptSubmit marks the session working.
      - Stop marks the session waiting.

  - Update WebMux broker observations so attached agent terminal output refreshes last_output_at, and terminal input marks the selected session working.
  - Use tmux session_created and session_activity as fallback metadata for all sessions.

  ## UI Behavior

  - Agents pane layout: left sidebar list, right terminal area.
  - Session rows show status dot, cleaned display name, agent kind badge, and small “last output/activity” text.
  - Selecting a row attaches the correct raw tmux session using the existing agent attach endpoint.
  - Empty states:
      - No sessions at all: show a compact empty state and keep refresh available.
      - No sessions for a filtered kind: show No Codex sessions, etc.

  - Sorting controls in the Session List:
      - Recently ready default: waiting sessions first, newest idle first.
      - Waiting longest: waiting sessions first, oldest idle first.
      - Name A-Z, Name Z-A.
      - Created newest, Created oldest.

  - Animate list reordering only for Recently ready and Waiting longest, using a small FLIP animation helper without adding a dependency.
  - Keep + Shell behavior as an optional scratch pane next to the selected agent terminal.

  ## Test Plan

  - Backend tests:
      - Parse tmux output with created/activity timestamps.
      - Return combined /api/agents/sessions.
      - Normalize names and duplicate suffixes deterministically.
      - Merge hook metadata with tmux fallback correctly.
      - Ignore hook files for tmux sessions that no longer exist.

  - Frontend tests:
      - Agents is the default landing pane.
      - Combined Session List renders Codex, Claude, and Copilot rows vertically.
      - Clicking a row calls attach with that row’s kind and raw name.
      - Sort modes order sessions as specified.
      - Duplicate display names get  (1),  (2) suffixes.
      - Empty states render for no sessions.

  - Playwright:
      - Add route-mocked e2e coverage for the new Agents pane.
      - Verify no horizontal session sprawl at desktop and iPad-sized viewports.
      - Verify sort changes reorder visible rows.
      - Verify selecting a session creates/shows the terminal panel.
      - After deploying to dgx, use Playwright against the live dgx URL for a smoke pass.

  ## Deployment

  - Implement on current feature branch.
  - Run npm run typecheck, npm test, npm run build, and npm run test:e2e from webmux/.
  - Deploy only to dgx first, restart the existing WebMux service, and verify with Playwright before touching other hosts.
  - Do not deploy to nv1, pi, spark, leopard, or viper until dgx behavior is approved.

  ## Assumptions

  - Keep existing Codexes, Claudes, and Copilots top-row buttons as filtered compatibility panes.
  - Default sort is Recently ready, matching the workflow preference described.
  - Claude and Copilot get the same UI immediately, but accurate ready/working transitions are Codex-first until equivalent hooks are identified.

