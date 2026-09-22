#!/usr/bin/env bash
# entrypoint for freshell-sandbox. Runs as root (PID 1) so it can fix
# ownership of named volumes Docker creates fresh at runtime (they default
# to root-owned, which the non-root "sandbox" user can't write to), then
# drops privileges via gosu (a true exec, not su/sudo) before running the
# caller's command. The caller's command never runs as root.
set -euo pipefail

TARGET_UID="$(id -u sandbox)"
TARGET_GID="$(id -g sandbox)"

cd /workspace

# /home/sandbox/.cache is where npm/pnpm postinstall scripts (electron,
# playwright, ...) create their OWN cache subdirectories on demand — it must
# be sandbox-owned itself, not just the ms-playwright volume mounted below,
# or a plain `mkdir` for a sibling dir (e.g. .cache/electron) gets EACCES.
mkdir -p /home/sandbox/.cache
chown "${TARGET_UID}:${TARGET_GID}" /home/sandbox/.cache

# Volumes that may be freshly created (root-owned) on first use of this
# image: the cargo registry/git caches, and the sandbox-owned node_modules
# and cargo target dirs layered over the bind-mounted repo. Cheap to check,
# only chowns (recursively) the first time a given volume is used.
VOLUME_DIRS=(
  "/usr/local/cargo/registry"
  "/usr/local/cargo/git"
  "/workspace/target"
  "/workspace/node_modules"
  "/home/sandbox/.cache/ms-playwright"
)
for dir in "${VOLUME_DIRS[@]}"; do
  mkdir -p "${dir}"
  if [ "$(stat -c %u "${dir}")" != "${TARGET_UID}" ]; then
    chown -R "${TARGET_UID}:${TARGET_GID}" "${dir}"
  fi
done

# --- dependency prep (fingerprinted, dual-manager) ------------------------
# Replaces the one-shot `.sandbox-npm-ci-done` marker: the sandbox serves
# both pnpm-era trees (packageManager pin; plan §7.3) and legacy npm-era
# branches (package-lock.json only), so the manager is selected per tree and
# the install is keyed by a fingerprint over the actual dependency inputs.
# The state file lives inside the install volume (node_modules is a named
# volume under scripts/sandbox-test.sh), so wiping the volume wipes the
# state. The old marker never satisfies this state: an npm-era volume, a
# stale marker, or a manager switch all trigger a fresh install.
if [ -f package.json ]; then
  # Manager selection precedence mirrors scripts/lib/package-manager.ts
  # (detectProjectManager): the packageManager field is authoritative; a
  # missing or unrecognized field falls back to lock presence, npm's
  # package-lock.json first so legacy branches keep their `npm ci` path
  # while both lock styles exist transiently in migrated trees.
  DEPS_PM_FIELD="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync("package.json","utf8")).packageManager||"")}catch{}' 2>/dev/null || true)"
  DEPS_MANAGER=""
  case "${DEPS_PM_FIELD%%@*}" in
    pnpm) DEPS_MANAGER=pnpm ;;
    npm) DEPS_MANAGER=npm ;;
  esac
  if [ -z "${DEPS_MANAGER}" ]; then
    if [ -f package-lock.json ]; then
      DEPS_MANAGER=npm
    elif [ -f pnpm-lock.yaml ]; then
      DEPS_MANAGER=pnpm
    fi
  fi

  if [ -n "${DEPS_MANAGER}" ]; then
    if ! command -v "${DEPS_MANAGER}" >/dev/null 2>&1; then
      echo "[sandbox] ERROR: this tree selects ${DEPS_MANAGER}, which is not installed in the sandbox image" >&2
      exit 1
    fi

    if [ "${DEPS_MANAGER}" = pnpm ]; then
      DEPS_POLICY=(install --frozen-lockfile)
      DEPS_LOCKS=(pnpm-lock.yaml pnpm-workspace.yaml)
    else
      DEPS_POLICY=(ci --no-audit --no-fund)
      DEPS_LOCKS=(package-lock.json)
    fi
    DEPS_MANAGER_VERSION="$(gosu sandbox "${DEPS_MANAGER}" --version 2>/dev/null || true)"

    # Fingerprint over the selected manager's identity, the install policy
    # flags, the root manifest, the selected manager's lock/config files,
    # and the workspace member manifests when present. Absent files are
    # skipped; changing any input forces a reinstall on the next start.
    DEPS_FINGERPRINT="$(
      {
        printf 'manager=%s@%s\n' "${DEPS_MANAGER}" "${DEPS_MANAGER_VERSION}"
        printf 'policy=%s\n' "${DEPS_POLICY[*]}"
        for f in package.json "${DEPS_LOCKS[@]}" \
                 crates/freshell-claude-sidecar/package.json \
                 packages/freshell-mcp-runtime/package.json; do
          if [ -f "$f" ]; then
            sha256sum "$f"
          fi
        done
      } | sha256sum | cut -d' ' -f1
    )"

    DEPS_STATE="node_modules/.sandbox-deps-state"
    DEPS_RECORDED=""
    if [ -f "${DEPS_STATE}" ]; then
      DEPS_RECORDED="$(grep '^fingerprint=' "${DEPS_STATE}" | cut -d= -f2 || true)"
    fi

    if [ -n "${DEPS_RECORDED}" ] && [ "${DEPS_RECORDED}" = "${DEPS_FINGERPRINT}" ]; then
      echo "[sandbox] deps: reusing sandbox-owned node_modules (${DEPS_MANAGER} fingerprint ${DEPS_FINGERPRINT} unchanged)" >&2
    else
      echo "[sandbox] deps: installing via ${DEPS_MANAGER} ${DEPS_POLICY[*]} (fingerprint ${DEPS_FINGERPRINT}, recorded ${DEPS_RECORDED:-none})" >&2
      # Purge the previous contents before installing: the recorded state
      # may be another manager's layout (an npm-created tree is
      # incompatible with pnpm and vice versa), a marker-era leftover, or
      # a half-failed install. `npm ci` reinstalls from scratch anyway;
      # pnpm needs the clean slate. Contents only — node_modules itself is
      # the named-volume mount point and must not be removed.
      if [ -d node_modules ]; then
        find node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      fi
      gosu sandbox "${DEPS_MANAGER}" "${DEPS_POLICY[@]}"
      printf 'manager=%s\nmanager_version=%s\nfingerprint=%s\n' \
        "${DEPS_MANAGER}" "${DEPS_MANAGER_VERSION}" "${DEPS_FINGERPRINT}" \
        | gosu sandbox tee "${DEPS_STATE}" >/dev/null
    fi
  fi
fi

exec gosu sandbox "$@"
