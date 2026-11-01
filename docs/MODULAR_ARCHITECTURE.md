# SocietyOS Modular Architecture & Multi-Agent Collaboration Guide

This document specifies the modular boundaries and architectural layout designed to allow multiple agents and engineers to work in parallel across the SocietyOS monorepo without file collisions or merge locks.

---

## 1. Monorepo Structure

```text
societyOS/
├── packages/
│   └── shared-types/             <-- Shared domain types & DTO contracts
│       ├── src/
│       │   ├── auth-registration.ts
│       │   ├── visitor-registration.ts
│       │   ├── relatives.ts
│       │   ├── public-directory.ts
│       │   └── index.ts
│       ├── package.json          (@societyos/shared-types)
│       └── tsconfig.json
├── apps/
│   ├── api/                      <-- NestJS Modular Monolith API
│   │   └── src/
│   │       ├── auth/             (Authentication, JWT, sessions)
│   │       ├── registration/     (Public directory, resident signup, visitor self-checkin)
│   │       ├── relatives/        (Resident relatives directory, 1-click fast passes)
│   │       ├── visitors/         (Pass lifecycle, credentials, approvals, sweep)
│   │       ├── societies/        (Tenant management, flats, policy, community)
│   │       ├── devices/          (MQTT, hardware gate adapters, boom barriers)
│   │       ├── access/           (Atomic verification engine, decision logic)
│   │       └── notifications/    (Durable notification outbox)
│   ├── web/                      <-- Next.js Frontend (Isolated Feature Architecture)
│   │   ├── app/
│   │   │   ├── register/         (Public resident sign-up page)
│   │   │   ├── visitor-register/ (Public gate visitor & relative check-in page)
│   │   │   ├── resident/         (Resident workspace: Visitors, Relatives, Notices, etc.)
│   │   │   └── login/            (Sign in with links to register & check-in)
│   │   └── features/             (Self-contained feature packages)
│   │       ├── user-registration/
│   │       ├── visitor-registration/
│   │       └── relatives-management/
│   ├── mobile/                   <-- React Native / Expo Mobile App
│   │   └── src/
│   │       ├── api/              (Mobile client & types)
│   │       ├── components/       (QuickRegisterModal, PassCard, Header)
│   │       └── context/          (AuthContext)
│   └── device-simulator/         <-- Virtual gate controller for e2e hardware verification
└── docs/                         <-- Architecture, operations, and blueprints
```

---

## 2. Feature Directory Isolation (`apps/web/features/`)

To prevent multi-agent merge conflicts in the web application, feature code is strictly decoupled into dedicated modules under `apps/web/features/<feature-name>/`:

| Feature Directory | Scope & Responsibility | Extension Point |
|---|---|---|
| `features/user-registration/` | Resident onboarding, society & flat linking, password validation | Reusable in landing pages, invite flows |
| `features/visitor-registration/` | Guest & relative self-check-in, fast category presets, instant PIN & QR token display | Embeddable in Gate Kiosk & QR scan URLs |
| `features/relatives-management/` | Family directory for residents, fast 1-click pass generation, WhatsApp sharing | Embeddable in Resident Workspace tabs |

Each feature package contains:
- `types.ts` — Local view models and re-exports from `@societyos/shared-types`
- `api.ts` — Encapsulated API client calls
- UI components (e.g., forms, modals, card grids)
- `index.ts` — Clean barrel export

---

## 3. API Module Boundaries (`apps/api/src/`)

Backend features are encapsulated as NestJS modules:

1. **`RegistrationModule` (`src/registration/`)**:
   - `GET /api/v1/public/societies`: Public list of active residential societies.
   - `GET /api/v1/public/societies/:societyId/flats`: Public list of buildings & flats for visitor check-in.
   - `POST /api/v1/auth/register`: Resident self-registration with automatic membership and flat linking.
   - `POST /api/v1/visitors/self-register`: Public visitor & relative gate check-in, generating 6-digit keypad PIN and camera QR token.

2. **`RelativesModule` (`src/relatives/`)**:
   - `GET /api/v1/flats/:flatId/relatives`: List registered family and relatives for a flat.
   - `POST /api/v1/flats/:flatId/relatives`: Register a relative with an automatic 72-hour entry pass.
   - `POST /api/v1/flats/:flatId/relatives/:visitorId/quick-pass`: Issue a 1-click fast entry pass for that relative.
   - `DELETE /api/v1/flats/:flatId/relatives/:visitorId`: Remove relative and revoke active credentials.

---

## 4. Guidelines for Parallel Agent Collaboration

When contributing simultaneously with another agent:
1. **Never edit existing core files outside your assigned domain** without checking if a separate feature module can host the logic.
2. **Import contracts from `@societyos/shared-types`** rather than creating competing type definitions.
3. **Keep routes conflict-free**:
   - Web agent working on mobile / desktop UI operates inside `apps/web/features/` or `apps/mobile/`.
   - Core API agent operates inside dedicated `apps/api/src/<domain>/` modules.
4. **Always run verification commands** before completion:
   - `pnpm typecheck`
   - `pnpm test`
   - `graphify update .`
