# Dockposer

**Schlanke Docker-Compose-Verwaltung für mehrere Server. Mobile-first PWA. Das Dateisystem ist die Source of Truth.**

Dockposer verwaltet Compose-Stacks, die als normale Dateien in `~/stacks` (bzw. einem konfigurierbaren Pfad) auf jedem Server liegen. Es adoptiert bestehende Setups eins zu eins, übernimmt keine Ownership über Dateien und lässt sich jederzeit parallel zur CLI benutzen. Ein `docker compose up` per SSH bricht nichts — Dockposer erkennt die Änderung und zeigt sie an.

---

## Warum noch ein Tool?

Getestet und verworfen: Portainer (schwer, Compose-Dateien wandern in die interne DB), Dockge (Node-Overhead pro Instanz, Single-Host-Denke), Dockhand (mobile Übersicht schwach), Arcane (hat bei der Stack-Adoption Deployments zerstört), Komodo (mächtig, aber überladen), Dokploy/Coolify (PaaS-Philosophie, Traefik-Zwang), UsulNet (will alles sein, CE auf 2 Nodes limitiert).

Dockposer besetzt die Lücke: **Compose-only, Multi-Server via Mini-Agents, mobil wirklich benutzbar, und ein Alarmsystem, das direkt aufs Handy pusht.**

### Feature-Deckel (bewusst und final)

Dockposer macht: Stacks verwalten, Alerts pushen, Updates mit Auto-Rollback, Drift anzeigen. 

Dockposer macht **nicht**: Web-Terminal (stattdessen `ssh://`-Links zur nativen Terminal-App), Registry-Browser, Volume-Explorer, Netzwerk-Verwaltung, Kubernetes, Swarm, Builds aus Git-Repos, Multi-Tenant-RBAC. Dafür gibt es die CLI oder andere Tools. Jedes Feature, das hier nicht steht, braucht einen sehr guten Grund — Feature-Bloat ist der dokumentierte Todesgrund der halben Konkurrenz.

---

## Stack

| Schicht | Wahl | Anmerkung |
|---|---|---|
| Frontend/Backend | SvelteKit (Node Adapter), Svelte 5 Runes | wie Projektvorlage |
| Datenbank | **SQLite via Drizzle ORM** (`better-sqlite3`) | ⚠️ Abweichung von PROJEKTSTART.md (dort PostgreSQL). Begründung unten. |
| Auth | jose (JWT, httpOnly Cookies) + TOTP + WebAuthn/Passkeys | Lucia bleibt tabu (archiviert) |
| Push | Web Push (VAPID, `web-push` npm) + ntfy/UnifiedPush-Fallback | |
| Agent | Go, statisches Binary | läuft als systemd-Unit oder Container |
| Deployment | Docker Compose + Caddy Reverse Proxy | |
| Versionskontrolle | Forgejo | |

**Warum SQLite statt PostgreSQL:** Die Stacks liegen im Dateisystem — die DB speichert nur User, TOTP-Secrets, WebAuthn-Credentials, Sessions, Server-Registrierungen, Alert-Regeln und Alert-Historie. Das ist Kilobyte-Territorium mit einem einzigen Schreiber (der Core). SQLite spart einen Container, das Backup ist ein Datei-Copy, und Drizzle abstrahiert den Dialekt, falls später doch Postgres nötig wird (z. B. Metrik-Historisierung). Konsequenz für die Vorlage: `migrate.js` nutzt `drizzle-orm/better-sqlite3/migrator` statt `node-postgres`, kein `DATABASE_URL` mit Dummy-Postgres nötig — `drizzle-kit generate` läuft mit `dialect: 'sqlite'` ohne DB-Zugriff.

---

## Architektur-Überblick

```
                 ┌──────────────────────────────┐
                 │   Dockposer Core (SvelteKit) │
                 │  UI · API · Alert-Pipeline   │
                 │  SQLite · Web Push           │
                 └──────┬───────────┬───────────┘
        HTTPS (Caddy)   │           │  ausgehend: Registry HEAD-Requests
                        │           │  (Update-Erkennung)
         ┌──────────────┼───────────┼──────────────┐
         │ mTLS/Token   │           │              │
   ┌─────▼─────┐  ┌─────▼─────┐  ┌──▼────────┐
   │  Agent 1  │  │  Agent 2  │  │  Agent 3  │     je Server:
   │ (Go, ~15MB│  │           │  │           │     - Docker Socket (lokal)
   │  RAM)     │  │           │  │           │     - ~/stacks lesen/schreiben
   └───────────┘  └───────────┘  └───────────┘     - docker compose ausführen
```

Der Core rendert die UI, hält die DB und entscheidet über Alerts. Die Agents sind dumm: Sie führen Compose-Kommandos aus, streamen Events/Stats und melden Dateisystem-Zustand. **Alle Verbindungen gehen vom Core zum Agent** (Core → Agent HTTP + SSE zurück im selben Request), d. h. Agents brauchen einen erreichbaren Port, aber keinen Rückkanal-Setup. Auth per statischem Token (bei Registrierung generiert).

**TLS (entschieden: modular, Proxy als Standard):** Der Agent selbst spricht schlicht HTTP auf localhost/LAN-Interface — TLS macht der Reverse Proxy davor (Caddy, ohnehin Pflicht-Setup: die PWA braucht HTTPS zwingend, sonst funktionieren Service Worker und Web Push gar nicht). Agent-eigenes TLS mit selbstsigniertem Cert + Pinning bleibt als optionales Modul für später offen; der Core validiert in beiden Fällen einfach HTTPS.

### Agent-Protokoll (v1)

Bewusst simpel: HTTP + JSON, keine eigene Protokollerfindung, kein gRPC. Server-Sent Events für Streams (Logs, Events, Stats), weil SSE durch jeden Reverse Proxy geht und kein WebSocket-Handling braucht.

```
GET  /v1/health                     → { version, docker_version, disk: {stacks_path, free_bytes} }
GET  /v1/stacks                     → [ { name, path, compose_hash, state, drift } ]
GET  /v1/stacks/{name}/compose      → Rohinhalt compose.yaml (+ .env-Dateinamen, nie .env-Inhalte über die Leitung ohne Flag)
PUT  /v1/stacks/{name}/compose      → Datei schreiben (atomar: tmp + rename), Antwort enthält neuen Hash
POST /v1/stacks/{name}/up           → compose up -d, Antwort: SSE-Stream der Ausgabe
POST /v1/stacks/{name}/down         → dito
POST /v1/stacks/{name}/pull         → dito
POST /v1/stacks/{name}/update      → Pull + Up mit Rollback-Logik (siehe unten), SSE-Stream
GET  /v1/events                     → SSE: gefilterte docker events (container die/oom/health_status/restart)
GET  /v1/stats                      → SSE: aggregierte Container-Stats (Intervall konfigurierbar, Default 5s)
GET  /v1/containers/{id}/logs?tail= → SSE: Log-Stream
```

Der Agent hält **keinen Zustand** außer seinem Config-File (Token, Stacks-Pfad, Port). Stirbt der Agent, läuft alles weiter — er ist reine Durchreiche zum Docker-Socket und Dateisystem. Crash-Loop-Zählung, Alert-Entscheidungen, Digest-Vergleiche: alles im Core.

**Drift-Erkennung:** Der Agent berechnet pro Stack den Hash der compose.yaml (+ Override-Dateien) und vergleicht die `com.docker.compose.config-hash`-Labels der laufenden Container mit dem, was ein `compose config` der aktuellen Dateien ergäbe. Weicht es ab → `drift: true`. Die UI zeigt das als Badge: „läuft, aber nicht wie in der Datei definiert" — mit Diff-Ansicht und Ein-Klick-`up` zum Angleichen.

---

## Datenmodell

Alle Tabellen in `src/lib/server/db/schema.ts`, Enums als SQLite-`text` mit Drizzle-`enum`-Typisierung.

```
users
  id, username, password_hash (bcrypt, statischer bcryptjs-Import!),
  totp_secret (verschlüsselt, AES-256-GCM mit Key aus ENV),
  totp_enabled, created_at

webauthn_credentials
  id, user_id → users, credential_id, public_key, counter,
  transports, device_name, created_at, last_used_at

sessions
  id, user_id → users, token_hash, expires_at, created_at,
  user_agent, ip

servers
  id, name, base_url, agent_token_hash,
  status: enum('online','offline','degraded'),
  stacks_path, last_seen_at, created_at

stacks  (Cache/Metadaten — Quelle bleibt das Dateisystem!)
  id, server_id → servers, name, compose_hash,
  state: enum('running','partial','stopped','unknown'),
  drift: boolean,
  update_policy: enum('manual','auto','auto_patch'),
  git_tracking: boolean,
  last_synced_at

alert_rules
  id, scope: enum('global','server','stack'),
  server_id?, stack_id?,
  type: enum('container_exit','crash_loop','unhealthy','oom_kill',
             'pull_failed','update_rolled_back','disk_space','agent_offline'),
  enabled, threshold_json  (z. B. {"restarts":3,"window_min":5} für crash_loop,
                            {"free_percent":10} für disk_space)

alerts  (Historie + Zustand für Deduplizierung)
  id, rule_type, server_id, stack_id?, container_name?,
  severity: enum('info','warning','critical'),
  message, fired_at, resolved_at?, acknowledged_at?

push_subscriptions
  id, user_id → users, endpoint, keys_p256dh, keys_auth,
  transport: enum('webpush','ntfy'), ntfy_topic?, created_at, last_success_at

update_runs  (Audit für Updates + Rollbacks)
  id, stack_id → stacks, trigger: enum('manual','policy'),
  old_digests_json, new_digests_json,
  result: enum('success','rolled_back','failed'),
  log_excerpt, started_at, finished_at
```

Bewusst **nicht** in der DB: compose-Inhalte, .env-Werte, Container-Zustände als Wahrheit. Die `stacks`-Tabelle ist ein Sync-Cache für die Übersichtsseite (damit die Liste ohne drei Agent-Roundtrips rendert) und wird bei jeder Agent-Antwort aktualisiert — bei Konflikt gewinnt immer der Agent/das Dateisystem.

---

## Alert-Pipeline

```
docker events (Agent, SSE) ──┐
Healthcheck-Flips ───────────┤
Disk-Space (Agent-Poll 60s) ─┼──► Core: Event-Normalisierung
Agent-Timeout (Core-seitig) ─┘         │
                                       ▼
                          Regel-Matching (alert_rules, Scope-Kaskade:
                          Stack überschreibt Server überschreibt Global)
                                       │
                                       ▼
                          Zustandsmaschine + Deduplizierung
                          (Crash-Loop: N Restarts in M Minuten zählen;
                           kein Re-Alert solange unresolved;
                           Auto-Resolve wenn Container wieder healthy)
                                       │
                                       ▼
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
             Web Push (VAPID)                    ntfy/UnifiedPush-POST
             an alle push_subscriptions          (Fallback/parallel)
                    │
                    ▼
             In-App: Alert-Center mit Ack/Resolve, Badge im PWA-Icon
```

Grundsatz: **Event-getrieben, kein Polling** (einzige Ausnahmen: Disk-Space und Registry-Checks). `docker events` liefert `die`, `oom`, `health_status`, `restart` — daraus lassen sich alle Alert-Typen ableiten. Crash-Loop ist der wichtigste und von der Konkurrenz meistübersehene: N Restarts desselben Containers in M Minuten (Default 3/5) → ein einziger Critical-Alert, nicht N Einzelmeldungen.

Web Push direkt aus der PWA ist das Alleinstellungsmerkmal — kein Tool in diesem Feld kann das. Funktioniert auf Android (inkl. GrapheneOS mit sandboxed Play Services) und iOS ≥16.4 (PWA muss zum Homescreen hinzugefügt sein). ntfy als Fallback für Setups ganz ohne Push-Dienste.

---

## Update-Management (der Watchtower-Ersatz)

**Erkennung:** Core macht pro Stack periodisch (Default 6h, konfigurierbar) HEAD-Requests gegen die Registry (`HEAD /v2/{image}/manifests/{tag}` mit `Accept: manifest`-Headern) und vergleicht den Digest mit dem laufenden. Billig, kein Pull. Ergebnis: Update-Feed in der UI („3 Stacks haben neue Images") mit Link zu Release Notes, wo ermittelbar (GitHub/Forgejo-Releases über Image-Labels `org.opencontainers.image.source`).

Registry-Auth für private Images (z. B. Forgejo-Registry) kommt bewusst **ganz am Schluss** (siehe Milestones). Bis dahin degradiert der Feed leise: Images, deren Registry ohne Auth keinen Digest liefert, zeigen „Check nicht möglich" statt eines Fehlers — Updates dieser Stacks laufen weiterhin manuell per Pull.

**Ausführung mit Auto-Rollback** (läuft im Agent, Entscheidung im Core):

```
1. Digests aller Services des Stacks snapshotten → update_runs.old_digests_json
2. compose pull && compose up -d
3. Stabilisierungsfenster beobachten (Default 90s):
   - alle Container mit Healthcheck → müssen healthy werden
   - Container ohne Healthcheck → dürfen nicht exiten/restarten
4. Erfolg  → update_runs.result = success, Info-Alert (optional, Default aus)
   Fehler  → compose down, Images auf alte Digests pinnen
             (docker compose up mit temporärer Override-Datei
              <stack>/.dockposer-rollback.yaml, die image: auf
              @sha256-Digests festnagelt), up -d
           → update_runs.result = rolled_back
           → Critical-Push: „Update von {stack} fehlgeschlagen — Rollback aktiv.
              Läuft wieder auf altem Stand."
```

Die Rollback-Override-Datei liegt sichtbar im Stack-Ordner und wird in der UI prominent angezeigt („Stack läuft auf gepinnter alter Version") — kein verstecktes Magic. Aufräumen (Override löschen, compose.yaml anpassen) bleibt bewusst eine manuelle Entscheidung.

**Update-Policies pro Stack:** `manual` (nur Feed-Anzeige), `auto` (jedes neue Image), `auto_patch` (nur wenn Tag semver-artig und nur Patch-Sprung — konservativer Default-Vorschlag für Infra-Stacks).

---

## Auth & Sicherheit

Login: Username + Passwort (bcrypt) → zweiter Faktor Pflicht ab Einrichtung. **TOTP** als Basis (otpauth-QR, verschlüsseltes Secret), **WebAuthn/Passkeys** als komfortabler Weg — auf dem Handy in der installierten PWA ist Fingerabdruck-Login der erwartbare Flow, `@simplewebauthn/server` + `/browser` sind der Stand der Technik. Sessions als httpOnly-Cookie mit jose-signiertem Token, DB-seitige Session-Tabelle für Revocation.

Weitere Punkte: Agent-Tokens nur gehasht in der DB; CSRF über SvelteKit-Origin-Check + `ORIGIN`-ENV; Rate-Limiting auf Login/TOTP (einfacher In-Memory-Bucket reicht bei SQLite-Single-Instance); Security-Header via Caddy; keine .env-Inhalte der Stacks in UI oder API, nur Dateinamen (Editieren als explizites Opt-in-Feature später).

`ssh://`-Links: Pro Server hinterlegbar (`ssh://user@host`), rendert als Button „Terminal öffnen" — Android (Termius, JuiceSSH), iOS und Desktop-Clients registrieren das Scheme selbst. Dockposer implementiert **kein** eigenes Terminal.

---

## PWA & Mobile-first

Die Übersichtsseite ist für die Hosentasche gebaut: Server-Karten mit Ampel-Status, darunter Stacks als kompakte Liste (Name, Status-Dot, Drift-Badge, Update-Badge), Pull-to-Refresh, große Touch-Targets.

**Stack-State in der Übersicht (entschieden):** Ein Status-Dot pro Stack, keine Dots pro Service. Bei `partial` wird der Dot gelb und daneben steht kompakt „3/4" (laufende/definierte Services) — welcher Service down ist, zeigt erst die Detailansicht. Hält die Liste auch bei 20+ Stacks ruhig; Service-Dots wären ein kleiner, additiver Umbau, falls sich das in der Praxis als zu wenig Info erweist. Detailansichten (Logs, Compose-Editor) dürfen Desktop-lastiger sein — die Mobile-Priorität gilt für Monitoring und Ein-Klick-Aktionen (restart, update, ack).

Technisch: Web App Manifest + Service Worker (Push-Empfang, App-Shell-Cache — **kein** Offline-Caching von Zustandsdaten, veralteter Status ist gefährlicher als kein Status), Badge-API für offene Alerts, `theme-color` je Light/Dark. Design nach Projektvorlage: Atkinson Hyperlegible, CSS-Variablen, `[data-theme="dark"]` + `prefers-color-scheme`, WCAG-AA-Kontrast, keine SaaS-Grautöne.

---

## Optionales Git-Backend

Pro Stack aktivierbar (`git_tracking`): Jede Änderung an compose-Dateien über Dockposer erzeugt einen Commit im Stacks-Ordner-Repo (Agent führt `git commit` lokal aus; Remote-Push zu Forgejo optional). Ergebnis: Gratis-Audit-Log und Undo per Git — **ohne** GitOps-Zwang. Dockposer deployed nie *aus* Git, es protokolliert *nach* Git. Wer echtes GitOps will, ist bei Komodo besser aufgehoben; das ist bewusst außerhalb des Deckels.

---

## Projektstruktur

```
dockposer/
  core/                       ← SvelteKit-App (Struktur nach PROJEKTSTART.md)
    src/lib/server/db/        ← schema.ts, index.ts (better-sqlite3)
    src/lib/server/auth.ts    ← jose, TOTP, WebAuthn
    src/lib/server/guards.ts
    src/lib/server/agents/    ← Agent-Client (HTTP+SSE), Sync-Logik
    src/lib/server/alerts/    ← Pipeline, Regeln, Push-Versand
    src/lib/server/updates/   ← Registry-Checks, Update-Orchestrierung
    src/routes/
      +page.svelte            ← Mobile Übersicht (Server + Stacks)
      stacks/[server]/[name]/ ← Detail, Logs, Editor
      alerts/                 ← Alert-Center
      settings/               ← Server, Push, Policies, Account/2FA
      api/                    ← Push-Subscription-Endpoints, Agent-Callbacks
    drizzle/                  ← Migrations (im Repo!)
    migrate.js                ← SQLite-Variante
    Dockerfile, entrypoint.sh, docker-compose.yml, .env.example
  agent/                      ← Go-Modul, eigenes Release-Artefakt
    main.go, api/, compose/, events/
    dockposer-agent.service   ← systemd-Unit-Template
```

---

## MVP-Milestones

Entwicklung läuft gegen ein dediziertes Testsystem mit Wegwerf-Stacks — deshalb kein separater Read-only-Milestone; der Agent kann von Anfang an schreiben (spart außerdem das Nachrüsten des SSE-Streamings der Compose-Ausgabe).

**M1 — Grundgerüst (Lesen + Schreiben):** Agent v1 (health, stacks, events, stats, logs, up/down/pull/restart), Core mit Login (Passwort + TOTP), Server-Registrierung, mobile Übersichtsseite mit Live-Status („3/4"-Anzeige), Compose-Editor mit Datei-Roundtrip (atomares Schreiben), Drift-Anzeige. *Erfolgskriterium: drei Server in einer UI auf dem Handy, Stacks starten/stoppen/editieren funktioniert gegen das Testsystem.*

**M2 — Alerts:** Pipeline, Crash-Loop-Erkennung, Web Push + ntfy, Alert-Center mit Ack. *Ab hier ist Dockposer besser als alles Getestete.*

**M3 — Updates:** Registry-Digest-Checks (öffentliche Registries), Update-Feed, Update mit Auto-Rollback, Policies.

**M4 — Politur:** WebAuthn/Passkeys, Git-Backend, PWA-Feinschliff (Badge, Install-Prompt), `ssh://`-Buttons, Doku.

**M5 — Ganz am Schluss:** Registry-Auth für private Images (Forgejo-Registry) im Update-Feed. Bis dahin: „Check nicht möglich" für private Images, siehe Update-Management.

---

## Vor dem ersten Code (nach PROJEKTSTART.md)

Versionskompatibilität live prüfen — zusätzlich zu den bekannten Checks (`@sveltejs/kit`, `adapter-node`, `svelte`, `vite`, `vite-plugin-svelte` inkl. Peer-Deps):

```bash
curl -s https://registry.npmjs.org/drizzle-orm/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])"
curl -s https://registry.npmjs.org/better-sqlite3/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])"
curl -s https://registry.npmjs.org/@simplewebauthn/server/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])"
curl -s https://registry.npmjs.org/web-push/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])"
curl -s https://registry.npmjs.org/otpauth/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])"
```

Bekannte Stolperfallen der Vorlage gelten weiter: `vitePreprocess` aus `@sveltejs/vite-plugin-svelte`, Plugin explizit als devDependency, `"type": "module"`, bcryptjs statisch importieren, `drizzle/` nicht in `.gitignore`. Neu für SQLite: `better-sqlite3` ist ein natives Modul — im Dockerfile braucht der Builder-Stage `apk add python3 make g++` (oder `npm rebuild better-sqlite3` im Runner testen), und das DB-File gehört auf ein Volume (`/app/data/dockposer.db`).

**Entschiedene Designfragen** (Stand: vor M1): Agent-TLS modular — Agent spricht HTTP, TLS via Caddy-Proxy (Pflicht wegen PWA), Agent-eigenes Cert als späteres Modul. Stack-State in der Übersicht: ein Dot pro Stack plus „3/4"-Text bei `partial`, keine Service-Dots. Registry-Auth für private Images: ganz ans Ende (M5), Feed degradiert bis dahin leise. Kein Read-only-M1 — Entwicklung gegen dediziertes Testsystem.
