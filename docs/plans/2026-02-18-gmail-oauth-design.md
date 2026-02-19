# Gmail OAuth Authentication Design

## Overview

Add Google OAuth login to Backlog.md web UI with role-based access control. Authentication is **opt-in** — if environment variables are not configured, the server runs without auth (current behavior).

## Architecture

```
┌─────────────┐    id_token     ┌──────────────┐   git clone/pull   ┌─────────────┐
│   Frontend   │ ──────────────> │    Server     │ <───────────────── │ Config Repo  │
│  (React SPA) │ <────────────── │ (Bun.serve)   │                    │  (private)   │
│              │    JWT + role   │               │                    │  users.md    │
└─────────────┘                 └──────────────┘                    └─────────────┘
```

### Flow

1. Frontend loads Google Sign-In SDK
2. User clicks "Sign in with Google" → Google popup
3. Google returns `id_token` (credential) to frontend
4. Frontend sends `POST /api/auth/google` with the `id_token`
5. Server validates `id_token` with Google (verifies signature, audience, expiry)
6. Server extracts email from token, looks it up in `users.md`
7. If email exists → generates JWT with `{email, name, role}`, returns it
8. If email not found → returns 403 "User not authorized"
9. Frontend stores JWT in localStorage, adds `Authorization: Bearer <jwt>` to all requests
10. All API routes verify JWT. Viewers get 403 on write operations.

## Config Repo

A separate private Git repository stores the user whitelist. Only the deployed server has access.

### Structure

```
backlog-config/
└── users.md
```

### users.md Format

```yaml
---
users:
  - email: juan@gmail.com
    name: Juan
    role: admin
  - email: maria@gmail.com
    name: Maria
    role: viewer
---
```

### Roles

- **admin** — full access: create, edit, delete tasks, docs, decisions, milestones, config
- **viewer** — read-only: view tasks, docs, decisions, milestones, statistics

### Sync Strategy

- Server clones the config repo into a temporary directory on startup
- Polls every 5 minutes via `git pull` to detect changes
- Parses `users.md` frontmatter and keeps the user list in memory
- If `AUTH_CONFIG_REPO` is not set, authentication is disabled entirely

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | Yes (for auth) | Google Cloud Console OAuth client ID |
| `AUTH_CONFIG_REPO` | Yes (for auth) | URL of the config repo (with credentials if private) |
| `JWT_SECRET` | No | Secret for signing JWTs. Auto-generated if not provided |

If `GOOGLE_CLIENT_ID` and `AUTH_CONFIG_REPO` are not set, authentication is disabled and the server works as it does today.

## Server-Side Changes

### New API Routes

| Route | Method | Auth Required | Description |
|-------|--------|---------------|-------------|
| `/api/auth/status` | GET | No | Returns `{enabled: boolean, clientId?: string}` |
| `/api/auth/google` | POST | No | Receives `{credential: string}`, validates with Google, returns JWT |
| `/api/auth/me` | GET | Yes | Returns current user `{email, name, role}` from JWT |

### Auth Middleware

Applied to all `/api/*` routes except `/api/auth/status` and `/api/auth/google`:

- If auth is disabled (no env vars): pass through without verification
- If auth is enabled: verify `Authorization: Bearer <jwt>` header
- Invalid or missing JWT: return 401

### Role Middleware

Applied after auth middleware on write operations:

- `POST`, `PUT`, `DELETE` routes require `admin` role
- `GET` routes allow both `admin` and `viewer`
- Viewer attempting a write: return 403

### Config Repo Service

New module responsible for:

- Cloning the config repo on server startup
- Polling for updates every 5 minutes
- Parsing `users.md` YAML frontmatter
- Providing a `findUserByEmail(email): User | null` method
- Cleanup of temp directory on server shutdown

### JWT

- Signed with `JWT_SECRET` or auto-generated secret
- Payload: `{email, name, role, iat, exp}`
- Expiration: 24 hours
- Validation: verify signature, check expiration

## Frontend Changes

### AuthContext (new)

```typescript
interface AuthState {
  user: { email: string; name: string; role: string } | null;
  isLoading: boolean;
  isAuthEnabled: boolean;
}
```

- On mount: calls `GET /api/auth/status` to check if auth is enabled
- If JWT exists in localStorage: validates with `GET /api/auth/me`
- Exposes: `login(credential)`, `logout()`, `user`, `isAuthEnabled`

### LoginPage (new component)

- Clean page with project name and "Sign in with Google" button
- Uses Google Sign-In SDK (dynamically loaded script tag)
- On successful Google auth: calls `POST /api/auth/google`, stores JWT, redirects to `/tasks`
- If email not authorized: displays "Your account does not have access" error

### Route Protection

- If auth is enabled and no user: render LoginPage
- If auth is disabled: render app directly (current behavior)
- If user is `viewer`: hide create/edit/delete buttons throughout the UI

### API Client Changes (`api.ts`)

- Add `Authorization: Bearer <jwt>` header to all requests
- On 401 response: clear localStorage, redirect to login
- On 403 response: surface "insufficient permissions" error in UI

## What Does NOT Change

- CLI tool — no auth, works as today
- MCP server — uses its own auth mechanism (bearer/basic in config)
- Task file format — unchanged
- Config file format — unchanged
- Local development without env vars — unchanged
