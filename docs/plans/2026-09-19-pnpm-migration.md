# Freshell pnpm Migration Implementation Plan

> For agentic workers: execute only after implementation is requested. Use subagent-driven-development or executing-plans to carry out the tasks with review checkpoints. The unchecked steps below describe future work, not work completed during this planning request.

**Goal:** Replace npm for Freshell's first-party dependency installation and development/build/test workflows without changing application behavior or breaking portable desktop runtimes.

**Architecture:** Use an explicitly bounded pnpm workspace with a shared lock and separate demo locks. Export the existing sidecar and MCP runtime through pnpm's supported deploy operation while retaining their existing process and resource boundaries.

**Tech stack:** pnpm 10, Node 22, TypeScript/ESM, React/Vite, Rust/Cargo, Electron-builder, Vitest, Playwright, GitHub Actions, and Docker/Cloud Run.

Date: 2026-09-19. Status: proposed implementation plan; the migration has not been performed.

Investigated base: 2c0b6ffad001a5c171e7e0161ee922f7c973ff62. Six read-only Luna xhigh investigations covered dependencies, packaging, CI and tests, documentation, command semantics, and packaging alternatives. The parent also checked official versioned pnpm documentation and release metadata. All repository paths below are relative to the checkout root; cited source line numbers refer to the investigated base.

The existing npm baseline passed the repository-supported full suite through scripts/base-gate.sh test on 2026-09-19: cloud Vitest, source-runtime smoke, Cargo workspace tests, and Electron tests. This establishes the planning baseline, not pnpm compatibility. No pnpm install, lockfile conversion, or pnpm-built artifact was tested during planning.

While that gate ran, origin/main advanced to 9bdc8f63e (PR #809). Its five-file delta was inspected separately. It fixes Git environment leakage from the pre-push hook and expands fixture/Cargo routing. Preserve those fixes during implementation; this plan's branch remains on the exact fully tested base. Start implementation from the then-current origin/main after its required base gate.

## 1. Recommended outcome

Adopt an exact pnpm version, frozen installs, and pnpm's normal isolated dependency layout. Use a small workspace containing the existing root application, the existing Claude sidecar, and one private package that describes the already-existing MCP runtime's packaging dependencies. Keep the three demo applications independent.

The workspace is justified by packaging: Freshell currently reconstructs production dependency trees from npm lockfiles. Pnpm's supported deploy operation can build portable, filtered runtime trees from its shared lockfile. This removes npm-specific dependency traversal without requiring Freshell to implement its own pnpm resolver.

This is a build and development workflow change. Retain the Rust backend, existing source directories and public commands, separate Node sidecar/client processes, runtime resource paths, supported platforms, test coordination, and deployment approval rules. Do not introduce a new Node service or combine the sidecar with the main application runtime.

The largest work is adapting Electron runtime staging and command execution. Replacing installation commands and generating a lockfile is only one part of the migration.

### 1.1 Decisions used by this plan

| Decision | Recommendation and reason |
|---|---|
| Initial pnpm version | Pin pnpm 10.34.5. It preserves the existing Node minimum and provides the inspected shared-lockfile deploy implementation. Recheck the selected line before implementation; do not use an unpinned latest tag. |
| Node version | Preserve the root requirement of Node >=22.5.0 and the existing Node 22 tooling baseline. Document the stricter existing requirements of the Vite 7 demos. |
| Dependency layout | Use nodeLinker: isolated with pnpm's normal hidden dependency hoisting, not public/root hoisting. Fix missing first-party declarations and packaging assumptions; this is not a strict no-hoisting conversion. |
| Workspace | Root plus crates/freshell-claude-sidecar and packages/freshell-mcp-runtime only. No recursive catch-all glob. |
| Lockfiles | One workspace pnpm-lock.yaml and one independent pnpm-lock.yaml for each of the three demos: four authoritative locks in the final state. |
| Runtime packaging | Use normal pnpm deploy with injectWorkspacePackages enabled, then preserve or materialize the complete deployed dependency tree before Electron-builder copies it. |
| Lifecycle behavior | Explicitly preserve predev, predev:server, prebuild, prestart, and postinstall behavior. |
| Old worktrees | Keep narrowly scoped npm compatibility in shared hooks and the base-gate launcher. New pnpm branches use pnpm for first-party operations. |
| Delivery | One coherent migration PR, with focused commits and all affected checks passing. PR creation still requires explicit user approval. |

### 1.2 Alternatives considered

1. Independent pnpm projects for root and sidecar preserve today's installation boundaries most closely. They are viable, but portable MCP packaging would then need another independently locked staging package or a carefully validated dependency exporter. This duplicates dependency resolution and complicates keeping the compiled tools and their packaged dependencies aligned. Keep this as the fallback if the small-workspace deploy proof fails.
2. A workspace containing every example would simplify recursive commands but pull React 18/19 and Vite 6/7 demos into the application's default install and test scope. That is unnecessary for this migration.
3. A hoisted installation can resemble npm on disk, but it does not make the existing npm-lockfile parser work with pnpm. It also cannot be substituted blindly for the inspected pnpm deploy path. Investigate a narrowly scoped packaging workaround only if a demonstrated incompatibility requires one.
4. Pnpm 12 is the current release line as of this investigation; the registry's latest tag was 12.4.2, while latest-10 was 10.34.5 and latest-11 was 11.26.0. Pnpm 12 uses a native CLI; pnpm 11 also changes configuration and build defaults. Pnpm 11.26.0 requires Node >=22.13, so choosing it would require raising Freshell's supported minimum. The pnpm 12 registry wrapper's engine metadata and installation documentation differ; test its documented bootstrap rather than inferring compatibility from one field. Neither major is a drop-in substitute for the pnpm 10 plan: reconsider Node support, config, workspace isolation, subprocesses, and deploy together if choosing one. [Current installation documentation](https://pnpm.io/installation), [pnpm 11 changes](https://pnpm.io/blog/releases/11.0), [pnpm 11.26.0 metadata](https://registry.npmjs.org/pnpm/11.26.0), [pnpm 10.34.5 release](https://github.com/pnpm/pnpm/releases/tag/v10.34.5).

## 2. Current repository inventory

### 2.1 Packages and lockfiles

| Existing project | Current state | Migration disposition |
|---|---|---|
| Root package.json | Private application; 28 runtime dependencies, 38 development dependencies, 82 scripts; no packageManager or workspaces field. Npm lock v3 contains 1,164 package entries. | Add the pnpm pin; become workspace root. |
| crates/freshell-claude-sidecar | Private isolated SDK adapter; its own npm lock v3 with 110 entries. Cargo excludes this Node package. | Become an explicit workspace member with its own manifest and dependency boundary; merge its locked graph into the workspace lock. |
| examples/demo-projects/dataviz/viz-a | Separate npm lock v3, 121 entries; React 18/Vite 6. | Independent pnpm project and lock. |
| examples/demo-projects/dataviz/viz-b | Separate npm lock v3, 231 entries; React 19/Vite 7. | Independent pnpm project and lock. |
| examples/demo-projects/synth | Separate npm lock v3, 64 entries; Vite 7. | Independent pnpm project and lock. |
| examples/extensions/live-counter and status-dashboard | Private manifests without lockfiles or package scripts; historical server-extension examples. | Keep outside the workspace. These manifests are not inherently npm-specific. |
| Ignored .opencode and local tool state | Machine-local package installations, including native dependencies. | Exclude from the migration and every workspace glob. |
| packages/freshell-mcp-runtime | Does not currently exist. | Add a private packaging-only manifest for the existing MCP client; no new runtime service. |

Entry counts include platform-specific and other lock entries; they are not installed-package counts. Cargo.lock remains managed by Cargo.

### 2.2 Confirmed undeclared dependencies

| Import | Evidence | Required declaration |
|---|---|---|
| immer | src/store/store.ts:1 and test/setup/dom.ts:3; npm currently exposes Redux Toolkit's transitive dependency. | Root runtime dependency; preserve the locked 11.1.4 initially. |
| ajv | port/oracle/harness/contract-validator.ts:1; its comment explicitly requires Ajv 6 behavior. | Root development dependency on the existing 6.14.0/6.x line, not MCP's nested Ajv 8. |
| zod-to-json-schema | port/contract/generate-ws-contract.ts:38; currently supplied transitively by MCP SDK. | Root development dependency; preserve 3.25.1 initially. |

The Claude SDK is locked at 0.3.237 and declares peers that npm currently installs automatically. Make its host requirements explicit in the sidecar manifest using the already-locked versions: @anthropic-ai/sdk 0.120.0, @modelcontextprotocol/sdk 1.30.0, and zod 4.4.3. Review additional optional peers without indiscriminately installing all optional packages.

The root currently locks @modelcontextprotocol/sdk at 1.30.0 and zod at 4.3.6. The new MCP packaging manifest must initially reproduce that graph. Do not silently unify root and sidecar Zod versions during lock consolidation. Evaluate resolvePeersFromWorkspaceRoot: false so a sidecar peer cannot be satisfied accidentally by a different root version; prove the result with installed resolution and runtime probes.

The historical live-counter example requires ws without declaring it. This is an existing standalone-example defect exposed by isolation, not a reason to hoist the application. If its independent executable example is included in the migration's smoke coverage, declare its dependency and give it an explicit standalone install contract; otherwise record it as historical and leave it outside supported-install claims.

## 3. Package-manager setup and installation policy

### 3.1 Reproducible bootstrap

Add packageManager: pnpm@10.34.5 to the root manifest and each independently installable demo. Workspace members use the root pin. Use the same exact version in fresh-machine instructions, native Windows builds, GitHub Actions, cloud images, and sandbox images.

Use npm install --global pnpm@10.34.5 as the primary local/native-Windows and Docker bootstrap, followed by pnpm --version from the checkout. GitHub Actions uses a reviewed, pinned pnpm/action-setup revision that reads the exact root packageManager value, before setup-node's pnpm cache step. Install that exact pnpm version explicitly in each Docker stage that runs it; do not inherit an unspecified manager from a base image. Npm remains a legitimate bootstrap tool and a legitimate manager for unrelated globally installed coding CLIs. Corepack is an alternative only when separately installed, pinned, enabled, and tested; do not assume every Node installation includes a usable Corepack, and do not use unpinned Corepack/pnpm upgrades in CI. [Pnpm 10 installation](https://pnpm.io/10.x/installation), [Corepack project documentation](https://github.com/nodejs/corepack).

Normal checkout, CI, staging, and deployment-preparation installs use pnpm install --frozen-lockfile. Intentional dependency edits use pnpm add/update followed by review of the manifest and lock diff. A mismatched or missing lock must fail the frozen path. Do not silently recover by running a mutable install. [Frozen installation behavior](https://pnpm.io/10.x/cli/install).

### 3.2 Workspace settings

Initial configuration to prove in the first implementation spike:

~~~yaml
packages:
  - crates/freshell-claude-sidecar
  - packages/freshell-mcp-runtime
nodeLinker: isolated
injectWorkspacePackages: true
enablePrePostScripts: true
resolvePeersFromWorkspaceRoot: false
packageManagerStrictVersion: true
managePackageManagerVersions: false
allowBuilds:
  electron: true
  esbuild: true
~~~

This is a starting configuration, not a complete build-script inventory. The current root lock includes Electron 33.4.11, two esbuild versions, and Darwin-only fsevents install scripts. Review each required script on the actual target platform and make its allow/deny choice explicit. Each independent demo needs its own relevant policy. The sidecar lock currently contains no dependency install scripts.

The version settings reject a mismatched pnpm and disable its implicit manager download; bootstrap installs the pin explicitly. Prove a wrong-version invocation fails with remediation, including inside demos.

Pnpm 10.34.5 supports allowBuilds for dependency install scripts; unlisted scripts are blocked/warned, not automatically approved. enablePrePostScripts separately controls project script hooks, which startup preparation and the production build guard need. Consider strictDepBuilds after classifying known dependencies. Do not mix competing old onlyBuiltDependencies settings into this policy. [Pnpm 10 settings](https://pnpm.io/10.x/settings).

Retain pnpm's default hidden hoisting within node_modules/.pnpm/node_modules. It aids dependency/tool compatibility but is not public root hoisting or fully strict isolation. Prove first-party source declarations and portable runtime completeness directly; do not turn this migration into repairing every upstream package's undeclared imports. Leave publicHoistPattern empty and shamefullyHoist disabled.

Preserve intentional --ignore-scripts installs in cloud images and any narrowly scoped sidecar preparation path until actual build/runtime tests justify a change. A global --ignore-scripts setting would also skip root hook installation and required Electron preparation, so it is not the default development policy.

Keep package content in pnpm's normal shared store and each worktree's node_modules/virtual store local to that worktree. Do not enable an experimental global virtual store for this migration. Windows and Linux installations must have separate native dependency trees. Cross-filesystem stores may reduce linking benefits; measure before overriding defaults. [Pnpm dependency layout](https://pnpm.io/10.x/symlinked-node-modules-structure).

### 3.3 Lock conversion

1. Preserve the original five npm locks in Git history and record their package/version/integrity inventories before conversion. Do not combine a package-manager switch with broad dependency upgrades, audit fixes, or deduplication.
2. Add the missing direct dependencies at the versions already in the locks, add explicit sidecar peers, and define the new MCP packaging manifest using the root's existing MCP/Zod resolutions.
3. Import each existing root/sidecar lock in its own disposable conversion fixture and capture the resulting graph before attempting the combined workspace import. Then create the explicit workspace definition and run pnpm import with the old locks still available. Do not assume one workspace import recursively merges the sidecar's independent npm lock. [Pnpm import](https://pnpm.io/10.x/cli/import).
4. Compare versions, peer contexts, integrity data, and platform-specific optional dependencies against both original graphs and the independent conversions. In particular, preserve the SDK/Anthropic/MCP/Zod versions listed in section 2.2 and all required SDK platform packages. Use supported pnpm resolution with explicit declarations/targeted constraints to obtain the reviewed combined graph where importing alone cannot. Do not manually invent pnpm snapshot keys. Document unavoidable differences individually.
5. Give each demo its own pnpm-workspace.yaml containing packages: ['.'], the exact-version policy, and its required dependency-build policy. This is the chosen standalone boundary, not an either/or user recipe: from the demo directory use pnpm install --frozen-lockfile, then pnpm run dev/build. Import its old lock separately. Prove the nearest workspace config keeps its lock local and installs only that demo, both inside the repo and after copying it elsewhere. If that proof fails on the selected pnpm version, stop and revise this boundary before publishing instructions; do not silently fall back to a parent workspace install.
6. Run fresh frozen installs without existing npm node_modules. Verify root-only installation does not pull demo dependencies and that the root install includes the intended workspace packages.
7. Once all consumers have migrated, remove the root, sidecar, and three demo package-lock.json files in the migration branch. Final authority is one workspace pnpm lock plus three demo locks. Historical data fixtures are assessed separately.
8. Repeat the frozen install and require no manifest/lock changes. Preserve Cargo.lock and existing package versions unless a separately explained compatibility fix is necessary.

## 4. Command execution and lifecycle changes

### 4.1 Command mapping

| Existing use | New use | Important detail |
|---|---|---|
| npm ci | pnpm install --frozen-lockfile | Preserve --ignore-scripts only where intentional; remove npm-only audit/fund flags. |
| npm run build | pnpm run build | Prefer explicit run in infrastructure to avoid command-name collisions. |
| npm test / npm start | pnpm run test / pnpm run start | Preserve the coordinator and prestart hook. |
| npm run test:vitest -- run path --config config | pnpm run test:vitest run path --config config | Remove npm's forwarding separator. |
| npm run test:e2e -- --local | pnpm run test:e2e --local | Do not accidentally forward an extra -- to the cloud wrapper. |
| npm run --silent typecheck | pnpm run --silent typecheck | Put manager flags before the script name; use the long option. |
| npx tsx / vite / playwright / vitest for installed tools | pnpm exec followed by the installed tool | Avoid implicit downloading. Vitest still enters through the repo-owned coordinated path where required. |
| Deliberately temporary, exactly versioned package execution | pnpm dlx with that exact version | Build-time exception only; no network downloads in a running test job. |
| Direct node or cargo commands | Keep them | They are not npm commands. |

Pnpm forwards arguments after a script name, including an explicit --, to the script. Change first-party runner construction from npm's run/script/--/args to pnpm's run/script/args. Preserve a user's intentional literal separator for the downstream program; do not globally delete every -- token. The coordinator may continue accepting old leading-separator callers while new examples use the correct syntax. [Pnpm run](https://pnpm.io/10.x/cli/run), [pinned implementation](https://github.com/pnpm/pnpm/blob/v10.34.5/exec/plugin-commands-script-runners/src/run.ts), [pinned argv tests](https://github.com/pnpm/pnpm/blob/v10.34.5/pnpm/test/run.ts).

### 4.2 Shared subprocess helper

Consolidate the duplicated package-manager command resolution into a small internal helper, rather than adding a general-purpose multi-manager framework. It should select the requested project's manager, build argv correctly for that manager, and return an executable plus argument array.

Required cases:

1. Pnpm 10 JavaScript entrypoints, including .js and .cjs, invoked with the actual Node executable.
2. Native package-manager executables invoked directly, never passed to Node as JavaScript.
3. Missing npm_execpath, or an inherited npm_execpath belonging to npm while the target project requires pnpm.
4. Native Windows pnpm/Corepack shims and paths with spaces. Merely changing npm.cmd to pnpm.cmd under execFileSync is insufficient: .cmd files need an appropriate Windows command-launch path or resolution to their Node entrypoint. Keep any quoting in one tested helper. [Node subprocess documentation](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
5. Existing npm branches, only where compatibility is required by the shared hook or base-gate flow.
6. Correct cwd, environment inheritance, exit status, cancellation, and structured diagnostics without logging credentials.

The npm_* environment-variable names are compatibility interfaces, not words to rename. Use a real lifecycle fixture to verify npm_lifecycle_event (especially predev) in scripts/precheck.ts, npm_node_execpath resolving to standalone Node for Electron development, INIT_CWD, and the executable .bin PATH. Record pnpm's npm_command=run-script compatibility behavior without introducing a new dependency on that variable.

Explicit argv probes: pnpm run test:e2e --local must deliver run, --local to the wrapper; pnpm run test:e2e -- --local delivers run, --, --local and is not the migrated spelling. Likewise, pnpm run test:vitest run test/unit/foo.test.ts must deliver no leading separator, whereas inserting -- after test:vitest introduces one. A disposable script fixture can use that synthetic filename to inspect argv without attempting a real test run.

### 4.3 First-party files to update together

| Area | Files |
|---|---|
| Script composition | package.json: predev, predev:server, typecheck, build, electron:dev, electron:build, electron:build:win, prestart, serve, test:sequential, perf:audit:visible-first and every remaining nested npm call. |
| Coordinator dispatch | scripts/testing/coordinator-command-matrix.ts, coordinator-upstream.ts, test-coordinator.ts; scripts/run-standard-tests.ts; scripts/testing/run-source-runtime-tests.ts. |
| Runtime setup and launch | scripts/ensure-claude-sidecar.ts, prepare-rust-runtime.ts, launch-rust.sh, electron-dev-prerequisites.ts, run-electron-e2e.ts. |
| Test launch helpers | test/setup/npm-command.ts and its callers; test/setup/e2e-browser-global-setup.ts; test/e2e-browser/global-setup.ts; test/e2e-browser/helpers/mcp-stdio-client.ts; test/integration/tooling/source-runtime-rust.test.ts. |
| Local/cloud dispatch | scripts/e2e-cloud.sh, scripts/vitest-cloud.sh, docker/cloud-run/entrypoint.sh, sandbox wrappers and entrypoint. |
| Standard suite runner | scripts/run-standard-tests.ts: runner type, executable resolution, construction of build/test child argv, and user-visible command labels. Preserve balanced/aggressive scheduling. |
| Other executable entrypoints | scripts/measure-bandwidth.ts shebang and usage; scripts/amplifier-backfill-bundle.ts; performance audit launch/receipt paths; active bootstrap scripts under port/laptop-bootstrap. |

Keep the root script names and test-lane meanings intact. Do not replace the coordinator with pnpm recursive test execution. Keep scripts/start-rust-server.ts and the systemd service's direct Rust execution package-manager independent.

Check hardcoded tool paths individually. Paths to declared direct packages can still work through pnpm links; an occurrence of node_modules is not automatically wrong. Prefer Node module resolution for executable discovery where appropriate. Inspect scripts/run-electron-e2e.ts:156, crates/freshell-platform/src/mcp_inject.rs:193-274, and the development loader paths before changing them.

## 5. Claude sidecar preparation

The current installer at scripts/ensure-claude-sidecar.ts:18,60-176 runs npm ci, parses npm lock v3 metadata, and checks a flat installed SDK path. Replace that npm-specific contract.

The root workspace install will now install the sidecar up front. This is an intentional timing change from the current root-install-then-startup-sidecar-install flow. Document it and avoid adding a second unconditional workspace install on every dev/start command.

Recommended preparation behavior:

1. Keep prepare:rust-runtime responsible for first-run authentication setup and ensuring the sidecar is ready before starting Rust.
2. Resolve the SDK from the sidecar package's own context and validate the required entrypoint and target-compatible optional SDK package, not only the presence of a package.json.
3. With a current installation, return the existing structured readiness receipt without reinstalling unrelated root packages.
4. If dependencies are missing or the preparation fingerprint is stale, run the selected, frozen pnpm preparation path for the sidecar/workspace. Prove that its filter semantics preserve the root tool installation, do not include demos, and do not recurse through lifecycle hooks. If a safe filtered repair cannot be demonstrated, issue a precise root frozen-install remediation instead of silently doing a mutable install.
5. Let pnpm enforce lock consistency. Do not replace the npm-v3 parser with a second full lockfile parser. Record the installed SDK version, package-manager version, and relevant manifest/lock/config fingerprint in preparation diagnostics; do not claim a lock has been validated when only an installed file was inspected.
6. Keep failure before server spawn, preserve AUTH_TOKEN/.env handling, and keep packaged runtime startup free of package-manager installation.

The shared workspace does not make the sidecar a dependency of the root runtime. Its manifest, execution context, exported deployment tree, and Rust/Node process boundary remain separate. Set explicit package export/file inclusion rules so deploy includes index.mjs, the model-catalog helper, and every other file actually used by Rust; test these entrypoints from the exported tree.

## 6. Electron and portable runtime packaging

### 6.1 Why the current copier must change

scripts/prepare-electron-runtime.ts models npm lockfile v3 at lines 203-219, resolves physical npm paths at 333-408, copies dependency directories at 419-461, stages sidecar/MCP closures at 651-725, and loads both npm locks at 766-782. The generated MCP runtime also gets a synthetic npm lock.

Pnpm's linked graph and peer-specific package instances cannot be substituted into those assumptions. A successful installer build alone does not prove that its runtime dependencies survived copying.

The inspected Electron-builder/app-builder-lib version is 25.1.8. The current config deliberately excludes root node_modules from the app payload and stages resources through extraResources. Its file copier recreates symlinks. Preserve npmRebuild: false: this is an Electron-builder option name, not an npm command to rename, and avoids its npm/Yarn-oriented install/rebuild path.

### 6.2 Portable deploy design

Add packages/freshell-mcp-runtime/package.json as a private packaging-only project with type: module, a stable private version, dependencies on the root's already-locked MCP SDK and Zod, and a files list for generated runtime files. It must not depend on the root application package. This source packaging manifest is distinct from the final staged mcp/package.json: retain the staged name freshell and the application's release version, plus type: module. tools/freshell-mcp/server.ts:22-31 discovers its version by searching for that name; changing it to the private packaging name would make the MCP handshake report 0.0.0. Preserve and test this metadata contract rather than changing the public version-discovery behavior.

During runtime preparation, copy existing compiler output into its ignored generated directory:

~~~text
dist/tools/freshell-mcp        -> packages/freshell-mcp-runtime/generated/freshell-mcp
dist/tools/node-client-runtime -> packages/freshell-mcp-runtime/generated/node-client-runtime
~~~

Preserve the sibling relationship because compiled MCP imports refer to ../node-client-runtime. This does not require moving TypeScript source or changing the CLI/MCP public entrypoints. A successful build:tools is a mandatory staging precondition; prepare a fresh, run-owned generated tree so stale or deleted output cannot survive a previous copy. Prove that the package files list includes this ignored generated directory in the actual deploy output. If pnpm's packaging/ignore rules exclude it, correct the package-local export rules or use a controlled temporary package copy; do not treat the presence of compiler output as proof that deploy included it.

Use normal filtered deploy into newly created temporary output directories:

~~~text
pnpm --filter freshell-claude-sidecar --prod deploy <temporary-sidecar-output>
pnpm --filter freshell-mcp-runtime --prod deploy <temporary-mcp-output>
~~~

In the inspected pnpm 10 implementation, normal shared-lock deploy produces a filtered lock and installs it frozen. It requires a workspace with injectWorkspacePackages enabled and localizes the virtual store. The legacy path can run with frozenLockfile false, so do not silently use --legacy to get past a configuration failure. [Pnpm deploy](https://pnpm.io/10.x/cli/deploy), [pinned deploy implementation](https://github.com/pnpm/pnpm/blob/v10.34.5/releasing/plugin-commands-deploy/src/deploy.ts).

The commands above export packages; they do not deploy Freshell to a running host.

Adapt the existing stager to consume those exported trees:

1. Preserve electron-runtime/claude-sidecar, electron-runtime/mcp, electron-runtime/node-client-runtime, and the current Rust/client/bundled-Node resource contract.
2. Preserve every dependency and peer instance needed by each entrypoint. Do not flatten duplicate versions or infer closure from root node_modules.
3. Prefer materializing deployed links into ordinary files before Electron-builder copies resources, especially on Windows. Alternatively preserve the complete localized tree only after proving all targets remain inside the final artifact. Update both the stager's file traversal and scripts/verify-electron-artifact.ts to inspect links/junctions with lstat/readlink and resolve their targets before copying or hashing. Reject broken, cyclic, or escaping targets; a path-name allowlist alone cannot establish containment. Repeat the check after Electron-builder copying, because moving part of a valid deploy tree can invalidate links. This is portable-artifact correctness, not a new audit/security subsystem.
4. Keep target-compatible optional dependencies. In particular, do not use --no-optional for the Claude SDK's native platform package.
5. Remove runtime npm locks entirely and replace their validation with the existing staging receipt plus package metadata validation. Update RUNTIME_LAYOUT.claudeLock/mcpLock, getRuntimeAllowlist's requiredFiles, scripts/verify-electron-artifact.ts:155-173, and their fixtures together; those currently require package-lock.json and validate its name/version. Preserve the final MCP name/release-version contract described above. Extend the receipt with package-manager version, source lock fingerprint, and exported package identities, then verify its metadata matches the actual staged packages and runtime handshake. A pnpm-generated deploy lock may remain in temporary build output as evidence, but is not a new required installed-runtime file or a hand-maintained lock.
6. Validate names, versions, entrypoints, required files, file permissions, and link containment before publishing the staged output. Report the package and failing path in structured errors.
7. Stage in a temporary directory and publish the finished staging tree only after validation. Confine cleanup to generated output owned by that run.

Reconcile the existing RUNTIME_LAYOUT.electronUnpackedClaudeSdk allowance with the actual final artifact: the supported Node sidecar lives under extraResources/claude-sidecar, not in app.asar.unpacked. Do not add a second SDK copy or widen the ASAR to make the allowance true. If a configured builder still emits that optional tree, inspect and verify its links; remove an unused allowance only when the new producer/verifier contract demonstrates it is obsolete.

### 6.3 Node and native platform behavior

Packaged mode continues to use resources/node/bin/node or node.exe and the explicit FRESHELL_CLAUDE_NODE, FRESHELL_CLAUDE_SIDECAR, FRESHELL_MCP_NODE, and FRESHELL_MCP_ENTRY variables. Do not add pnpm or a registry/network requirement to the installed desktop application.

In Electron development, process.execPath is Electron, not the standalone Node executable. Do not blindly replace npm_node_execpath with process.execPath in electron/startup.ts:82-96. Have the development launcher supply the actual Node path explicitly, preserve explicit overrides, and verify direct development launch behavior.

Keep native Windows builds native: copy source to a Windows-local directory, exclude all Linux dependency/build output, and run Windows Node, pnpm, and MSVC Cargo there. Verify the Rust executable is PE, the bundled Node is native, and the SDK optional package matches Windows. Keep the existing native-platform assertion and NSIS behavior.

Require target-native dependency preparation for this migration: real staging must use dependencies installed for the requested platform/architecture, and fail clearly on unsupported host/target combinations. Existing --platform/--arch options do not make a host-installed SDK native package portable. Keep cross-platform fixture/verifier tests possible, but do not silently treat them as cross-target package-building support.

The current missing-electron-updater fallback at electron/entry.ts is a pre-existing packaging limitation. Do not widen the ASAR to include the entire root dependency tree or turn updater repair into part of this migration. Preserve and report the current behavior.

## 7. CI, containers, caches, and coordination

### 7.1 GitHub Actions

Update .github/workflows/electron-build.yml, electron-release.yml, and rust-tests.yml. The docs-pages deployment does not install Node dependencies and needs no package-manager change.

1. Set up the exact pnpm version before actions/setup-node attempts to resolve a pnpm cache. Read the root packageManager pin rather than maintaining a separate floating version.
2. Change npm cache selection to pnpm; use the workspace lock and relevant independent demo locks as cache dependencies for the jobs that install them. Cache package content, not a portable cross-OS node_modules tree.
3. Use frozen installs and the migrated script commands. Change the release uploader's npx tsx invocation to pnpm exec tsx.
4. Extend path filters to include pnpm-lock.yaml, pnpm-workspace.yaml, member manifests, relevant package-manager configuration, staging scripts, and new packaging inputs. Retain old-lock handling where it serves old branches.
5. Preserve all native OS/architecture matrix entries, required checks, artifact verification, and checkout-free runtime tests.
6. Ensure dependency/manager changes actually exercise the Rust tests that spawn Node fixtures. A rust-gate that instantly succeeds because no .rs file changed is not proof of this migration's Rust-fixture compatibility. Adjust relevant change routing or provide explicit affected-lane evidence.
7. Build the independent demos in an appropriate focused CI lane or Linux matrix step when their manifests/locks change. Their higher Node requirements must be satisfied there without changing the application's documented floor by accident.
8. Keep release upload/signing/publishing separate from validation. Build without publishing until the release operation is authorized.

[Pnpm action setup](https://github.com/pnpm/action-setup), [pnpm CI guidance](https://pnpm.io/10.x/continuous-integration).

### 7.2 Cloud Run test image

Update docker/cloud-run/Dockerfile, docker/cloud-run/entrypoint.sh, scripts/vitest-cloud.sh, scripts/e2e-cloud.sh, .dockerignore, and .gcloudignore together.

1. Copy the root lock/config and every workspace member manifest needed for installation before the dependency layer. Include the sidecar and private MCP package manifests even when their source/generated output is copied later.
2. Install the exact pnpm version in every image stage that invokes it. Preserve the existing intentional ignore-scripts policy and prove esbuild/client builds still work with the installed platform binaries.
3. Use local pnpm exec for Vitest/Playwright at job runtime. Preserve JSON argument transport, shell arrays, shard selection, retries, receipts, identity selection, and exit codes. Do not use dlx for runtime test execution.
4. Keep Playwright browser/image versions consistent. The root currently locks @playwright/test 1.58.2, and the cloud browser install is pinned to 1.58.2. If retaining that temporary build-time installation, use exactly versioned dlx; otherwise invoke the installed locked CLI and prove equivalent browser contents. Do not upgrade Playwright as part of command replacement.
5. Copy the complete local dependency tree, including hidden .pnpm contents and workspace-relative targets, or install/materialize a runtime image layout whose links are all present. Check final-stage package.json/config/member metadata if runtime pnpm commands need them.
6. Update ignore-file allowlists after broad exclusions so pnpm YAML files and member manifests reach Docker and Cloud Build. Preserve the intentional distribution-fixture exceptions and exclusions for host node_modules, stores, worktrees, secrets, and generated output.
7. Keep the content-addressed image identity and clean-worktree behavior. A lock/config change should invalidate dependency layers; a warm build of the same commit should reuse them. Existing registry cache export in docker/cloud-run/cloudbuild.yaml can remain unless the proof identifies a necessary adjustment.

Pnpm fetch or BuildKit store caching can improve later builds, but first establish the working frozen-install image. Do not make cache availability a correctness requirement. [Pnpm Docker guidance](https://pnpm.io/10.x/docker).

Also update examples/docker/Dockerfile explicitly: its client-builder stage copies package-lock.json and runs npm ci/build:client today. Provide the pnpm pin, workspace config/lock, and required member manifests before its frozen install. Preserve the intentionally minimal final Rust/static-client image; do not add pnpm, application node_modules, or a sidecar to that example's runtime image.

### 7.3 Disposable sandbox

Update docker/sandbox/Dockerfile, docker/sandbox/entrypoint.sh, scripts/sandbox-test.sh, sandbox-build.sh, and sandbox-selftest.sh.

1. Install pnpm in the image and ensure its store and dependency directories are writable by the sandbox user.
2. Replace the one-time .sandbox-npm-ci-done marker with package-manager-specific state keyed by the actual dependency inputs: package-manager version, workspace lock/config, root and member manifests, and relevant install policy. Write success state only after a successful install.
3. An old npm marker or volume must trigger the pnpm preparation path. An unchanged fingerprint may reuse the install; changed inputs must reinstall. A new pnpm-specific dependency volume is also a valid way to avoid overwriting an in-use legacy volume during rollout.
4. Keep the current separate PID/network namespaces, UID ownership, read-only corpus option, and container-owned node_modules. A pnpm store volume is optional; it does not replace installed-dependency validation.
5. Preserve the sandbox's intentionally pinned browser dependency setup unless changing it is required and verified. Do not substitute the cloud image's Playwright version mechanically.
6. Run sandbox-selftest after changes. Any tests that kill processes, corrupt config, or exercise restart storms remain inside the sandbox.

Exercise transition cases explicitly: a legacy npm manifest/lock and npm marker select npm; a pnpm manifest/lock with an old npm tree/marker triggers a pnpm install; both locks present defer to packageManager; changed dependency fingerprints reinstall. Preserve old-branch use where the shared wrapper/image needs it.

### 7.4 Shared hooks, old branches, and the base gate

scripts/install-hooks.mjs installs an absolute core.hooksPath pointing at the main checkout's scripts/hooks. Therefore the new pre-push hook must still operate on an old npm worktree.

Select the manager from the pushing/target worktree: packageManager is authoritative; a legacy npm lock without pnpm metadata selects npm. If both locks exist transiently, use the explicit packageManager value. Do not choose the manager from the hook owner's checkout or blindly reuse the caller's npm_execpath.

Keep both lock names in change routing while old branches exist. Add pnpm workspace/config/member inputs. Preserve current missing-tool behavior and manager-specific remediation, the local-worktree-first tool lookup, Cargo targeting, and the Git environment sanitization introduced by PR #809. Tests must not inherit GIT_DIR/GIT_WORK_TREE overrides that redirect their temporary repositories into the shared checkout.

scripts/base-gate.sh must choose installation and script invocation after entering its scratch worktree. During implementation, origin/main may still be npm while the feature branch is pnpm. Use npm ci --no-audit --no-fund for that npm base and frozen pnpm without those npm-only flags for a migrated base. Normalize the launcher's documented forwarding separator according to the selected manager, so an old base-gate caller does not accidentally pass a literal -- to pnpm; preserve deliberately forwarded downstream separators. A base gate validates origin/main; it does not validate the migration branch. Run branch verification separately.

Keep the coordinator's logical command keys, locking, holder semantics, queueing, environment sanitization, and schemaVersion 1 records. Existing npm holder/latest records remain readable. command.argv remains logical coordinator input, not the spawned npm/pnpm executable argv. The internal upstream runner need not become a new required persisted field. Existing reusable baseline keys include the commit, so a new manager does not require rewriting historical results. Update publicCommandDisplay() in scripts/testing/test-coordinator.ts:594-596 as well as execution: new pnpm holder/status commands omit npm's extra separator, while historical display strings remain readable.

## 8. Documentation and visible instruction inventory

README.md remains the canonical end-user Markdown documentation. Update existing developer/agent runbooks and link any new package-management developer note from AGENTS.md. Editing repository skill text here means updating instructions as an artifact, not invoking those skills during migration planning.

| Target | Required change |
|---|---|
| README.md: Quick Start, Prerequisites, Usage, standalone CLI/MCP | Explain exact pnpm bootstrap, frozen install, normal commands, and source-update transition. Keep direct Node client commands. Distinguish source prerequisites from requirements of the installed desktop app. |
| README.md: release clone command | It currently clones v0.7.5, an npm-based tag. Do not combine that old tag with new pnpm-only instructions. Before a pnpm release exists, explicitly separate the old stable-release instructions from pnpm development-main instructions; when the first pnpm release is published, update the tag and release quick start together. |
| AGENTS.md | Change command examples and package-manager prerequisites; document workspace boundaries, lock authority, build-script policy, pnpm argument forwarding, native Windows usage, old-worktree compatibility, and the existing coordinator/deployment rules. Link this plan and any enduring developer guide. |
| CLAUDE.md | It delegates to AGENTS.md; preserve that arrangement rather than duplicating instructions. |
| docs/skills/testing.md | Update the entire command table and focused examples. Keep coordinated routes, backend selection, proxy handling, production guard, and no-silent-fallback policy. Remove npm separators from new pnpm examples. |
| docs/development/pre-push-gate.md | Describe pnpm config/lock triggers, bootstrap/PATH recovery, root postinstall setup, shared-hook manager selection, and legacy npm worktrees. Preserve PR #809's environment/fixture-routing corrections. |
| docs/development/windows-electron-build.md | Update prerequisites, native PowerShell commands, WSL-to-Windows copy/run flow, sidecar/workspace preparation, packaging steps, and artifact checks. Exclude dependency/store/generated directories from cross-OS copies. |
| docs/development/test-sandbox.md | Update commands, pnpm preparation/cache ownership, fingerprint invalidation, and any new named volume. Keep destructive-test safety rules. |
| docs/development/self-hosted-launch-runbook.md | Explain preparing the locked workspace/sidecar before direct service launch; distinguish that from restarting production. The systemd unit itself still launches Rust directly. |
| docs/development/branch-model.md | Add a short link to manager-transition guidance if needed for old worktrees; no broader branch-model rewrite. |
| docs/development/gcloud-robot.md:274 | Update active test commands; preserve identity setup and OneCLI/robot policy. |
| examples/demo-projects/README.md | Update each independent install/build/dev recipe, its Node floor, and how to avoid the parent workspace. Its retired extension-pane claims are already stale: do not present pnpm migration as restoring those features; explain independent/browser usage where the recipe is retained. |
| examples/docker/README.md; examples/extensions/README.md | Verify the Docker command still builds the migrated image. Keep the distinction between supported CLI examples and historical server/client extensions. Avoid inventing a pnpm install step for dependency-free historical examples. |
| port/laptop-bootstrap/README.md and 2-bootstrap-wsl.sh | Add pnpm bootstrap, root workspace install, browser install, and build commands. Preserve separately installed provider CLIs. Check whether the script's selected branch is legacy npm and dispatch accordingly, or label its old-branch recipe historical. |
| port/contract/README.md | Update regeneration/test commands and describe unchanged protocol semantics. |
| .agents/skills/freshell-orchestration/SKILL.md | Replace repository-local npx tsx CLI examples with pnpm exec tsx; keep the endpoint/auth contract. |
| .claude/skills/demo-creating/SKILL.md and freshell-demo-creation/SKILL.md | Update repository CLI invocation examples. Inspect the .codex demo alias and edit the canonical target only. |
| .claude/skills/release-freshell/SKILL.md | Update dependency install/lock maintenance, build/test commands, workspace metadata implications, and first-pnpm-release instructions. Preserve explicit release authorization and validation. |
| .env.example, .gitignore, active source comments | Update npm-specific explanatory wording where it describes this repo. Add ignores for new generated packaging files and any deliberately local pnpm artifacts without ignoring authoritative locks. |

### 8.1 In-app instructions and script help

Update src/App.tsx:2268-2272 (update instructions), src/components/SetupWizard.tsx:520-523, and src/components/settings/NetworkSettings.tsx:432-435. The update dialog must account for a user coming from an npm release who does not yet have pnpm installed; changing only the last command is insufficient. Preserve the existing user interaction and restart-approval rules.

Update actionable diagnostics in scripts/precheck.ts, prebuild-guard.ts, electron-dev-prerequisites.ts, install-hooks.mjs, launch-rust.sh, the coordinator, cloud/sandbox wrappers, measure-bandwidth.ts, and amplifier-backfill-bundle.ts. Preserve process self-exclusion and error behavior when changing executable examples.

Name the remaining active guidance explicitly: crates/freshell-freshagent/tests/claude_sidecar_interrupt_dispatch.rs; test/e2e-browser/specs/mcp-bridge-rust.spec.ts, mcp-qa-smoke-rust.spec.ts, server-build-mismatch-rust.spec.ts, and continuity-smoke.spec.ts; test/e2e-electron/app-bound-rust-server.test.ts and electron-app.test.ts. Their setup/error messages must describe the actual manager even where the tests themselves invoke a shared helper.

Update the relevant command examples in docs/index.html, including its npm test and clone/dev sequences. Do not change npm install -g freshell to pnpm add -g freshell: the root package is private, so neither is an established installation route. Use a real supported source/desktop setup example. No page redesign is needed.

The exact npm-text assertions at test/unit/client/SetupWizard.test.tsx:849 and test/unit/client/components/SettingsView.network-access.test.tsx:865 should be removed rather than rewritten as pnpm-text assertions. Keep tests that exercise when the warnings appear, accessibility, and interaction. Verify copy by review and by actually executing the documented setup recipe.

### 8.2 Generated instructions and historical text

Update regeneration instructions in port/contract/generate-ws-contract.ts, then regenerate ws-message-inventory.json, ws-protocol.schema.json, and ws-server-messages.schema.json. Preserve wire shapes and semantic validation. Also update the active regeneration comment in crates/freshell-protocol/src/server_messages.rs and test/unit/port/ws-contract-freeze.test.ts; test-run guidance in config/vitest/vitest.port.config.ts and vitest.oracle.config.ts; and the retained typecheck commands in test/e2e-browser/tsconfig.cfg01-check.json, tsconfig.term04-check.json, tsconfig.restore01-check.json, and tsconfig.e3r1-spec-parse-check.json.

Leave crates/freshell-extensions/fixtures/manifest-oracle.json and port/oracle/fixtures/handshake-transcript.json unchanged: their old regeneration notes are frozen evidence and their generators were removed during Node-server retirement. Do not restore generators or hand-edit fixture provenance for this migration. The surviving port/oracle/baselines/pty/generate-batch-pty-goldens.ts may have its executable usage comment changed to pnpm exec tsx, but its goldens remain frozen; running it requires a separately reviewed fixture migration.

Classify mixed documents such as port/HANDOFF.md, port/README.md, and docs/debug-codex-app-server-leak.md by section. Update instructions still intended for current operation or point them to current runbooks; preserve recorded historical commands and version evidence. Most material under docs/plans, docs/lab-notes, docs/superpowers, docs/pbh-20260807, docs/rca, usual-sdd, and port/oracle reports is history. Specifically retain historical npm/Node recipes in docs/port-plan.md, port/machine/specs/electron-tauri.md, port/oracle/t3/run-against-rust.md, and port/oracle/rest-parity/README.md; none is the current supported development/launch runbook.

Keep intentional npm references in generic terminal/transcript tests, provider-shim descriptions, npm registry URLs, npm_* compatibility variables, Electron-builder's npmRebuild setting, third-party global CLI setup, and old command receipts. A repository-wide zero-occurrence replacement is not an acceptance criterion. Do not add a test that merely greps for banned words.

## 9. Required behavioral verification

Use red/green/refactor for implementation changes. Add failing behavior tests for the specific old assumption, implement the migration, and refactor duplicated launch/install logic while preserving coverage. Pure prose changes need review, not text-hash tests.

### 9.1 Test matrix

| Area | Evidence required before calling the migration complete |
|---|---|
| Clean install | Fresh workspace with no ancestor node_modules succeeds frozen; repeated install leaves locks/manifests unchanged; deliberate manifest/lock mismatch and wrong package-manager version fail; no implicit manager download occurs; required install scripts actually produce runnable tools. |
| Workspace scope | Root installs app/sidecar/MCP only; each demo installs independently inside and outside the repo; ignored tool state and historical fixtures are untouched. |
| Declared dependencies | Typecheck and execute the application/store initialization, Ajv-6 contract validation, and schema generation without npm hoisting. |
| Peers and optional packages | Runtime resolution reports the intended root/sidecar/MCP versions; sidecar platform package is present for each build target; no ambient root peer masks a missing sidecar requirement. |
| Lifecycle | Postinstall installs hooks in a real disposable Git checkout; predev/predev:server/prestart prepare prerequisites; prebuild still rejects unsafe artifact writes; current installations do not recursively reinstall. |
| Command forwarding | A real script fixture records argv for paths with spaces, selectors, --config, --local, --cloud, and intentional literal --. Coordinator and shell wrappers receive exactly those arguments; no empty test selection counts as success. |
| Manager resolution | Linux/macOS executable, Windows shim, .js/.cjs CLI, native executable, missing or wrong npm_execpath, and stripped PATH cases run or fail with the intended diagnostic. |
| Old/new worktrees | Shared new hook runs typecheck correctly from both npm and pnpm worktrees; base gate chooses the scratch checkout's manager; preserved Git environment sanitation prevents test Git operations from touching the real repo. |
| Coordinator | Existing schema-v1 npm records/active holders remain readable; one broad run holds the gate and another waits; failure/cancellation releases only its own resources; pnpm commands keep existing suite routing. |
| Source runtime | The release Rust binary starts through pnpm run start, serves the SPA, creates/preserves auth correctly, and can run the sidecar/MCP on isolated test ports. |
| Runtime export | Both deploy trees work with the source checkout and shared store unavailable; missing peer/transitive/optional dependencies fail the proof; links remain local after final artifact copying. |
| Desktop runtime | Existing checkout-free acceptance exercises Rust, fake-SDK Claude sidecar/model-catalog protocol behavior, MCP JSON-RPC/release version, and an empty cwd. Add a separate actual-SDK import/native-version probe with no fake SDK override, no authenticated model call, and no checkout/store/pnpm available. The existing fake-SDK test is not evidence of the real SDK dependency closure. |
| Native builds | Linux and macOS configured artifacts plus native Windows NSIS/PE/Node/SDK checks pass on the actual supported runners. WSL does not substitute for native Windows or macOS evidence. |
| Cloud | Image builds, container-layout verification passes, all four intended shards execute, argv/receipts/retries remain correct, and a repeated image build reuses the correct cache identity. |
| Sandbox | Old npm marker/volume, first pnpm install, unchanged inputs, changed lock/config/member manifest, failed install, and correct ownership all behave as intended; isolation self-test passes. |
| Examples and docs | Each retained demo builds on its documented Node version; README/release/source-update and native Windows recipes are exercised. Generic/historical npm examples remain intentionally classified. |

For fixture tests, include cases that would fail if the original npm-only behavior returned: .cjs launch, a pnpm-shaped transitive/peer tree, an escaping or broken copied link, and an extra argument separator. Process-kill/corruption/cancellation scenarios stay in disposable sandboxes with owned processes.

### 9.2 Existing tests and helpers to adapt

1. Command/coordinator tests: test/unit/tooling/runtime-npm-launch.test.ts (rename to reflect its new responsibility), run-standard-tests.test.ts, process-tree.test.ts, prepare-rust-runtime.test.ts, electron-dev-prerequisites.test.ts, and test/unit/tooling/testing/coordinator-*.test.ts plus global-setup tests. Preserve old npm process fixtures where they protect generic process handling; add actual pnpm cases.
2. Hook tests: test/unit/scripts/rust-test-targets.test.ts, including PR #809's real temporary-repository and environment tests. Add routing/manager-selection behavior without inspecting shell source strings.
3. Packaging tests: test/unit/electron/ensure-claude-sidecar.test.ts, prepare-electron-runtime.test.ts, verify-electron-artifact.test.ts, startup-rust.test.ts, and existing Electron-builder runtime coverage. Build fixtures with real dependency resolution behavior, including peers, duplicate versions, and optional native assets.
4. Integration: test/integration/tooling/source-runtime-rust.test.ts and test/integration/electron/checkout-free-runtime.test.ts. Keep the existing fake-SDK protocol test; add real deployed SDK import/peer resolution and native executable version probes on an untouched runtime copy, with FRESHELL_CLAUDE_SDK_QUERY_MODULE unset. Run from an empty cwd using bundled Node, with NODE_PATH empty and checkout/store dependencies unavailable. These probes must not require provider credentials or make a model call. Keep the existing distribution/runtime boundary assertions that execute the runtime or verifier, and retain the MCP release-version handshake assertion.
5. Browser/Electron: test/e2e-browser global setup and MCP helpers; affected MCP bridge/QA, server startup/build mismatch, and continuity specs; test/e2e-electron/playwright.electron.config.ts, app-bound-rust-server.test.ts, and electron-app.test.ts. The exact spec list should follow changed call sites, not a blanket promise that filtered cloud specs were covered.
6. Cloud shell tests: scripts/test/cloud-run-wrapper.test.sh, cloud-vitest-integration.test.sh, cloud-run-config.test.sh, cloud-run-dockerfile.test.sh, cloud-e2e-retry-receipt.test.sh, and other affected argv/backend/receipt tests; test/e2e-browser/helpers/e2e-cloud-lane-banner.test.ts. Change fake executable dispatch to pnpm exec while retaining argument, retry, and exit-status checks. Preserve cloud-run-dockerfile's actual image build, runnable Cargo check, auth smoke, and both shard executions; preserve cloud-run-config's Playwright listing and sharding behavior. Redundant file-existence assertions are not substitutes for those executable checks.
7. Perf and generated-contract tests: keep actual audit trust/gate and protocol behavior coverage. Historical receipt display strings need no data migration; new command descriptions should reflect the runner actually used.
8. Runtime-boundary analyzer: test/unit/architecture/rust-only-server-runtime.test.ts uses npm build composition as synthetic input to analyzeRuntimeBoundary. Retain legacy npm fixtures and add pnpm variants that actually run the analyzer; scripts/retirement/runtime-boundary.ts currently checks build task names independently of the manager. Do not replace this behavioral analyzer coverage with an assertion that package.json contains one exact pnpm script string.

### 9.3 Tests that only assert text

The repository explicitly rejects tests that only match prose, prompts, docs, or configuration text. Do not update such a test merely to replace npm with pnpm. Remove the affected textual assertion (or an entirely textual test) and keep or add the behavior coverage it was intended to provide.

Candidates identified during investigation include the entirely grep-based scripts/test/cloud-vitest-entrypoint.test.sh; static sections of cloud-vitest-integration.test.sh and cloud-build.test.sh; help-text assertions in cloud-run-wrapper.test.sh, cloud-vitest-wrapper.test.sh, e2e-harness-timeout-env.test.sh, and cloud-gcp-identity.test.sh; source-text checks in test/unit/tooling/testing/test-selection.test.ts; and static Dockerfile/workflow assertions in test/unit/tooling/distribution-runtime.test.ts. Inspect each section during implementation and remove only the non-behavioral parts affected by the migration. Do not delete their executable dispatch tests or undertake an unrelated test-suite cleanup.

Generator tests should protect actual generated protocol behavior and schema validity, not just the spelling of a regeneration instruction. Preserve semantic protocol coverage when changing generated descriptions.

### 9.4 Validation commands and backend rules

Representative commands after migration, from the migration worktree:

~~~bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:vitest run test/unit/tooling/testing/coordinator-upstream.test.ts --config config/vitest/vitest.config.ts
pnpm run test:status
FRESHELL_TEST_SUMMARY='Verify pnpm migration' pnpm run verify
pnpm run test:e2e mcp-bridge-rust.spec.ts mcp-qa-smoke-rust.spec.ts server-build-mismatch-rust.spec.ts
pnpm run verify:electron-artifact
pnpm run test:electron:runtime
scripts/sandbox-selftest.sh
~~~

The browser command is a concrete starting selection, not the full affected-spec inventory: extend it from the changed call sites and record actual executed tests. Add the focused tests above as their implementation changes land, then run the broad suite once the branch is coherent. Use the repository-owned test entrypoints, not raw uncoordinated Vitest commands. Native artifact commands run on their respective builders.

At planning time FRESHELL_VITEST_BACKEND and FRESHELL_E2E_BACKEND were both cloud. Respect the execution environment's configured choice; do not silently switch to local after a cloud failure. If unset, follow AGENTS.md's backend-selection procedure. Confirm affected browser specs are actually executed on the chosen backend, not excluded by CLOUD_SKIP_SPECS or a zero-match filter. Electron's local/native lane remains separate.

## 10. Implementation sequence and review checkpoints

| Step | Work and exit condition | Dependency |
|---|---|---|
| 1 | Fetch current main, inspect intervening changes, run the required clean base gate, create a dedicated worktree, and record Node/package-manager/OS baselines. Preserve the newer pre-push environment fix. | None |
| 2 | Prove the selected pnpm version, workspace import, isolated install, .cjs/native/Windows command behavior, filtered sidecar repair, and both normal deploy outputs. Resolve any failed design assumption before bulk conversion. | Step 1 |
| 3 | Add explicit dependencies and packaging manifest/config; generate reviewed workspace/demo locks; establish build-script policy and fresh-install behavior. | Step 2 |
| 4 | Implement the shared command helper, convert script composition and lifecycle/preparation, adapt coordinator/harness calls, and keep old-worktree/base-gate compatibility. Pass focused behavior tests. | Step 3 |
| 5 | Replace npm-specific runtime dependency traversal with pnpm exports, preserve resource layout, extend verifier/receipts, and pass checkout-free runtime tests plus native Windows packaging proof. | Steps 2-4 |
| 6 | Convert CI/cloud/sandbox/example Docker paths, caches, filters, and fingerprints. Prove actual image/runtime and backend behavior. | Steps 3-5 |
| 7 | Update every active documentation/help/generator surface in section 8, including source-upgrade and first-pnpm-release paths. Review retained npm references by category. | Stable commands and packaging contract |
| 8 | Run the full branch validation matrix, inspect artifacts, measure ready-to-run install cost, and review the complete diff independently. Remove superseded authoritative npm locks and finish with a clean, committed worktree. | Steps 3-7 |
| 9 | Push the feature branch. After explicit PR-creation/landing approval, open the PR, wait for required checks, merge, fast-forward local main, and follow the separate adoption runbook. | Step 8 and required approval |

Use focused commits for package metadata/lock conversion, command and test infrastructure, runtime packaging, CI/container support, and documentation. The branch may use intermediate commits during development, but the mergeable result must be coherent; do not land a half-migrated main with competing lock authorities.

### 10.1 Execution checklist

These tasks reference the file inventories and behavioral cases above. The early proof tasks deliberately precede final implementation code: the plan must not assume an untested deploy or Windows-launch design has already succeeded.

- [ ] Record a green current-main base gate and create the implementation worktree without modifying another checkout's installed dependencies.
- [ ] Record the existing five npm lock inventories, Node versions, and current cold/warm ready-to-run install measurements.
- [ ] Create the workspace and private MCP packaging manifest in the proof worktree; import locks and demonstrate that root and sidecar retain their distinct peer versions.
- [ ] Demonstrate both normal deploy exports, then execute the SDK/model-catalog and MCP entrypoints with the checkout/store unavailable. Record the final resource layout and link/materialization decision.
- [ ] Demonstrate the selected pnpm entrypoint on native Windows and Linux, including a directory with spaces, a .cjs entrypoint, and an inherited npm runner.
- [ ] Add failing command-forwarding and manager-selection tests using real child processes. Observe the wrong separator/runner failure, implement the common helper, rerun, and remove duplicated launcher logic.
- [ ] Add failing sidecar readiness/repair tests for missing packages and stale fingerprints. Implement frozen preparation, prove it preserves root tools and auth behavior, and refactor the npm-specific parser away.
- [ ] Add failing packaging tests for missing transitive/peer/native dependencies and broken exported links. Implement deploy-based staging, run checkout-free acceptance, and remove the old npm closure reconstruction.
- [ ] Add failing old/new-worktree hook and base-gate tests; implement target-checkout manager dispatch and preserve PR #809's Git environment cleanup.
- [ ] Convert cloud/sandbox commands and inputs; exercise argument dispatch, failed-install state, cache invalidation, ownership, and actual image builds before removing superseded checks.
- [ ] Import and build each independent demo inside and outside the parent checkout using its own lock and policy.
- [ ] Update the active documentation, user-visible instructions, script diagnostics, and generator sources listed in section 8; exercise the documented setup/update recipes.
- [ ] Remove the five superseded npm locks, verify frozen-install stability, and review every package-version difference against the captured inventory.
- [ ] Run the complete section 9 matrix, record native artifacts and executed browser specs, and compare installation measurements for the same ready-to-run workload.
- [ ] Review the full change independently, commit focused changes, and push the clean feature branch. Request explicit permission before creating or landing its PR; keep production adoption separately authorized.

Once the package and command contracts are settled, documentation, cloud/sandbox adaptation, and packaging tests can proceed in parallel with explicit file ownership. Do not have multiple agents mutate the shared lockfile or install into the same worktree concurrently.

Indicative effort: roughly 6-10 focused engineering days for implementation, review, and cross-platform proof. The highest uncertainty is runtime export/materialization and native Windows behavior; allow another 2-4 days if those require redesign. This is an estimate, not a deadline. Cloud queue/build time and access to native runners affect elapsed time. A manifest-only conversion would be much smaller but would leave confirmed runtime and tooling breakage unresolved.

## 11. Adoption, release, and rollback runbook requirements

### 11.1 Source and developer checkouts

1. Keep the pre-migration npm checkout/worktree available while validating the pnpm branch. Do not replace another agent's node_modules or remove a shared package store.
2. Bootstrap the exact pnpm version separately on Linux/WSL and native Windows. Fresh pnpm worktrees install their own dependencies from the workspace lock; existing npm worktrees continue using their original manager.
3. For a deliberate conversion of an existing checkout, first establish that no running process or agent depends on its dependency tree. Preserve the old generated dependency directories recoverably before installing the new tree. Do not publish a generic destructive cleanup command that can sweep other worktrees.
4. Run the frozen workspace install, preparation checks, and relevant verification. Keep .env, auth tokens, session files, desktop profiles, and user configuration intact.
5. Do not migrate the live self-hosted main checkout's dependency tree while its sidecars/MCP clients may still load from it. Use the validated worktree for builds and schedule any live-checkout transition as an explicit maintenance operation. Pnpm adoption alone does not authorize a production deployment or restart.
6. The direct systemd service needs the prepared sidecar and a usable standalone Node path before startup. It should not acquire a dependency on pnpm being present in the service's minimal PATH.

### 11.2 First release and desktop rollout

1. Produce validation artifacts on the configured native platforms with publishing disabled, then exercise installation/upgrade on isolated test profiles or machines.
2. Verify existing desktop config, connection target/token, provision state, and sessions survive the normal installer upgrade. Do not change persisted formats for this migration.
3. When the release is authorized, publish the tested artifacts and update the README's stable clone tag and pnpm quick start together. Keep an explicit upgrade path for npm-based source installs that lack pnpm.
   The release checkpoint must align the root package.json version, source lock/importer metadata where applicable, release tag, README clone tag, docs/index.html's displayed version, final staged MCP release metadata, and the release skill's version/tag preparation flow. Pnpm lockfiles are not npm lock-v3 metadata; do not invent root name/version fields solely to imitate the removed lock.
4. Release validation must run from the release commit/tag with its committed lockfile. A green development checkout with stale node_modules is not sufficient.
5. Preserve the existing explicit APPROVED requirement for restarting the live Rust server. Client-only deployment also remains a separately requested production operation, even though it does not require a server restart.

### 11.3 Rollback

1. Roll back source changes through the normal reviewed branch/PR process, or build from the preserved pre-migration tag in a separate worktree. Do not reset or discard another agent's work.
2. Restore the matching manifest/lock/config set as a unit. An npm version of the project uses its npm locks and npm ci; a pnpm version uses its pnpm locks and the pinned frozen install. Do not mix managers in one installed tree.
3. Recreate only the explicitly selected, inactive checkout's generated dependency directories. Keep other worktrees, shared caches, runtime data, and credentials untouched.
4. Desktop rollback installs the previous known-good artifact using the existing distribution procedure and verifies the preserved profile/config. Do not assume an automatic updater permits downgrades.
5. Production rollback follows the launch runbook and requires the same deployment/restart authorization as a forward change. No data migration should need reversing.

## 12. Completion criteria and remaining proof obligations

The migration is complete only when:

1. The exact package-manager version, package boundaries, build-script policy, and four authoritative lockfiles are documented and reproducible from clean installs.
2. Every supported first-party install/build/test/launch/release path uses the intended manager, while old npm worktrees and third-party npm commands still work where explicitly supported.
3. No runtime copier depends on npm lockfile paths. Both exported runtimes and final Electron artifacts run without the source checkout, pnpm store, developer node_modules, or pnpm executable.
4. The selected native platform builds, coordinated suites, affected browser specs, sandbox tests, and cold/warm image paths have actual passing evidence.
5. New setup instructions work for both fresh users and users upgrading from an npm release; the stable clone tag matches its documented manager.
6. No active instruction still accidentally depends on npm/npx, and remaining occurrences have an intentional historical, generic, bootstrap, compatibility, or third-party purpose.
7. The feature worktree is clean and committed, all changes remain within this migration, and no live service was restarted or deployed without its required authorization.

The implementation must still prove workspace lock import fidelity, normal deploy behavior with generated MCP files, safe filtered sidecar repair, Windows shim/Node selection, native optional dependencies, and final artifact link behavior. These are explicit engineering checkpoints, not claims established by this planning exercise.

Measure installation benefits against the same ready-to-run workload: today's root npm install plus sidecar preparation versus the new workspace install, using cold and warm stores and a second worktree. Record wall time, disk usage, image cache behavior, and any increased artifact size. Do not promise a specific speedup before measuring, and do not attribute unchanged Rust compilation time to the package manager.
