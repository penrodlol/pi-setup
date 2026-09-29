#!/usr/bin/env bash
#
# install.sh — set up pi + this config and everything it depends on.
#
#   git clone git@github.com:penrodlol/pi-setup.git ~/.pi && ~/.pi/install.sh
#   # or
#   curl -fsSL https://raw.githubusercontent.com/penrodlol/pi-setup/main/install.sh | bash
#
# Installs (skipping anything already present):
#   - Node.js >= 22.19 (via nvm)           pi runtime
#   - pi (@earendil-works/pi-coding-agent)
#   - pi packages from agent/settings.json
#   - qmd (@tobilu/qmd)                    pi-memory search
#   - uv + headroom-ai                     noheadroom compression proxy
#   - JetBrainsMono Nerd Font              footer icons
#   - ffmpeg + yt-dlp (optional)           pi-web-access video features
#
# Flags:
#   --no-font       skip the Nerd Font
#   --no-optional   skip ffmpeg / yt-dlp
#
# Safe to re-run.

set -euo pipefail

REPO_URL="${PI_SETUP_REPO:-https://github.com/penrodlol/pi-setup.git}"
PI_DIR="$HOME/.pi"
NODE_MIN="22.19.0"
NODE_VERSION="24"
NVM_VERSION="v0.40.3"
HEADROOM_SPEC="headroom-ai[all]"
HEADROOM_PYTHON="3.13"

WITH_FONT=1
WITH_OPTIONAL=1
for arg in "$@"; do
	case "$arg" in
		--no-font) WITH_FONT=0 ;;
		--no-optional) WITH_OPTIONAL=0 ;;
		-h | --help) sed -n '3,22p' "${BASH_SOURCE[0]:-}" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "Unknown option: $arg" >&2; exit 1 ;;
	esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then B=$'\033[1m' D=$'\033[2m' G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' N=$'\033[0m'; else B="" D="" G="" Y="" R="" N=""; fi
step() { printf '\n%s==>%s %s%s%s\n' "$B" "$N" "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
info() { printf '  %s%s%s\n' "$D" "$*" "$N"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

# Run a command silently; show its output only if it fails.
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
quiet() {
	if "$@" </dev/null >"$LOG" 2>&1; then return 0; fi
	local rc=$?
	cat "$LOG" >&2
	return $rc
}

ORIG_PATH="$PATH"

# version_ge 22.19.0 22.1.0 → true
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

OS="$(uname -s)"
case "$OS" in
	Linux | Darwin) ;;
	*) die "Unsupported OS: $OS (Linux and macOS only)" ;;
esac

SUDO=""
if [ "$(id -u)" -ne 0 ] && has sudo; then SUDO="sudo"; fi

# Install a system package with whatever package manager is available.
pkg_install() {
	if [ "$OS" = Darwin ]; then
		has brew || { warn "Homebrew not found; install $* manually"; return 1; }
		brew install "$@"
	elif has apt-get; then
		$SUDO apt-get update -qq && $SUDO apt-get install -y -qq "$@"
	elif has dnf; then
		$SUDO dnf install -y -q "$@"
	elif has pacman; then
		$SUDO pacman -S --needed --noconfirm "$@"
	elif has zypper; then
		$SUDO zypper install -y "$@"
	else
		warn "No supported package manager; install $* manually"
		return 1
	fi
}

# ---------------------------------------------------------------------------
# 1. Base tools
# ---------------------------------------------------------------------------

step "Base tools"
missing=()
for t in git curl tar; do has "$t" || missing+=("$t"); done
if [ "${#missing[@]}" -gt 0 ]; then
	info "installing ${missing[*]}"
	pkg_install "${missing[@]}" || die "Need: ${missing[*]}"
fi
ok "git, curl, tar"

# ---------------------------------------------------------------------------
# 2. This repo at ~/.pi
# ---------------------------------------------------------------------------

step "Config repo ($PI_DIR)"
origin="$(git -C "$PI_DIR" remote get-url origin 2>/dev/null || true)"
if [ -d "$PI_DIR/.git" ] && { [ "$origin" = "$REPO_URL" ] || [[ "$origin" == *pi-setup* ]]; }; then
	ok "already cloned"
else
	if [ -e "$PI_DIR" ]; then
		backup="$PI_DIR.backup-$(date +%Y%m%d-%H%M%S)"
		warn "existing $PI_DIR moved to $backup"
		mv "$PI_DIR" "$backup"
	fi
	git clone --quiet "$REPO_URL" "$PI_DIR"
	# Keep logins from the previous setup.
	if [ -n "${backup:-}" ] && [ -f "$backup/agent/auth.json" ]; then
		cp "$backup/agent/auth.json" "$PI_DIR/agent/auth.json"
		info "restored agent/auth.json from backup"
	fi
	ok "cloned $REPO_URL"
fi

# ---------------------------------------------------------------------------
# 3. Node.js
# ---------------------------------------------------------------------------

step "Node.js (>= $NODE_MIN)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# nvm is not compatible with `set -eu`.
nvm_load() { set +eu; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; set -eu; }
nvm_run() { set +eu; quiet nvm "$@"; local rc=$?; set -eu; return $rc; }
nvm_load

node_ok() {
	has node || return 1
	version_ge "$(node -v | sed 's/^v//')" "$NODE_MIN" || return 1
	# Global installs must work without sudo.
	[ -w "$(npm prefix -g 2>/dev/null)" ]
}

if node_ok; then
	ok "node $(node -v) ($(command -v node))"
else
	if ! has nvm; then
		info "installing nvm $NVM_VERSION"
		# The installer also adds nvm to ~/.bashrc / ~/.zshrc.
		quiet bash -c "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh | bash"
		nvm_load
		has nvm || die "nvm install failed"
	fi
	info "installing node $NODE_VERSION"
	nvm_run install "$NODE_VERSION"
	nvm_run alias default "$NODE_VERSION"
	nvm_run use default
	node_ok || die "node setup failed"
	ok "node $(node -v) via nvm"
fi

# ---------------------------------------------------------------------------
# 4. npm globals: pi + qmd
# ---------------------------------------------------------------------------

step "pi + qmd"
npm_global() {
	local pkg="$1" bin="$2"
	if has "$bin"; then
		ok "$pkg ($("$bin" --version 2>/dev/null | head -n1))"
	else
		info "npm install -g $pkg"
		quiet npm install -g --no-fund --no-audit "$pkg"
		ok "$pkg"
	fi
}
npm_global @earendil-works/pi-coding-agent pi
npm_global @tobilu/qmd qmd

# ---------------------------------------------------------------------------
# 5. pi packages (agent/settings.json -> "packages")
# ---------------------------------------------------------------------------

step "pi packages"
(cd "$PI_DIR" && quiet pi update --extensions)
pi list </dev/null 2>/dev/null | sed 's/^/  /' || true
ok "packages installed"

# ---------------------------------------------------------------------------
# 6. Headroom (for @raquezha/noheadroom; the extension starts the proxy itself)
# ---------------------------------------------------------------------------

step "Headroom"
export PATH="$HOME/.local/bin:$PATH"
if ! has uv; then
	info "installing uv"
	quiet sh -c "curl -LsSf https://astral.sh/uv/install.sh | sh"
	export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
	has uv || die "uv install failed"
fi
ok "uv $(uv --version | awk '{print $2}')"

if has headroom; then
	ok "headroom ($(command -v headroom))"
else
	info "uv tool install $HEADROOM_SPEC (this can take a few minutes)"
	quiet uv tool install --python "$HEADROOM_PYTHON" "$HEADROOM_SPEC"
	ok "headroom"
fi

# ---------------------------------------------------------------------------
# 7. Nerd Font (footer icons, v3.5.0+)
# ---------------------------------------------------------------------------

if [ "$WITH_FONT" = 1 ]; then
	step "Nerd Font"
	if [ "$OS" = Darwin ]; then
		if ls "$HOME/Library/Fonts" /Library/Fonts 2>/dev/null | grep -i "NerdFont" >/dev/null; then
			ok "Nerd Font already installed"
		elif has brew; then
			brew install --cask font-jetbrains-mono-nerd-font
			ok "JetBrainsMono Nerd Font"
		else
			warn "Homebrew not found; install a Nerd Font from https://www.nerdfonts.com/"
		fi
	else
		if has fc-list && fc-list 2>/dev/null | grep -i "Nerd Font" >/dev/null; then
			ok "Nerd Font already installed"
		else
			font_dir="$HOME/.local/share/fonts/JetBrainsMonoNF"
			mkdir -p "$font_dir"
			info "downloading JetBrainsMono Nerd Font"
			curl -fsSL https://github.com/ryanoasis/nerd-fonts/releases/latest/download/JetBrainsMono.tar.xz |
				tar -xJ -C "$font_dir"
			has fc-cache && fc-cache -f "$font_dir" >/dev/null
			ok "JetBrainsMono Nerd Font → $font_dir"
		fi
	fi
	info "set your terminal font to a Nerd Font (e.g. \"JetBrainsMono Nerd Font\")"
fi

# ---------------------------------------------------------------------------
# 8. Optional: ffmpeg + yt-dlp (pi-web-access video frames / YouTube)
# ---------------------------------------------------------------------------

if [ "$WITH_OPTIONAL" = 1 ]; then
	step "Optional tools"
	if has ffmpeg; then ok "ffmpeg"; else pkg_install ffmpeg && ok "ffmpeg" || warn "ffmpeg skipped"; fi
	if has yt-dlp; then ok "yt-dlp"; else quiet uv tool install yt-dlp && ok "yt-dlp" || warn "yt-dlp skipped"; fi
fi

# ---------------------------------------------------------------------------

# ~/.local/bin holds headroom / uv / yt-dlp; make sure new shells can find it.
case ":$ORIG_PATH:" in
	*":$HOME/.local/bin:"*) ;;
	*)
		for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
			[ -f "$rc" ] || continue
			grep '\.local/bin' "$rc" >/dev/null && continue
			printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$rc"
			info "added ~/.local/bin to PATH in $rc"
		done
		;;
esac

step "Done"
cat <<EOF
  Open a new shell (so PATH picks up nvm and ~/.local/bin), then:

    ${B}pi${N}          start pi
    ${B}/login${N}      sign in to a provider (default: GitHub Copilot)

EOF
