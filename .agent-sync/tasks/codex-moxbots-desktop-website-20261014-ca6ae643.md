<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/moxbots-desktop-website-20261014 -->
<!-- git-project-sync-task:base=3ee8aab5c185b87d607d4692482d987830c63536 -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-WEB-008 Desktop app website entry points

## Objective

Make every visible MoXBots brand entry in the desktop app open `https://140.143.183.232/` in the system browser. Keep MyAgents' default website and all profile, identity, account, service, and data-directory behavior unchanged. This task owns renderer/profile source and its branch record only; primary owns review, merge, install, and native acceptance.

## Acceptance criteria

- MoXBots profile resolves its website URL to the requested server URL.
- Launcher hero logo is clickable and keyboard focusable and opens the configured profile URL.
- Existing sidebar and About website controls continue to use the shared profile URL.
- MyAgents fallback/default profile remains `https://myagents.io`.

## Completed

- Updated `APP_WEBSITE_URL` for the MoXBots profile only.
- Added a visible, keyboard-focusable launcher hero brand button only for the MoXBots profile, using the established `openExternal` path and localized website label. MyAgents keeps its original non-clickable logotype behavior.
- Existing sidebar brand button and About hyperlink already consume `APP_WEBSITE_URL`; no duplicate routing was added.

## Verification

- `vitest run --project dom src/renderer/components/launcher/BrandSection.test.tsx` using bundled Node v24.19.0 — passed (14 tests), including MoXBots click/Enter behavior and MyAgents non-clickable behavior.
- `vitest run --project unit src/renderer/i18n/applicationBrand.test.ts` using bundled Node v24.19.0 — passed (2 tests, both profiles).
- `MYAGENTS_BUILD_PROFILE=moxbot vite build` using bundled Node v24.19.0 — passed. Inspected emitted `dist/assets/index-C01_WTKT.js`: the requested URL appears once and `https://myagents.io` appears zero times in that app entry bundle. Vite emitted pre-existing dynamic-import/chunk-size warnings.
- Source inspection confirms `vite.config.ts` defaults `MYAGENTS_BUILD_PROFILE` to `myagents`, while `scripts/build-moxbot.mjs` sets it to `moxbot` for MoXBots bundles. The renderer URL is profile-gated in `src/shared/appProfile.ts`.
- Native bundle URL, installed app behavior, and actual external browser launch remain unverified pending parent integration/build and native acceptance.

## Blockers and unknowns

- Repo dependencies were installed in this isolated checkout with `npm ci --ignore-scripts --no-audit --no-fund --force`; npm 10.9.8 emitted a devEngines warning because the project requests npm >=11.15.0. No tracked lockfile change resulted.
- The installed `/Applications/MoXBots.app` was read-only inspected at version 0.5.2; this task did not establish its source commit provenance, and did not install or launch it.
- No native build or app installation was performed by this task.

## Next step

Primary: review this branch, then merge and coordinate native user-path acceptance (including actual browser launch and installed-source provenance).
