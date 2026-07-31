#!/bin/sh
# Dockposer Agent — Installer
#
# Nutzung (Werte anpassen):
#   curl -fsSL https://git.example.com/OWNER/dockposer/raw/branch/main/agent/install.sh | sh -s -- \
#     --base https://git.example.com/OWNER/dockposer/raw/branch/main \
#     --token <TOKEN-aus-der-UI> \
#     --stacks /home/user/stacks \
#     --user user
#
# Ohne Flags fragt das Skript interaktiv nach (funktioniert auch bei curl|sh).
# Erneutes Ausführen aktualisiert das Binary und startet den Dienst neu;
# die bestehende Config bleibt erhalten, außer --token wird erneut übergeben.
set -eu

BASE="${DOCKPOSER_BASE:-}"
TOKEN="${DOCKPOSER_TOKEN:-}"
STACKS="${DOCKPOSER_STACKS:-}"
LISTEN="${DOCKPOSER_LISTEN:-127.0.0.1:8720}"
RUN_USER="${DOCKPOSER_USER:-}"
BIN_PATH="/usr/local/bin/dockposer-agent"
ENV_FILE="/etc/dockposer-agent.env"
UNIT_FILE="/etc/systemd/system/dockposer-agent.service"

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNUNG: %s\n' "$*" >&2; }
die()  { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }

# ── Argumente ──
while [ $# -gt 0 ]; do
	case "$1" in
		--base)   BASE="$2"; shift 2 ;;
		--token)  TOKEN="$2"; shift 2 ;;
		--stacks) STACKS="$2"; shift 2 ;;
		--listen) LISTEN="$2"; shift 2 ;;
		--user)   RUN_USER="$2"; shift 2 ;;
		*) die "Unbekanntes Argument: $1" ;;
	esac
done

# ── Vorbedingungen ──
[ "$(id -u)" = "0" ] || die "Bitte als root ausführen (sudo)."
command -v curl >/dev/null || die "curl wird benötigt."
command -v docker >/dev/null || die "Docker ist nicht installiert."
docker compose version >/dev/null 2>&1 || die "Docker-Compose-Plugin fehlt (docker compose version schlägt fehl)."
arch="$(uname -m)"
[ "$arch" = "x86_64" ] || die "Nur linux/amd64-Binary verfügbar (dein System: $arch). Bitte selbst bauen: go build im agent/-Ordner."

# ── Interaktive Nachfragen (aus /dev/tty, damit curl|sh funktioniert) ──
ask() {
	prompt="$1"; default="${2:-}"
	if [ -n "$default" ]; then printf '%s [%s]: ' "$prompt" "$default" >&2
	else printf '%s: ' "$prompt" >&2; fi
	if read -r answer 2>/dev/null < /dev/tty; then :; else answer=""; fi
	[ -n "$answer" ] && printf '%s' "$answer" || printf '%s' "$default"
}

[ -n "$BASE" ] || BASE="$(ask 'Raw-URL-Basis des Repos (…/raw/branch/main)')"
[ -n "$BASE" ] || die "Ohne --base geht es nicht."
BASE="${BASE%/}"

existing_token=""
if [ -f "$ENV_FILE" ]; then
	existing_token="$(grep '^DOCKPOSER_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
fi
if [ -z "$TOKEN" ]; then
	if [ -n "$existing_token" ]; then
		TOKEN="$existing_token"
		say "Bestehendes Token aus $ENV_FILE übernommen."
	else
		TOKEN="$(ask 'Agent-Token (aus der Dockposer-Server-Registrierung)')"
	fi
fi
[ -n "$TOKEN" ] || die "Ohne Token startet der Agent nicht."

if [ -z "$RUN_USER" ]; then
	suggested="${SUDO_USER:-}"
	RUN_USER="$(ask 'Service-User (braucht Docker-Gruppenrechte)' "$suggested")"
fi
[ -n "$RUN_USER" ] || die "Service-User fehlt."
id "$RUN_USER" >/dev/null 2>&1 || die "User $RUN_USER existiert nicht."

if [ -z "$STACKS" ]; then
	home_dir="$(getent passwd "$RUN_USER" | cut -d: -f6)"
	STACKS="$(ask 'Stacks-Pfad' "${home_dir}/stacks")"
fi
mkdir -p "$STACKS"
chown "$RUN_USER" "$STACKS" 2>/dev/null || true

if ! id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx docker; then
	warn "$RUN_USER ist nicht in der docker-Gruppe."
	add="$(ask 'Jetzt hinzufügen? (j/n)' 'j')"
	if [ "$add" = "j" ] || [ "$add" = "J" ]; then
		if usermod -aG docker "$RUN_USER" 2>/dev/null; then
			say "→ $RUN_USER zur docker-Gruppe hinzugefügt."
		else
			warn "usermod fehlgeschlagen — bitte manuell prüfen."
		fi
	fi
fi

# ── Binary ──
say "Lade Agent-Binary …"
tmp_bin="$(mktemp)"
curl -fsSL "$BASE/agent/dockposer-agent-linux-amd64" -o "$tmp_bin" || die "Download fehlgeschlagen: $BASE/agent/dockposer-agent-linux-amd64"
install -m 0755 "$tmp_bin" "$BIN_PATH"
rm -f "$tmp_bin"
command -v restorecon >/dev/null && restorecon "$BIN_PATH" 2>/dev/null || true
say "→ $BIN_PATH installiert."

# ── Config ──
umask 077
cat > "$ENV_FILE" << ENVEOF
DOCKPOSER_TOKEN=$TOKEN
DOCKPOSER_STACKS=$STACKS
DOCKPOSER_LISTEN=$LISTEN
ENVEOF
chmod 600 "$ENV_FILE"
say "→ $ENV_FILE geschrieben (chmod 600)."

# ── systemd ──
cat > "$UNIT_FILE" << UNITEOF
[Unit]
Description=Dockposer Agent
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=$RUN_USER
EnvironmentFile=$ENV_FILE
ExecStart=$BIN_PATH
Restart=on-failure
RestartSec=5

# Härtung
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$STACKS
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITEOF

if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
	systemctl daemon-reload
	systemctl enable --now dockposer-agent
	sleep 1
	if systemctl is-active --quiet dockposer-agent; then
		say "→ Dienst läuft."
	else
		warn "Dienst gestartet, aber nicht aktiv — journalctl -u dockposer-agent prüfen."
	fi
	# Health-Check gegen den lokalen Listen-Port
	if curl -fsS -m 3 -H "Authorization: Bearer $TOKEN" "http://$LISTEN/v1/health" >/dev/null 2>&1; then
		say "→ Health-Check OK."
	else
		warn "Health-Check auf http://$LISTEN noch nicht erreichbar — ggf. ein paar Sekunden warten."
	fi
else
	warn "Kein systemd erkannt — Unit liegt unter $UNIT_FILE, Start manuell: $BIN_PATH (mit ENV aus $ENV_FILE)."
fi

say ""
case "$LISTEN" in
	127.*|localhost*)
		warn "Der Agent lauscht nur auf Loopback ($LISTEN) — von anderen Rechnern NICHT erreichbar."
		warn "Für Zugriff übers (WireGuard-)Netz: erneut ausführen mit  --listen <interface-ip>:8720"
		warn "oder /etc/dockposer-agent.env anpassen und  systemctl restart dockposer-agent"
		say ""
		;;
esac
say "Fertig. Nächste Schritte:"
say "  1. Caddy-Block für HTTPS davor, z. B.:"
say "       agent-$(hostname).example.com {"
say "           reverse_proxy $LISTEN"
say "       }"
say "  2. In der Dockposer-UI: Server registrieren mit der HTTPS-URL"
say "     und exakt diesem Token, dann Testen klicken."
say "  3. Optional: git installieren, falls Git-Tracking genutzt werden soll."
