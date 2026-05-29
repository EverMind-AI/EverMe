#!/bin/bash
#
# EverMe plugin installer for Claude Code.
#
# What it does:
#   1. Verifies `claude` CLI exists and Node 18+.
#   2. Prompts for EVERME_API_KEY (an emk_*) if not already set, and
#      writes it to ~/.claude/everme.env (mode 0600). The plugin's
#      lib/config.js loads this file at hook startup.
#   3. Tells `claude` to install this plugin from the local directory.
#
# What it does NOT do:
#   - Edit the user's shell profile. Earlier revisions appended an
#     `export EVERME_API_KEY=…` line to ~/.zshrc / ~/.bashrc — that
#     stored a secret in a typically world-readable file (mode 0644)
#     and accumulated a duplicate line on every re-install. We now
#     mirror the path `evercli plugin install claude-code` uses: a
#     0600 file at ~/.claude/everme.env, scoped to the plugin.
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HOME/.claude/everme.env"

echo
echo -e "${CYAN}EverMe — Claude Code plugin installer${NC}"
echo

if ! command -v claude >/dev/null 2>&1; then
    echo -e "${RED}claude CLI not found.${NC}"
    echo "Install Claude Code first: https://claude.ai/code"
    exit 1
fi
echo -e "${GREEN}✓${NC} Claude Code CLI detected"

if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}node not found.${NC} Plugin hooks need Node 18+."
    exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${RED}node $NODE_MAJOR is too old.${NC} Need Node 18+."
    exit 1
fi
echo -e "${GREEN}✓${NC} Node $(node --version)"

# Persist credentials to ~/.claude/everme.env (mode 0600). atomic_write
# mirrors evercli's writeFileAtomic — body goes via .tmp then rename so
# the plugin never reads a half-written file.
atomic_write_env() {
    local body=$1
    mkdir -p "$(dirname "$ENV_FILE")"
    chmod 0700 "$(dirname "$ENV_FILE")" 2>/dev/null || true
    local tmp="${ENV_FILE}.tmp"
    rm -f "$tmp"
    # umask 0077 → 0600 file; -e/-c work with O_EXCL semantics on noclobber.
    (umask 0077 && printf '%s' "$body" > "$tmp")
    mv -f "$tmp" "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
}

# Configure auth.
if [ -z "${EVERME_API_KEY:-}" ] && [ -z "${EVERME_AGENT_TOKEN:-}" ] && [ ! -f "$ENV_FILE" ]; then
    echo
    echo -e "${YELLOW}EverMe credentials not found.${NC}"
    echo -n "Paste your account API key (starts with emk_, from the EverMe Web UI; input is hidden): "
    # -s suppresses echo so the token never lands in shell scrollback.
    read -rs EMK_INPUT
    echo
    if [ -z "$EMK_INPUT" ]; then
        echo -e "${RED}No key provided. Aborting.${NC}"
        exit 1
    fi

    BODY="# Managed by ${PLUGIN_DIR##*/}/install.sh — do not edit by hand.
# Re-run install.sh to refresh, or remove this file to disable the plugin.
"
    if [ -n "${EVERME_API_BASE:-}" ]; then
        BODY="${BODY}EVERME_API_BASE=${EVERME_API_BASE}
"
    fi
    BODY="${BODY}EVERME_API_KEY=${EMK_INPUT}
"
    atomic_write_env "$BODY"
    unset EMK_INPUT BODY
    echo -e "${GREEN}✓${NC} Wrote credentials to $ENV_FILE (mode 0600)"
elif [ -f "$ENV_FILE" ]; then
    echo -e "${GREEN}✓${NC} Existing $ENV_FILE detected — leaving credentials as-is"
fi

# Optional API base override (default https://api.everme.evermind.ai).
if [ -n "${EVERME_API_BASE:-}" ]; then
    echo -e "${GREEN}✓${NC} Using EVERME_API_BASE=$EVERME_API_BASE"
fi

# Install via Claude Code's plugin system.
echo
echo -e "${CYAN}Installing plugin via 'claude plugin install'…${NC}"
claude plugin install "$PLUGIN_DIR"

echo
echo -e "${GREEN}✓ EverMe plugin installed.${NC}"
echo
echo "Next steps:"
echo "  1. Start Claude Code:   claude"
echo "  2. Try '/everme-help' or '/recall <something>' to verify."
echo "  3. Set EVERME_DEBUG=1 in your environment to see hook traces on stderr."
