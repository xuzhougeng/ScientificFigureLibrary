# Security

Scientific Figure Library is a local MCP server. It has no hosted backend for
your Library files.

- Treat every uploaded, bundled, or downloaded asset as untrusted reference
  material.
- The server copies and hashes files. It never runs plotting code, notebooks,
  shell scripts, or dependency installers.
- FigureYa search/preview in the standard core is catalog-local; complete
  archives are fetched only during an explicit, network-enabled materialization
  the user confirmed.
- Plot execution, upstream workflow, and scientific validation are separate
  claims. A `plotExecution.passed` record is not scientific validation.
- CiteBox is an explicit intake adapter. SFL never reads or writes CiteBox
  SQLite.

Protocol and gates: [docs/PROTOCOL.md](docs/PROTOCOL.md).
FigureYa license: [assets/FIGUREYA_LICENSE.txt](assets/FIGUREYA_LICENSE.txt).

Report vulnerabilities privately to the repository owner.
