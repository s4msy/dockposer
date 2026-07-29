# Dockposer Agent

Der Agent ist eine passive Durchreiche zu Docker-Socket und Stacks-Ordner. **Alle Verbindungen gehen vom Core zum Agent** — der Agent ruft nie irgendwo an, er lauscht nur. Das bestimmt das gesamte Netzwerk-Setup: Der Core muss den Agent erreichen, nicht umgekehrt.

## Installation (empfohlen: Installer)

Zuerst in der Dockposer-UI unter *Einstellungen → Server* den Server registrieren (Token-Feld leer lassen → Token wird generiert und **einmalig** angezeigt). Dann auf dem Zielserver:

```sh
curl -fsSL <RAW-BASE>/agent/install.sh | sudo sh -s -- \
  --base <RAW-BASE> \
  --token <TOKEN-aus-der-UI> \
  --user <docker-user> \
  --listen <interface-ip>:8720
```

`<RAW-BASE>` ist die Raw-URL des Repos bis `…/raw/branch/main`. Der Installer ist idempotent — erneutes Ausführen aktualisiert das Binary und behält die Config (inkl. Token).

## Wichtig: `--listen` richtig setzen

Der Agent bindet standardmäßig auf `127.0.0.1:8720` — dann ist er **nur vom Server selbst** erreichbar, nicht vom Core auf einer anderen Maschine. Der lokale Health-Check des Installers ist in dem Fall trotzdem grün (er läuft ja auf demselben Host), aber der „Testen"-Button in der UI schlägt fehl.

Für Remote-Zugriff die Adresse des Interfaces angeben, über das der Core kommt:

- **WireGuard/VPN:** die Tunnel-IP des Agent-Servers, z. B. `--listen 10.99.0.5:8720`
- **LAN:** die LAN-IP, z. B. `--listen 192.168.1.24:8720`

Nicht `0.0.0.0` verwenden, wenn vermeidbar — das bindet auf allen Interfaces, auch öffentlichen. Das Interface-Binding ist die sauberere Grenze als reiner Token-Schutz.

Nachträglich ändern:

```sh
sudo sed -i 's/^DOCKPOSER_LISTEN=.*/DOCKPOSER_LISTEN=192.168.1.24:8720/' /etc/dockposer-agent.env
sudo systemctl restart dockposer-agent
```

**Hinweis:** In manchen Netz-Konstellationen (z. B. der Core erreicht den Agent über eine LAN-IP, während lokal geroutet wird) funktioniert ein Binding auf `127.0.0.1` nicht zuverlässig für die eigenen Health-Checks. Im Zweifel direkt auf die LAN-/Tunnel-IP binden, unter der auch der Core den Agent anspricht.

## Firewall (Fedora/RHEL: firewalld)

Fedora blockt den Agent-Port per Default. Symptom: `curl` vom Core aus meldet **sofort** (wenige ms) `Could not connect` / `Connection refused` — ein Routing-Problem liefe dagegen in einen langen Timeout.

Port nur für den Core freigeben (empfohlen — Tunnel-IP des Core einsetzen):

```sh
sudo firewall-cmd --permanent \
  --add-rich-rule='rule family=ipv4 source address=10.99.0.1/32 port port=8720 protocol=tcp accept'
sudo firewall-cmd --reload
```

Oder — weniger restriktiv, ganzes zugelassenes Netz — zum schnellen Testen:

```sh
sudo firewall-cmd --add-port=8720/tcp --permanent && sudo firewall-cmd --reload
```

## Verbindung prüfen

Immer **vom Core-Server aus** testen — das ist die Richtung, die Dockposer nachher nutzt. Das `Bearer ` vor dem Token nicht vergessen:

```sh
curl -m 5 -H "Authorization: Bearer <TOKEN>" http://<agent-ip>:8720/v1/health
```

Kommt das JSON mit `version`, `docker_version`, `disk` zurück, wird auch der „Testen"-Button grün.

## Voraussetzungen auf dem Server

- Docker mit Compose-Plugin (`docker compose version` muss laufen)
- Der Service-User muss in der `docker`-Gruppe sein
- `git` nur nötig, wenn Git-Tracking genutzt wird
- SELinux (Fedora): unproblematisch für das Binary in `/usr/local/bin`; der Installer ruft bei Vorhandensein `restorecon` auf

## Manuelle Installation (ohne Installer)

Binary nach `/usr/local/bin/dockposer-agent`, `/etc/dockposer-agent.env` anlegen (Vorlage: `agent.env.example`), systemd-Unit aus `dockposer-agent.service` nach `/etc/systemd/system/` (User + `ReadWritePaths` anpassen), dann `systemctl enable --now dockposer-agent`.
