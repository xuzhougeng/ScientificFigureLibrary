# Output Binding

Use this reference when scripts generate data, figures, reports, or other artifacts.

## Principle

Generated outputs should be traceable to the script that created them.

For data/analysis projects, prefer:

```text
script -> result directory -> figure directory
```

Example:

```text
scripts/03-trajectory/04-lineage_choice.R
result/03-trajectory/04-lineage_choice/
figure/03-trajectory/04-lineage_choice/
```

Files inside those directories should keep the script id:

```text
04-lineage_choice.seurat.qs
04-lineage_choice.lineage_table.tsv
04-lineage_choice.umap_lineage.pdf
```

## Directory Meanings

Use:

```text
data/      # external/raw input
result/    # generated data artifacts
figure/    # generated visual artifacts
output/    # legacy or broad output; avoid for new formal structure
tmp/       # disposable intermediate files
scratch/   # personal exploration
```

Prefer `result/` and `figure/` separation for new work.

## Expensive Intermediate Results

Some intermediate files are important enough to be formal outputs. If a step is computationally expensive or slow, save its result so downstream work does not repeatedly recompute it.

Examples include:

- integrated objects;
- dimensionality reductions;
- model fits;
- imputed matrices;
- metacell matrices;
- regulatory network outputs;
- large converted formats such as `.h5ad`, `.loom`, `.qs`, or `.rds`.

Store these under `result/<stage>/<script-id-action>/`, not `tmp/`, when they are intended for reuse.

Name them with the producing script id:

```text
result/02-grn/00-metacell/00-metacell.mc_mat.qs
result/03-trajectory/01-trajectory_dm/01-trajectory_dm.seurat.qs
```

The file itself usually stays out of git, but its existence and provenance should be recorded.

## Git Boundary

Generated result and figure files usually do not enter git. Track their meaning through docs:

- `workflow_map.md`
- `data_lineage.md`
- `PROJECT_LOG.md`

Only commit generated artifacts when they are small, intentional source fixtures or documentation assets.
