# MCP TypeScript SDK – Agent Guide

## Architektur im Überblick
- `src/shared/` enthält das herstellerneutrale Grundgerüst (`protocol.ts`, `transport.ts`, Fehler-/Capability-Typen) und wird sowohl von Client als auch Server genutzt.
- `src/server/` baut darauf auf: `index.ts` implementiert den MCP-Server, Transports (`stdio.ts`, `sse.ts`, `streamableHttp.ts`) sowie OAuth-/Middleware-Stacks unter `auth/`.
- `src/client/` spiegelt die Serverstruktur mit eigenen Transporten (SSE, WebSocket, stdio) und validiert Tool-Ausgaben via Ajv.
- `src/shared/auth-utils.ts` & `src/server/auth/*` kapseln PKCE/OAuth-Flows; Tests nutzen die Mocks aus `src/__mocks__`.
- Beispiele und Referenzen liegen in `src/examples/` (Client- und Server-Demos) und werden vom CLI-Einstieg `src/cli.ts` verwendet.

## Arbeitsabläufe & Builds
- Node >= 18, pures ESM: lokale Importe brauchen ein `.js`-Suffix.
- `npm run build` erzeugt ESM und CJS Artefakte (`dist/esm`, `dist/cjs`) über separate TS-Konfigurationen; neue öffentliche Module müssen nach dem Build unter `dist` landen, nicht direkt committet werden.
- Tests laufen mit Jest/ts-jest (`npm test`). Vor jedem Lauf wird `spec.types.ts` per `npm run fetch:spec-types` aktualisiert – benötigst du Offline-Unterstützung, pinne die Datei vor Tests.
- Linting & Formatierung: `npm run lint` (ESLint + Prettier), `npm run lint:fix` für Auto-Fixes.
- Lokales Debugging: `npm run server` startet den stdio-Demo-Server, `npm run client <transport>` verbindet sich (HTTP/SSE, WS oder stdio).

## Projekt-spezifische Muster
- Fähigkeiten-/Capability-Handling geschieht über `mergeCapabilities` in `shared/protocol.ts`; neue Requests/Notifications müssen dort sowie in `types.ts` verdrahtet werden.
- Tool-Definitionen verwenden `zod` zur Schema-Deklaration und werden in `client/index.ts` gegen `outputSchema` mit Ajv-validiert – bei neuen Tools unbedingt `structuredContent` liefern.
- Streaming- oder SSE-Funktionalität nutzt `eventsource` Polyfills; Tests greifen häufig auf `supertest` und `@jest-mock/express` zurück.
- Auth-Routen (`server/auth/router.ts`) folgen Express-Konventionen mit Rate-Limiting; zusätzliche Handler sollten die bestehende Fehlerstruktur (`AuthError` in `server/auth/errors.ts`) verwenden.
- Integrationstests unter `integration-tests/` laufen ebenfalls via Jest; sie erwarten, dass Ressourcen sauber bereinigt werden (z.B. Prozess-Shutdowns innerhalb von `afterEach`).

## Nützliche Referenzen
- `README.md` (grober Überblick, Quickstarts, Transport-Matrix).
- `src/examples/README.md` für lauffähige Server-/Client-Beispiele.
- `CLAUDE.md` fasst Stil- und Workflow-Konventionen zusammen – weiterführende Details hier ergänzen.

Bitte melde zurück, falls Abschnitte fehlen oder konkretere Beispiele benötigt werden.
