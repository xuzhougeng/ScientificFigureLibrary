# Source Organization

Use this reference for software projects, packages, libraries, services, CLIs, and mixed repositories with importable code.

## Principle

Separate runtime entrypoints from reusable implementation:

```text
entrypoint -> package/module -> tests -> docs
```

Entrypoints should be thin. Shared logic belongs in importable modules, not copied across scripts.

## Recommended Shapes

Python package:

```text
src/<package_name>/
  __init__.py
  cli.py
  core/
  io/
  plotting/
tests/
scripts/
```

R project:

```text
R/
  io.R
  plotting.R
  analysis.R
scripts/
tests/
```

Mixed analysis/software project:

```text
scripts/          # workflows
src/              # importable implementation
utils/            # optional, only when script-first helpers remain
tests/            # source-level behavior checks
```

## Boundaries

Use `src/` when code has a stable API, tests, or reuse across entrypoints.

Use `utils/` when the project is script-first and helpers are local to workflows.

Avoid placing long workflow execution inside `src/` modules. Avoid placing reusable libraries inside one-off scripts.

## Migration Guidance

Do not package everything at once. Move repeated, stable logic first:

- file I/O helpers;
- plotting helpers;
- data validation helpers;
- shared model or analysis functions;
- CLI dispatch only when multiple workflows need it.

Keep old entrypoints working while extracting shared logic.

