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
# die bestehende Config (Token, Listen-Adresse, Stacks-Pfad, editierbare
# Dateien) bleibt erhalten, sofern der Wert nicht erneut übergeben wird.
#
# Pods (Podman/Quadlet, rootless, ab Podman 6.0):
#   --pods                Pods im Standardpfad ~/.config/containers/systemd
#   --pods-path PFAD      abweichender Quadlet-Pfad
#   --no-docker           reiner Podman-Host: kein Stacks-Ordner, kein Docker
#
# Ohne Netzzugriff auf das Repo (Forge hinter Login/SSO): aus einem lokalen
# Checkout bauen — braucht weder --base noch curl zum Repo:
#   git clone ssh://git@git.example.com/OWNER/dockposer.git   # bzw. git pull
#   sudo sh dockposer/agent/install.sh --src dockposer/agent
set -eu

BASE="${DOCKPOSER_BASE:-}"
TOKEN="${DOCKPOSER_TOKEN:-}"
STACKS="${DOCKPOSER_STACKS:-}"
LISTEN="${DOCKPOSER_LISTEN:-}"
EDITABLE="${DOCKPOSER_EDITABLE_FILES:-}"
RUN_USER="${DOCKPOSER_USER:-}"
PODS=0
PODS_PATH="${DOCKPOSER_PODS:-}"
NO_DOCKER=0
FROM_SOURCE=0
SRC_DIR=""
BIN_PATH="/usr/local/bin/dockposer-agent"
ENV_FILE="/etc/dockposer-agent.env"
UNIT_FILE="/etc/systemd/system/dockposer-agent.service"

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNUNG: %s\n' "$*" >&2; }
die()  { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }
# Login-/SSO-Seiten statt Dateien erkennen (kommen mit Status 200, curl -f hilft nicht)
is_html() { head -c 256 "$1" | grep -qi '<!doctype html\|<html'; }

# ── Argumente ──
while [ $# -gt 0 ]; do
	case "$1" in
		--from-source) FROM_SOURCE=1; shift ;;
		--src)    SRC_DIR="$2"; FROM_SOURCE=1; shift 2 ;;
		--base)   BASE="$2"; shift 2 ;;
		--token)  TOKEN="$2"; shift 2 ;;
		--stacks) STACKS="$2"; shift 2 ;;
		--listen) LISTEN="$2"; shift 2 ;;
		--editable-files) EDITABLE="$2"; shift 2 ;;
		--user)   RUN_USER="$2"; shift 2 ;;
		--pods)   PODS=1; shift ;;
		--pods-path) PODS=1; PODS_PATH="$2"; shift 2 ;;
		--no-docker) NO_DOCKER=1; shift ;;
		*) die "Unbekanntes Argument: $1" ;;
	esac
done

# ── Vorbedingungen ──
[ "$(id -u)" = "0" ] || die "Bitte als root ausführen (sudo)."
[ -n "$SRC_DIR" ] || command -v curl >/dev/null || die "curl wird benötigt."
# Bestehende Config: Pods und reiner Podman-Betrieb bleiben beim Update erhalten
if [ -f "$ENV_FILE" ]; then
	if [ -z "$PODS_PATH" ]; then
		PODS_PATH="$(grep '^DOCKPOSER_PODS=' "$ENV_FILE" | cut -d= -f2- || true)"
	fi
	[ -n "$PODS_PATH" ] && PODS=1
	if [ "$PODS" = "1" ] && ! grep -q '^DOCKPOSER_STACKS=.' "$ENV_FILE"; then
		NO_DOCKER=1
	fi
fi
[ "$NO_DOCKER" = "1" ] && [ "$PODS" != "1" ] && die "--no-docker ohne --pods ergibt einen Agent ohne Aufgabe."

if [ "$NO_DOCKER" != "1" ]; then
	command -v docker >/dev/null || die "Docker ist nicht installiert (für einen reinen Podman-Host: --pods --no-docker)."
	docker compose version >/dev/null 2>&1 || die "Docker-Compose-Plugin fehlt (docker compose version schlägt fehl)."
fi
if [ "$PODS" = "1" ]; then
	command -v podman >/dev/null || die "Podman ist nicht installiert."
	podman_version="$(podman version --format '{{.Client.Version}}' 2>/dev/null || true)"
	case "$podman_version" in
		[6-9].*|[1-9][0-9].*) ;;
		*) die "Pods brauchen Podman 6.0 oder neuer (gefunden: ${podman_version:-unbekannt})." ;;
	esac
	command -v loginctl >/dev/null || die "loginctl fehlt — Pods brauchen systemd."
fi
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

if [ -n "$SRC_DIR" ]; then
	SRC_DIR="${SRC_DIR%/}"
	[ -f "$SRC_DIR/go.mod" ] && [ -f "$SRC_DIR/main.go" ] \
		|| die "$SRC_DIR ist kein Agent-Quellordner (go.mod/main.go fehlen)."
else
	[ -n "$BASE" ] || BASE="$(ask 'Raw-URL-Basis des Repos (…/raw/branch/main)')"
	[ -n "$BASE" ] || die "Ohne --base (oder --src) geht es nicht."
	BASE="${BASE%/}"
fi

existing_token=""
if [ -f "$ENV_FILE" ]; then
	existing_token="$(grep '^DOCKPOSER_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
	if [ -z "$EDITABLE" ]; then
		EDITABLE="$(grep '^DOCKPOSER_EDITABLE_FILES=' "$ENV_FILE" | cut -d= -f2- || true)"
	fi
	# Listen-Adresse und Stacks-Pfad übernehmen. Früher fiel LISTEN bei jedem
	# Update ohne --listen auf 127.0.0.1 zurück — der Agent lief danach, war
	# vom Core aus aber nicht mehr erreichbar.
	if [ -z "$LISTEN" ]; then
		LISTEN="$(grep '^DOCKPOSER_LISTEN=' "$ENV_FILE" | cut -d= -f2- || true)"
		[ -n "$LISTEN" ] && say "Listen-Adresse aus $ENV_FILE übernommen: $LISTEN"
	fi
	if [ -z "$STACKS" ]; then
		STACKS="$(grep '^DOCKPOSER_STACKS=' "$ENV_FILE" | cut -d= -f2- || true)"
	fi
fi
[ -n "$LISTEN" ] || LISTEN="127.0.0.1:8720"
[ -n "$EDITABLE" ] || EDITABLE=".env" 
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
	RUN_USER="$(ask 'Service-User (braucht Docker-Gruppenrechte bzw. besitzt die Pods)' "$suggested")"
fi
[ -n "$RUN_USER" ] || die "Service-User fehlt."
id "$RUN_USER" >/dev/null 2>&1 || die "User $RUN_USER existiert nicht."
home_dir="$(getent passwd "$RUN_USER" | cut -d: -f6)"
run_uid="$(id -u "$RUN_USER")"

if [ "$NO_DOCKER" = "1" ]; then
	STACKS=""
else
	if [ -z "$STACKS" ]; then
		STACKS="$(ask 'Stacks-Pfad' "${home_dir}/stacks")"
	fi
	mkdir -p "$STACKS"
	chown "$RUN_USER" "$STACKS" 2>/dev/null || true
fi

if [ "$PODS" = "1" ]; then
	# Rootless: Die Pods gehören dem Service-User, nie root.
	[ "$run_uid" != "0" ] || die "Pods laufen rootless — bitte einen normalen Benutzer als --user angeben."
	[ -n "$PODS_PATH" ] || PODS_PATH="${home_dir}/.config/containers/systemd"
	mkdir -p "$PODS_PATH"
	chown -R "$RUN_USER" "${home_dir}/.config/containers" 2>/dev/null || chown "$RUN_USER" "$PODS_PATH"
	# Linger: Die systemd-Benutzersitzung läuft auch ohne Login — sonst gäbe es
	# nach einem Neustart weder die Pods noch ein `systemctl --user` für den Agent.
	loginctl enable-linger "$RUN_USER"
	say "→ Linger für $RUN_USER aktiviert, Pods unter $PODS_PATH."
fi

if [ "$NO_DOCKER" != "1" ] && ! id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx docker; then
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
tmp_bin="$(mktemp)"
if [ "$FROM_SOURCE" = "1" ]; then
	# Aus dem Quellcode bauen — kann nicht veralten, braucht aber Go auf dem Server
	command -v go >/dev/null || die "--from-source braucht Go (dnf install golang / apt install golang-go)."
	say "Baue Agent aus dem Quellcode …"
	src_dir="$(mktemp -d)"
	# Welche Dateien gebraucht werden, steht im Repo (agent/sources.txt) — eine
	# hier fest verdrahtete Liste veraltet still, sobald eine Datei dazukommt,
	# und der Build scheitert dann auf jedem Server statt beim Entwickeln.
	if [ -n "$SRC_DIR" ]; then
		say "Quelle: lokaler Ordner $SRC_DIR"
		[ -f "$SRC_DIR/sources.txt" ] || die "$SRC_DIR/sources.txt fehlt."
		for f in $(grep -v '^[[:space:]]*$' "$SRC_DIR/sources.txt" | tr -d '\r'); do
			case "$f" in
				*/*|..*) die "Ungültiger Eintrag in sources.txt: $f" ;;
			esac
			cp "$SRC_DIR/$f" "$src_dir/$f" || die "Datei fehlt: $SRC_DIR/$f"
		done
		files=""
	elif curl -fsSL "$BASE/agent/sources.txt" -o "$src_dir/sources.txt" 2>/dev/null; then
		# Eine Login- oder SSO-Seite kommt mit Status 200 — hier zuerst prüfen,
		# sonst würde ihr HTML als Dateiliste gelesen.
		is_html "$src_dir/sources.txt" && die "$BASE liefert eine HTML-Seite statt Dateien (Login/SSO?) — Repo nicht anonym lesbar. Alternative: --src mit lokalem Checkout."
		files="$(grep -v '^[[:space:]]*$' "$src_dir/sources.txt" | tr -d '\r')"
		rm -f "$src_dir/sources.txt"
	else
		# Ältere Repo-Stände ohne Manifest
		files="go.mod main.go update.go git.go env.go"
	fi
	for f in $files; do
		case "$f" in
			*/*|..*) die "Ungültiger Eintrag in sources.txt: $f" ;;
		esac
		curl -fsSL "$BASE/agent/$f" -o "$src_dir/$f" || die "Download fehlgeschlagen: $BASE/agent/$f"
		is_html "$src_dir/$f" && die "$BASE/agent/$f liefert eine HTML-Seite (Login/SSO?) — Repo nicht anonym lesbar. Alternative: --src mit lokalem Checkout."
	done
	( cd "$src_dir" && CGO_ENABLED=0 go build -ldflags="-s -w" -o "$tmp_bin" . ) || die "Build fehlgeschlagen."
	rm -rf "$src_dir"
else
	say "Lade Agent-Binary …"
	curl -fsSL "$BASE/agent/dockposer-agent-linux-amd64" -o "$tmp_bin" || die "Download fehlgeschlagen: $BASE/agent/dockposer-agent-linux-amd64"
	is_html "$tmp_bin" && die "$BASE liefert eine HTML-Seite statt des Binaries (Login/SSO?). Alternative: --src mit lokalem Checkout."
fi
install -m 0755 "$tmp_bin" "$BIN_PATH"
rm -f "$tmp_bin"
command -v restorecon >/dev/null && restorecon "$BIN_PATH" 2>/dev/null || true
installed_version="$("$BIN_PATH" --version 2>/dev/null || echo "?")"
say "→ $BIN_PATH installiert (Version $installed_version)." 

# ── Config ──
umask 077
{
	echo "DOCKPOSER_TOKEN=$TOKEN"
	[ -n "$STACKS" ] && echo "DOCKPOSER_STACKS=$STACKS"
	[ "$PODS" = "1" ] && echo "DOCKPOSER_PODS=$PODS_PATH"
	echo "DOCKPOSER_LISTEN=$LISTEN"
	echo "DOCKPOSER_EDITABLE_FILES=$EDITABLE"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
say "→ $ENV_FILE geschrieben (chmod 600)."

# ── systemd ──
# Härtung je nach Aufgabe. Rootless Podman braucht newuidmap/newgidmap — die
# arbeiten mit Sonderrechten, die NoNewPrivileges unterbindet. Außerdem
# schreibt Podman unter ~/.local/share/containers und /run/user/<uid>.
if [ "$PODS" = "1" ]; then
	HARDENING="# Pods (rootless Podman): newuidmap braucht Sonderrechte, deshalb ohne
# NoNewPrivileges. ProtectSystem=full hält /usr, /boot und /etc schreibgeschützt.
ProtectSystem=full
PrivateTmp=true"
	USER_SESSION="# Zugriff auf die systemd-Sitzung des Benutzers (systemctl --user, Podman)
Environment=XDG_RUNTIME_DIR=/run/user/$run_uid
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$run_uid/bus"
	USER_DEPS="After=user@$run_uid.service
Wants=user@$run_uid.service"
else
	HARDENING="NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$STACKS
PrivateTmp=true"
	USER_SESSION=""
	USER_DEPS=""
fi
cat > "$UNIT_FILE" << UNITEOF
[Unit]
Description=Dockposer Agent
After=docker.service
# Wants statt Requires: Mit Requires stoppt systemd den Agent bei jedem
# Docker-Neustart (Paket-Update) mit — ein sauberer Stopp, kein Fehler, also
# greift auch kein Restart. Der Agent kommt mit fehlendem Docker selbst
# zurecht und meldet das dem Core.
Wants=docker.service
$USER_DEPS

[Service]
Type=simple
User=$RUN_USER
EnvironmentFile=$ENV_FILE
$USER_SESSION
ExecStart=$BIN_PATH
Restart=always
RestartSec=5

# Härtung
$HARDENING

[Install]
WantedBy=multi-user.target
UNITEOF

if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
	systemctl daemon-reload
	systemctl enable dockposer-agent >/dev/null 2>&1 || true
	# WICHTIG: restart statt "enable --now". Läuft der Dienst bereits, würde
	# "enable --now" nichts tun — das neue Binary läge auf der Platte, während
	# der alte Prozess weiterläuft.
	systemctl restart dockposer-agent
	sleep 1
	if systemctl is-active --quiet dockposer-agent; then
		running_version="$(curl -fsS -m 3 -H "Authorization: Bearer $TOKEN" "http://$LISTEN/v1/health" 2>/dev/null \
			| sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
		if [ -n "$running_version" ]; then
			say "→ Dienst läuft (aktive Version: $running_version)."
		else
			say "→ Dienst läuft."
		fi
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
say "  4. Bearbeitbare Konfigdateien: $EDITABLE"
say "     (ändern mit --editable-files \".env,Caddyfile\" oder in $ENV_FILE)"
