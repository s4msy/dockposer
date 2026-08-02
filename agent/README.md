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

## Bearbeitbare Konfigurationsdateien

Neben der compose-Datei kann Dockposer weitere Konfigdateien im Stack-Ordner bearbeiten — welche, bestimmt eine Allowlist pro Agent:

```sh
DOCKPOSER_EDITABLE_FILES=".env,Caddyfile,*.conf"
```

Default ist `.env`. Einfache Globs (`*`) sind erlaubt, Pfadanteile nicht — es geht ausschließlich um Dateien **direkt im Stack-Ordner**. Beim Installer: `--editable-files ".env,Caddyfile"`, nachträglich in `/etc/dockposer-agent.env` (danach `systemctl restart dockposer-agent`).

Hintergrund: Compose lädt automatisch nur `.env`. Viele Dienste haben aber eine eigene Konfigurationsdatei daneben (Caddy die `Caddyfile`, andere `config.yaml` o. Ä.), die man beim Bearbeiten des Stacks ohnehin braucht. Statt sie fest zu verdrahten, entscheidest du pro Server, was editierbar ist.

Zwei Sicherheitsdetails: Inhalte werden **nur auf ausdrückliche Anforderung** übertragen, nie beim Stack-Listing. Und `.env`-artige Dateien werden nach dem Schreiben mit `compose config` gegengeprüft — schlägt die Interpolation fehl, wird die Änderung automatisch zurückgerollt. Andere Formate (Caddyfile & Co.) kann Compose nicht validieren; dort gilt: Speichern, Stack neu starten, Ergebnis prüfen.

Committet wird nichts davon nach Git — die Dateien können Secrets enthalten.

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

## Git-Backend (optional)

Dockposer versioniert Compose-Dateien **nach** Git — es deployed nie *aus* Git. Kein GitOps-Zwang, nur Audit-Log und Undo.

**Modell:** Ein Repo pro Server, angelegt im **Stacks-Wurzelordner** (nicht pro Stack). Einrichten unter *Einstellungen → Git-Backend*, aktivieren pro Stack in der Stack-Detailseite. Voraussetzung: `git` ist auf dem Server installiert (`sudo dnf install git`).

### Die Tiefenregel — wichtig!

Stack-Ordner enthalten oft komplette Volumes (`./data`, `./postgres`, Caches). Die von Dockposer angelegte `.gitignore` versioniert deshalb **nur Dateien direkt in den Stack-Ordnern**:

```gitignore
/*/*/          # alle Unterordner der Stack-Ordner ignorieren (= Volumes)
.env
.env.*
*.env
.dockposer-rollback.yaml
```

Ergebnis bei `stacks/immich/compose.yaml` + `stacks/immich/data/postgres.db`: die compose-Datei ist versioniert, das Datenverzeichnis nicht. Auch `Caddyfile` o. Ä. direkt im Stack-Ordner kommt mit.

Soll ein Unterordner doch versioniert werden, unten in der `.gitignore` ausnehmen:

```gitignore
!/meinstack/config/
```

### Push zu Forgejo

Push-Ziel unter *Einstellungen → Git-Backend* eintragen. **Dockposer verwaltet keine Git-Credentials:**

- `git@host:user/repo.git` → SSH-Deploy-Key muss auf dem Server für den Agent-User liegen (`~/.ssh/`)
- `https://user:token@host/user/repo.git` → das Remote wird AES-verschlüsselt in der Dockposer-DB gespeichert

Das Repo muss in Forgejo **bereits existieren** — Dockposer legt keine Remote-Repos an. Push läuft asynchron und best-effort: Schlägt er fehl, blockiert das nie das Speichern; der Fehler landet im Agent-Log (`journalctl -u dockposer-agent`).

### Bestehendes Repo migrieren

Ist der Stacks-Ordner schon ein Repo, lässt Dockposer es unangetastet: Die Einrichtung erkennt es, und eine vorhandene `.gitignore` wird **nicht** überschrieben (es sei denn, man setzt das Häkchen explizit). Prüfen, ob die Tiefenregel enthalten ist — andernfalls die Zeile `/*/*/` ergänzen, sonst landen Volumes im Repo.

---

# Private Registries

Der Update-Feed prüft Digests direkt aus dem Core heraus (HEAD-Request gegen die Registry). Für private Images müssen dort Zugangsdaten hinterlegt sein: *Einstellungen → Private Registries*, pro Registry-Host ein Eintrag (Benutzername + Access-Token). Ohne Eintrag zeigt der Feed „Check nicht möglich“ und verlinkt direkt auf die Einrichtung.

Bei Forgejo/Gitea: Access-Token unter *Einstellungen → Anwendungen* mit Leserecht im Bereich „Paket“. Das Token wird AES-verschlüsselt gespeichert und ausschließlich für Digest-Abfragen verwendet.

**Wichtig — das Pullen selbst ist davon unabhängig:** `docker compose pull` läuft auf dem Zielserver und nutzt dessen eigenes Login. Auf jedem Server, der private Images zieht, einmalig:

```sh
docker login git.example.com
```

Dockposer verwaltet diese Anmeldung bewusst nicht — Credential-Verwaltung auf fremden Maschinen wäre ein eigenes Sicherheitsthema. Kurz: Registry-Zugangsdaten in Dockposer sind fürs *Erkennen* von Updates, `docker login` auf dem Server ist fürs *Ausführen*.

---

# Troubleshooting

## „Agent antwortet mit 500" beim Stack-Löschen

**Ursache:** Rechte. Der Agent läuft als unprivilegierter User, aber im Stack-Ordner liegen Unterverzeichnisse, die ein Container als `root` angelegt hat (typisch bei Bind-Mounts wie `./data`). Zum Löschen einer Datei zählt unter Linux nicht der Besitz an der Datei, sondern **Schreibrecht am übergeordneten Ordner** — deshalb kann der Agent solche Ordner nicht ausräumen.

**Prüfen:**

```sh
ls -la ~/stacks/<stackname>/     # Einträge mit "root root"?
```

**Abhilfe (einmalig pro Stack):**

```sh
sudo chown -R <agent-user>: ~/stacks/<stackname>
```

**Dauerhaft:** Im Compose `user:` setzen bzw. Images verwenden, die als Nicht-Root laufen (`PUID`/`PGID` bei LinuxServer.io-Images). Dockposer räumt bewusst **nicht** mit erhöhten Rechten auf — ein Agent, der fremde root-Dateien löschen darf, wäre ein Einfallstor.

## „Could not connect" / „Connection refused" vom Core aus

Kommt der Fehler **sofort** (wenige Millisekunden), ist es die Firewall → siehe Firewall-Abschnitt oben. Läuft es in einen **langen Timeout**, ist es Routing (falsche IP, kein Tunnel zwischen Core und Agent).

## Health-Check des Installers grün, „Testen" in der UI schlägt fehl

Der Agent lauscht auf `127.0.0.1` — der Installer testet lokal, der Core kommt von außen. Siehe `--listen`-Abschnitt oben.

## Update wird nach erfolgreichem Update weiterhin angezeigt

War ein Bug in frühen Versionen (Digest-Vergleich bei Multi-Arch-Images). Agent und Core aktualisieren; der Checker prüft seither die Plattform-Manifeste der Manifestliste gegen.

## Update-Feed zeigt „Check nicht möglich"

Die Registry liefert ohne Anmeldung keinen Digest. Zugangsdaten unter *Einstellungen → Private Registries* hinterlegen (siehe oben). Bei lokal gebauten Images (`build:` statt `image:`) ist die Meldung korrekt und bleibt bestehen — es gibt keine Registry, gegen die geprüft werden könnte.

## „git ist auf diesem Server nicht installiert"

Der Agent-Container (`docker:cli`) enthält git seit Patch 17; bei systemd-Installationen: `sudo dnf install git`.

## Container außerhalb des Stacks-Ordners

Die Übersicht zeigt pro Server, wie viele **laufende Container nicht zu einem Stack im Stacks-Pfad gehören** — aufklappbar mit Name, Image und (bei Compose-Stacks) dem Ordner, aus dem sie gestartet wurden. Das ist rein informativ: Dockposer verwaltet sie nicht, macht sie nur sichtbar.

Zwei Sorten werden unterschieden:

- **Stack außerhalb des Pfads** — hat Compose-Labels, aber sein `working_dir` liegt woanders (z. B. `/opt/foo`). Der angezeigte Pfad sagt dir, wo die compose-Datei liegt.
- **Einzeln gestartet** — per `docker run` ohne Compose, hat gar keine Projekt-Labels.

Aufnehmen: compose-Datei samt Konfiguration in den Stacks-Pfad verschieben, dort `docker compose up -d` — danach taucht der Stack normal in Dockposer auf. Der Container-Neustart ist dabei unvermeidbar, weil Compose die Projektzuordnung am Arbeitsverzeichnis festmacht.

## Stack-Ordner auf einen Nicht-Root-User umstellen

Damit Dockposer compose-Dateien schreiben und Stacks löschen kann, sollten die Stack-Ordner dem Agent-User gehören. **Nicht rekursiv umstellen** — in den Unterordnern liegen Volumes, und Container laufen mit eigenen UIDs (Postgres z. B. 999). Ein `chown -R` kann Datenbanken lahmlegen.

Sicher ist die nicht-rekursive Variante:

```sh
cd ~/stacks
sudo chown <user>:<user> */                          # nur die Stack-Ordner
sudo chown <user>:<user> */*.yaml */*.yml 2>/dev/null # compose-Dateien
sudo chown <user>:<user> */.env 2>/dev/null
```

Das genügt für Editieren, Anlegen und Git-Tracking. Nur zum **Löschen** eines Stacks ist ein rekursives `chown` nötig — das gezielt für den einen Stack ausführen, direkt bevor er weggeworfen wird.
