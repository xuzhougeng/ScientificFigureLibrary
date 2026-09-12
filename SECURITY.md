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

## Reporting a vulnerability privately

`jarxunlai` is the lead developer and day-to-day security triage contact.
`xuzhougeng` is the repository account owner and fallback contact for
owner-only GitHub security settings. Do not publish vulnerability details in
ordinary issues or pull requests.

1. Open the repository's [Security page](https://github.com/xuzhougeng/ScientificFigureLibrary/security).
   If **Report a vulnerability** is available, use that private reporting flow.
2. If private reporting is not available, request a private contact channel
   from `@jarxunlai` (or `@xuzhougeng` if necessary). A public contact-only issue
   may say “Security contact request”, but must contain no affected component,
   exploit, proof of concept, attachment, token or personal data.
3. Share reproduction details only after a private channel is established.

Private Vulnerability Reporting must be enabled by an authorized repository
owner; committing this policy does not enable it. No private email address has
been designated, so do not guess one or reuse personal addresses from commits.

In the private report, include the SFL/Host/Node versions, affected behavior,
minimal reproduction, impact and any safe mitigation. Never include a real
production credential; if one was exposed, revoke/rotate it rather than
reposting it. Coordinate disclosure and release timing with the maintainers.
Do not assume a guaranteed response or fix date before a maintainer confirms it.

## Supported fixes and automation

Security fixes are evaluated against the latest published stable release and
current main. Older versions may need to upgrade; a separate long-term support
policy is not currently promised.

Publicly misfiled reports must not be summarized by ordinary AI replies,
copied into CI artifacts or included in stale-issue processing. Maintainers
will establish a private channel and address exposed content as appropriate.

Repository collaboration automation is separate from the local SFL product.
An approved external model may receive sanitized public issue/PR context only;
it must never receive user Library data, credentials or private reports.
See [GitHub automation configuration](docs/GITHUB_AUTOMATION.md).
