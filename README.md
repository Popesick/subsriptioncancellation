# BonusPortal

Pub-Quiz-Bonusspiel: Teams kämpfen sich durch ein absichtlich nerviges "Kundenportal" und holen sich damit einen Bonuspunkt. Wer das Ende erreicht, erscheint in der Admin-Ansicht. Mobile-first, läuft auf Cloudflare Workers (Static Assets + Durable Object mit SQLite).

## Ablauf (Spieler)

Login (nur Teamname wird übertragen, das Passwortfeld wird ignoriert; "kein Passwort nötig" bleibt geheim, die Hotline +49 176 33 20401497 verrät es per Ansage) → Captcha → zwei Nachfragen → Upgrade-Falle → Fangfrage → Warteschlange → Identitätsprüfung → "Gedrückt halten" → flüchtender Button (3. Klick zählt) → Systemfehler → Ziel.

Der Server akzeptiert die Schritte nur in Reihenfolge und speichert Zeitpunkt und Platz. Der Weg zum nächsten Schritt ist häufig nur ein unauffälliger Textlink.

## Testen

`/?reset` löscht den lokal gespeicherten Spielstand und den Teamnamen im Browser (kein Cache-Leeren nötig) und startet frisch.

## Admin

`/admin` – Passwort aus dem Secret `ADMIN_PASSWORD`. Zeigt Teams im Ziel (nach Zeit sortiert), laufende Teams mit Fortschritt, "Punkt vergeben"-Haken, Team entfernen, Portal öffnen/schließen, alles zurücksetzen. Aktualisiert alle 5 s.

## Lokal

```bash
npm install
echo 'ADMIN_PASSWORD=irgendwas' > .dev.vars
npm run dev      # http://localhost:8787, Admin unter /admin
```

## Deploy

```bash
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```
