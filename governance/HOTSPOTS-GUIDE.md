# Hot shared files — how to find and retire them

DELIVERY §6: *shared files that many Tasks touch are prefactored first, so later
Tasks add a file instead of editing a shared one. If that is impossible, the
shared file gets its own area and the Tasks that need it are chained with
blocked by.*

Each adopted repository keeps its own list in `.github/governance/HOTSPOTS.md`.
Product structure never lives in this public repository.

## Finding them

Count how often each file changed recently, excluding generated code and docs:

```bash
git log origin/test -300 --name-only --format= | grep -v '^$' | sort | uniq -c | sort -rn | head -30
```

A file is a hotspot when Tasks from **several areas** need to edit it. The usual
suspects, in any stack:

| Kind | Examples |
|---|---|
| Composition root / DI registration | `Program.cs`, `service_locator.dart`, `main.ts` |
| Route table, navigation menu | `app_router.dart`, a `Navigation.cs`, a routes file |
| Central registries | a permissions class, a feature-flag list, a module list |
| One big SQL or migration file | a single RLS policy file for every schema |
| Seeders and test factories | one demo seeder, one `WebApplicationFactory` |
| Dependency manifests and lockfiles | `pubspec.yaml`, `package.json`, `Directory.Build.props` |
| A flat test folder | every module's end-to-end tests in one directory |

## The prefactor, by kind

- **Registration files** → one registration file per area (an extension method,
  a `register<Area>()` function, a DI-discovered contribution), called from the
  root in a fixed order. A Task then edits its own area's file.
- **Routes and menus** → per-area route or menu contributions, concatenated.
- **Registries of constants** → partial classes or one file per area.
- **Single large SQL files** → one file per schema, applied in a fixed order.
- **Dependency manifests** → change only in the owning area; a Task that needs a
  package is blocked by one that adds it.
- **Flat test folders** → subfolders per area, then give each to its area.
- **Serial by nature** (a platform SDK pin, a contract version) → keep it in one
  area and chain the Tasks; never bundle it inside a feature Task.

## The list format

One row per file: the file, its owning area, how many recent commits touched it,
why every area hits it, and its prefactor. Until a hotspot is prefactored, a Task
that must edit it belongs to the owning area or is chained behind that area's
in-flight Task.
