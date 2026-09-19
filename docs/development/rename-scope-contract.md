# Rename Scope Contract (naming ownership)

Freshell shows several names for one underlying object. Each name has exactly
one owner and each rename surface writes exactly one scope:

| Scope | Owned by | Written by | Persists |
| --- | --- | --- | --- |
| Pane label | the pane (layout snapshot) | pane header inline rename; `PATCH /api/panes/:id` (agent API / MCP) | layout snapshot only |
| Tab label | the tab (layout organization) | TabBar inline rename; `PATCH /api/tabs/:id`; `name` on a REST/MCP tab create (agent API / MCP) | layout snapshot only |
| Terminal title | the terminal process | `PATCH /api/terminals/:id` (Overview card / terminal context menu) | `terminalOverrides[terminalId]` |
| Session title | the durable provider session | `PATCH /api/sessions/:key` (sidebar/history "Rename") | `sessionOverrides["provider:sessionId"]` |

Hard rules:

1. **Pane/tab renames never write terminal or session overrides.** The client
   `applyPaneRename`/`applyTabRename` thunks are Redux-only; the agent-API
   `PATCH /api/panes/:id` writes the layout store and broadcasts
   `ui.command{pane.rename}` with NO other side effect; nothing else PATCHes on
   a local rename. A stopped/exited pane with a retained `sessionRef` obeys the
   same rule — there is no "sessionRef fallback" write.
2. **`PATCH /api/sessions/:key` is the ONLY durable session-rename surface.**
   A non-empty `titleOverride` writes `{titleOverride, titleSource:"user"}` and
   cascades to the LIVE terminal running that session (terminal override +
   registry + `terminals.changed` + `cascadedTerminalId` in the response, then
   `sessions.changed`). `{"titleOverride": null}` REMOVES both `titleOverride`
   and `titleSource` — a leftover `titleSource:"user"` would permanently
   finalize the row at the top ladder rung and block all future automatic
   titles (both servers share this semantics).
3. **Terminal renames are terminal-scoped on both servers** and never cascade
   into session overrides (live OR retired identities). Rust ==
   Node here since b5fb; the older pane-rename cascade divisions EDEV-10 and
   EDEV-11 were removed, and `persistSyncableTerminalRename` is gone.
4. **Reset to provider title** (sidebar/history context menu, shown when the
   directory row reports `titleOverridden` and the override's source is not a
   sweep rung (`first-message`/`dir` — those would be re-applied instantly)):
   previews current vs
   provider-native title, then issues `{titleOverride: null}`. The directory
   wire carries `titleOverridden`, `providerTitle`, `titleOverrideSource` for
   this flow (Task 6/Task 7 of the b5fb plan). Reset does NOT rewrite any
   open terminal/pane title — those surfaces are their own scopes.
5. **Provider-title updates and the auto-title sweep never flip a `user`-rung
   override**, and pane/tab labels can no longer mint one — so provider titles
   update in history exactly until a user makes an explicit session rename.
6. **No title-equality inference, ever.** Identity is `provider + sessionId`;
   two same-titled rows are two sessions. No dedup, group, or cleanup infers
   sameness from equal titles.
7. **No mass migration of existing overrides.** Historical provenance is
   ambiguous; the reviewed per-session reset flow plus the existing
   one-generation `config.backup.json` (refreshed on every persist) are the
   recoverable path. The `titleSource` ladder (`shared/title-source.ts`)
   still governs all automatic writers.

## Display precedence (composition of stored labels)

The rules above govern WRITE scoping (who owns which rename surface). This
section records how the DISPLAY composes the several labels one tab or row can
hold at read time — exactly as the code composes them. The "Persists" column
above is untouched by this section.

**Tab display title** (enforced by `getTabDisplayTitle`, `src/lib/tab-title.ts`):

1. **Explicit title** — `tab.title` with `titleSetByUser: true`: a TabBar
   inline rename, a `PATCH /api/tabs/:id`, or an explicit non-empty `name` on a
   REST/MCP tab create (the `tab.create` fold sets the user flag for
   caller-provided names). An empty explicit title falls through.
2. **Single-pane override** — the sole leaf pane's stored non-derived pane
   title, whatever composed it (see the pane ladder below — a registry
   auto-title like "Codex CLI" or a mirrored session title can show as the
   tab title when no explicit title outranks it).
3. **Stored non-derived `tab.title`** set without the user flag (create-time
   mode labels like "Amplifier").
4. **cwd-leaf derived titles** — the `deriveTabName`/`derivePaneTitle`
   fallbacks.

**Pane title** — composed per pane kind (NOT a blanket mirror-over-auto rule;
enforced by the terminal-title cache plus `sessionTitleMirrorMiddleware`,
`src/store/sessionTitleMirror.ts`):

- A **user-set pane title** is never mirrored over.
- **Terminal panes**: a cached terminal-level title outranks the session-title
  mirror — the mirror skips any terminal pane whose `terminalId` has a cached
  title (`collectSessionTitleTargets`, `sessionTitleMirror.ts`), so registry
  auto-titles ("Codex CLI"), `PATCH /api/terminals/:id` renames, and the
  inventory/live folds own that pane; the mirror only titles terminal panes
  with NO cached terminal title (unattached/exited/not-yet-reattached panes).
- **Fresh-agent panes**: no registry pipeline — the session-title mirror is
  their runtime title source (always eligible).
- Fallback: the `initLayout`-derived cwd-leaf.

**Title-less running session rows** (a real session whose transcript has not
yet yielded a title): the sidebar row's label composes the same name order the
client-side fallback row uses — pane title, then the terminal's registry
title, then the provider label (`src/store/selectors/sidebarSelectors.ts`);
every other title-less row keeps the id-prefix fallback. The label is a
display fallback only — `hasTitle` stays false, and a later title-carrying
fetch still overrides it.
