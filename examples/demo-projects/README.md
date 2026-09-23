# Demo Projects

Pre-built interactive demo apps. Each is a standalone Vite project that
builds to static HTML/JS/CSS. They were originally authored as freshell
*client extensions*; the Rust server has retired client-extension panes, so
build or dev-serve each demo yourself and open the result in a browser — in
Freshell, a browser pane at the local `http://localhost:<port>/...` URL
renders the demo through the same-origin proxy.

## Prerequisites

- **pnpm 10.34.5, exactly.** Each demo pins it in its `packageManager` field.
  npm is only the one-time bootstrap:
  `npm install --global pnpm@10.34.5`.
- **Node ≥ 22.12** (or ≥ 20.19) — the Vite 7 toolchain used by `synth` and
  `viz-b`; the repo root itself needs only Node 22.5+, so the demos are the
  stricter floor.

## Independent projects and the workspace boundary

Each demo is an **independent pnpm project**: its own `pnpm-lock.yaml` plus a
demo-local `pnpm-workspace.yaml` declaring `packages: ['.']`. That local
workspace file IS the boundary — pnpm treats the demo directory as its own
workspace root, so running pnpm from inside a demo directory stays local and
never reaches the parent Freshell workspace. A root
`pnpm install --frozen-lockfile` never installs demo dependencies. Always
run the commands below from inside the demo directory.

## Quick Start

Pick a project, install, build, and preview it:

```bash
cd examples/demo-projects/synth
pnpm install --frozen-lockfile   # installs exactly as locked, demo-local
pnpm run build                   # → dist/
pnpm run preview                 # serves dist/ on a local port
```

Open the printed local URL in a browser. Repeat for any other demo project —
each one is independent.

## Projects

### Synth

A Web Audio synthesizer with a two-octave keyboard (playable via mouse or
computer keyboard), four oscillator waveforms, ADSR envelope with live
visualization, reverb/delay effects with rotary knobs, a real-time waveform
analyser, and a 16-step sequencer with adjustable BPM.

- **Stack:** Vanilla JS, CSS, Vite

```bash
cd examples/demo-projects/synth
pnpm install --frozen-lockfile && pnpm run build
```

### Exoplanet Nightsky

An interactive sky map plotting thousands of confirmed exoplanets on a
Hammer-Aitoff projection. Color by equilibrium temperature or discovery
method, filter by method, scrub through discovery year with playback
animation, and hover for per-planet detail tooltips.

- **Stack:** React 18, TypeScript, Canvas 2D, Vite
- **Data:** `public/exoplanets.csv` (bundled)

```bash
cd examples/demo-projects/dataviz/viz-a
pnpm install --frozen-lockfile && pnpm run build
```

### Exoplanet Clusters

A force-directed bubble chart grouping exoplanets into clusters. Switch
between five grouping modes (physical size, temperature zone, discovery
method, discovery decade, system multiplicity) and watch the bubbles
reorganize with smooth d3-force animations. Hover for tooltips, click for a
detail panel with size comparison to Earth.

- **Stack:** React 19, TypeScript, d3-force, Canvas 2D, Vite
- **Data:** `public/data/exoplanets-clean.csv` (bundled)

```bash
cd examples/demo-projects/dataviz/viz-b
pnpm install --frozen-lockfile && pnpm run build
```

## How They Relate to Freshell Extensions

Each project still carries a `freshell.json` manifest with
`category: "client"` and `client.entry` pointing at `dist/index.html`. That
manifest documents the retired client-extension format — the Rust server
does not render client-extension panes, and the pnpm migration does not
restore them. The supported extension category is `cli` (see
[`examples/extensions/`](../extensions/)); for web content like these demos,
host the built output yourself (`pnpm run preview` or any static file
server) and open it in a browser pane.

All Vite configs use `base: './'` so that built assets use relative paths,
which keeps each `dist/` relocatable and hostable from any static path.

## Agent Workflow

If you're an AI agent building all the demos:

```bash
# From the freshell repo root — each install stays inside its own demo.
for project in examples/demo-projects/synth examples/demo-projects/dataviz/viz-a examples/demo-projects/dataviz/viz-b; do
  (cd "$project" && pnpm install --frozen-lockfile && pnpm run build)
done
```

## Development

To work on a demo with hot reload, run the Vite dev server from inside the
demo directory:

```bash
cd examples/demo-projects/synth
pnpm install --frozen-lockfile
pnpm run dev          # opens on the port configured in vite.config
```

When you're done, rebuild (`pnpm run build`) so the built output picks up
your changes. Use `pnpm exec <bin>` for any one-off tool invocation inside a
demo (for example, `pnpm exec vite build`).
