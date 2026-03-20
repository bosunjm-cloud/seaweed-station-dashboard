# Seaweed Dashboard — Role-Based Access Control Plan

## Goal

Allow 2–3 passwords that each map to a **role**, controlling:
- Which stations are visible (station cards, station pages, station health)
- Whether Settings, Battery, and Station Health nav links appear
- Whether Settings / Battery pages are accessible at all (even via direct URL)

Admin-configured values (station coordinates, Supabase keys, device profiles) must
persist **across all browsers** — not just the admin's localStorage.

---

## Current State (as-built)

| Item | How it works today |
|---|---|
| **Login gate** | `login.html` — single password `'mwani'` hard-coded in JS. Sets `sessionStorage.sw_auth = 'ok'` |
| **Settings gate** | `settings.html` — second password `'changeme'` via `window.prompt()`. Sets `sessionStorage.sw_settings_auth = 'ok'` |
| **Page guards** | `ESP32_Weather_Station_Dashboard.html`, `station.html`, `battery_estimator.html`, `perth_wroom.html` — all check `sw_auth`. **`station_health.html` is missing the check entirely (bug).** |
| **Station list** | Built from `DEFAULT_DEVICE_PROFILES` in `seaweed_common.js` + overrides in `localStorage.seaweed_dashboard_config.deviceProfiles` |
| **Station coords** | Stored in `deviceProfiles[].mapLat / mapLon` inside localStorage (browser-local only) |
| **Nav links** | Hard-coded `<a>` tags in each page header: Battery, Station Health, Settings |
| **Config persistence** | `localStorage` only — each browser has its own copy |

---

## Design Decisions

### Client-side only (accepted trade-off)
All role enforcement is in the browser JS. A technical user could bypass it by
inspecting code. This is acceptable for this project — the goal is **convenience
gating**, not security hardening.

### Shared config via Supabase
Admin-set values (station coordinates, device profiles, role definitions) will be
stored in a **Supabase table** so that every browser gets the same config. This
solves the "coordinates only exist in my browser" problem.

### Backward compatibility
If no `accessControl` config exists, the dashboard falls back to current
single-password behavior. No breakage during rollout.

---

## Data Model

### 1. Role definitions (stored in Supabase + mirrored to localStorage)

```jsonc
// Inside seaweed_dashboard_config.accessControl
{
  "accessControl": {
    "roles": [
      {
        "roleId": "admin",
        "password": "mwani",              // current login password
        "allowedStations": ["*"],         // wildcard = all stations
        "canViewSettings": true,
        "canViewBattery": true,
        "canViewStationHealth": true
      },
      {
        "roleId": "kenya_viewer",
        "password": "seaweed2026",
        "allowedStations": ["shangani", "funzi"],
        "canViewSettings": false,
        "canViewBattery": false,
        "canViewStationHealth": false
      },
      {
        "roleId": "test_viewer",
        "password": "perthtest",
        "allowedStations": ["perth", "wroom"],
        "canViewSettings": false,
        "canViewBattery": true,
        "canViewStationHealth": true
      }
    ]
  }
}
```

### 2. Session state (sessionStorage — per tab)

| Key | Value | Set by |
|---|---|---|
| `sw_auth` | `'ok'` | `login.html` (kept for backward compat) |
| `sw_role` | `'admin'` / `'kenya_viewer'` / etc. | `login.html` |
| `sw_allowed_stations` | JSON array: `["shangani","funzi"]` or `["*"]` | `login.html` |
| `sw_features` | JSON object: `{"settings":false,"battery":false,"stationHealth":false}` | `login.html` |

### 3. Supabase shared config table (new)

```sql
CREATE TABLE IF NOT EXISTS public.dashboard_config (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Row-level security: anon can SELECT, only service_role can INSERT/UPDATE
ALTER TABLE public.dashboard_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON public.dashboard_config
  FOR SELECT USING (true);
```

Admin pushes config via Settings page (authenticated as admin role).
All browsers pull config on load.

Stored rows:
| key | value (JSONB) |
|---|---|
| `device_profiles` | Array of device profile objects (coords, install dates, etc.) |
| `access_control` | The roles array above |
| `dashboard_settings` | Auto-refresh interval, max results, etc. |

---

## Implementation Steps

### Phase 1: Shared config infrastructure

**Step 1.1 — Supabase migration: `dashboard_config` table**
- New file: `Superbase/migrate_create_dashboard_config.sql`
- Creates `dashboard_config` table with RLS (anon read, admin write)
- Seed with current device profiles and default admin role

**Step 1.2 — Config loader in `seaweed_common.js`**
- New function: `fetchSharedConfig()` — pulls `dashboard_config` from Supabase
- Merges into localStorage as cache (so offline still works)
- Called on every page load (non-blocking; falls back to localStorage cache)
- New function: `getAccessControl()` — returns roles array from shared config

**Step 1.3 — Config pusher in `settings.html`**
- Admin "Save" button also pushes device profiles + access control to Supabase
- Uses Supabase anon key + simple UPSERT
- Only available when role is `admin`

### Phase 2: Role-based login

**Step 2.1 — Update `login.html`**
- On submit: fetch `accessControl` from Supabase (or fallback to localStorage)
- Match password against `roles[].password`
- If match: set `sw_auth`, `sw_role`, `sw_allowed_stations`, `sw_features` in sessionStorage
- If no match: show error
- If no `accessControl` config exists: fall back to current hard-coded password

**Step 2.2 — Common helpers in `seaweed_common.js`**
- `getCurrentRole()` → reads sessionStorage, returns role object
- `isStationVisibleForRole(stationId)` → checks `sw_allowed_stations`
- `canAccessFeature(featureName)` → checks `sw_features`
- `filterStationsForRole(stationsArray)` → returns only allowed stations
- `requireFeature(featureName, redirectUrl)` → page guard, redirects if denied

### Phase 3: Station scoping

**Step 3.1 — Overview page (`ESP32_Weather_Station_Dashboard.html`)**
- Filter TABLES array through `filterStationsForRole()` before rendering cards
- Only allowed station cards appear

**Step 3.2 — Station page (`station.html`)**
- On boot: check `isStationVisibleForRole(tableId)`
- If denied: redirect to first allowed station, or overview
- `buildStationsFromConfig()` → filter output through role

**Step 3.3 — Station health page (`station_health.html`)**
- Add missing `sw_auth` guard (bug fix)
- Add `requireFeature('stationHealth')` guard
- Filter station tabs/selectors to allowed stations only

### Phase 4: Feature gating (nav links + page guards)

**Step 4.1 — Hide nav links on all pages**

Pages with header nav links:
- `ESP32_Weather_Station_Dashboard.html` — Battery, Station Health, Settings
- `station.html` — Settings, Station Health
- `station_health.html` — Settings link (if present)
- `battery_estimator.html` — back links

Add a shared function `applyNavVisibility()` in `seaweed_common.js`:
```js
function applyNavVisibility() {
  var role = getCurrentRole();
  document.querySelectorAll('[data-feature]').forEach(function(el) {
    var feature = el.getAttribute('data-feature');
    if (!canAccessFeature(feature)) {
      el.style.display = 'none';
    }
  });
}
```

Tag each nav link with `data-feature="settings"`, `data-feature="battery"`, etc.

**Step 4.2 — Page-level guards**

| Page | Guard |
|---|---|
| `settings.html` | `requireFeature('settings')` — redirect to overview if denied |
| `battery_estimator.html` | `requireFeature('battery')` — redirect to overview if denied |
| `station_health.html` | `requireFeature('stationHealth')` — redirect to overview if denied |

These go in `<script>` tags at the top of each page, right after the existing
`sw_auth` check.

### Phase 5: Admin role editor in Settings

**Step 5.1 — New "Access Roles" section in `settings.html`**
- Appears only for admin role
- Table/form per role:
  - Role name (text)
  - Password (text input, visible to admin)
  - Allowed stations (checkboxes, one per device profile)
  - Feature toggles: Settings, Battery, Station Health
- Validation:
  - No duplicate passwords across roles
  - At least one role must have `canViewSettings: true` (prevents lockout)
  - At least one station per role
- "Add Role" / "Remove Role" buttons
- Saved alongside device profiles when admin clicks "Save to Browser" / push to Supabase

**Step 5.2 — Remove hard-coded passwords**
- Remove `'mwani'` from `login.html` — passwords come from config only
- Remove `'changeme'` from `settings.html` — settings access governed by role
- Keep `ensureSettingsUnlocked()` but rewrite to check `sw_role === admin-equivalent`

---

## File Change Summary

| File | Changes |
|---|---|
| `Superbase/migrate_create_dashboard_config.sql` | **NEW** — create table + RLS + seed |
| `pages/seaweed_common.js` | Add: `fetchSharedConfig()`, `getAccessControl()`, `getCurrentRole()`, `isStationVisibleForRole()`, `canAccessFeature()`, `filterStationsForRole()`, `requireFeature()`, `applyNavVisibility()` |
| `login.html` | Replace hard-coded password check with role resolver against accessControl config |
| `ESP32_Weather_Station_Dashboard.html` | Filter station cards; tag nav links with `data-feature`; call `applyNavVisibility()` |
| `pages/station.html` | Role-check table param; filter stations map; tag nav links; call `applyNavVisibility()` |
| `pages/station_health.html` | Add missing `sw_auth` guard; add `requireFeature('stationHealth')`; filter station selector |
| `pages/battery_estimator.html` | Add `requireFeature('battery')` guard |
| `pages/settings.html` | Replace prompt-password with role check; add Access Roles editor section; push config to Supabase on save |
| `pages/perth_wroom.html` | Tag nav links with `data-feature` |

---

## Locked Admin Config (cross-browser persistence)

These fields are set by admin in Settings and pushed to Supabase so **every
browser** sees the same values. Non-admin roles cannot change them.

| Config field | Where used | Editable by |
|---|---|---|
| Station coordinates (mapLat, mapLon) | Station page map, sensor map | Admin only |
| Device profiles (enabled, install date, data folder) | All pages | Admin only |
| Access roles (passwords, station scopes, features) | Login, all pages | Admin only |
| Supabase URL / anon key | All data fetches | Admin only |
| Auto-refresh interval | Overview, station pages | Admin only |

Non-admin viewers consume these values read-only from the shared Supabase table.
Their localStorage caches the latest pull but cannot override the shared source.

---

## Rollout Order

1. **Phase 1** — Supabase table + shared config loader/pusher
2. **Phase 2** — Role-based login (backward compatible: works without config)
3. **Phase 3** — Station scoping on overview + station pages
4. **Phase 4** — Feature gating (nav hiding + page guards)
5. **Phase 5** — Admin role editor UI in Settings

Each phase is independently deployable and testable.

---

## Test Checklist

- [ ] Admin password → sees all 5 stations, all nav links visible
- [ ] Regional password → sees only assigned stations, no Settings/Battery links
- [ ] Regional user opens `settings.html` directly → redirected to overview
- [ ] Regional user opens `station.html?table=perth` (not in their scope) → redirected
- [ ] No `accessControl` in config → falls back to current single-password behavior
- [ ] Admin edits roles in Settings → saves to Supabase → new browser session picks up changes
- [ ] Admin edits station coordinates → visible in all browsers after refresh
- [ ] Station health page now requires login (bug fix)
- [ ] Second admin browser sees same roles without manual config
- [ ] Logout (close tab) clears session — must re-enter password

---

## Bug Fix (opportunistic)

`pages/station_health.html` is missing the `sw_auth` session gate that all other
pages have. This will be added in Phase 3 regardless of whether the role system
is implemented.
