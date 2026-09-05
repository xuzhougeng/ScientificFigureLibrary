# Correctness and render review

Trace labels, colours, thresholds, groups and claims to their data definitions. Excluded observations must not contaminate included summaries. Mark missing values as missing, not zero. State replication units where summaries need them. Do not invent sample sizes or infer a causal mechanism from association.

Check comparability, axes and scaling. Diverging scales should use the meaningful reference point; changing an axis start can change interpretation. Do not hide such a change in a style fix. High/low support thresholds are conventions tied to the method, not universal truth.

Keep entity-to-colour bindings consistent. Verify contrast and distinguishability. Red/green references may need redundant shapes or labels; propose changes rather than silently violating reference fidelity. Respect template font/label roles; when unspecified use a compact, readable hierarchy. Do not sacrifice identifiers to an arbitrary label budget.

Render QA must inspect the actual saved image, including cropping, small labels, overlapping text, legends, leader endpoints, blank panels and colour ambiguity. A bounding-box collision is a finding to inspect, not proof every overlap is an error; intentional overlays, panel backgrounds and tick marks need context. Conversely, no detected overlap does not prove clarity.

Only report a check that actually ran. Stop and disclose unavailable tools/runtimes rather than claiming completed QA. Do not turn inspection into endless cosmetic revision; preserve correct panels unless a concrete defect or user request warrants changing them.
