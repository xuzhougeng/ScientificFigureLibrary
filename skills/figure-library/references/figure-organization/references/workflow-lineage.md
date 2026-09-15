# Workflow Map And Data Lineage

Use this reference when code organization depends on script order, generated artifacts, or downstream dependencies.

## Workflow Map

`workflow_map.md` is script-centered:

```markdown
## scripts/03-trajectory/04-lineage_choice.R

- purpose:
- input:
- output:
- figure:
- downstream:
- status:
```

It helps humans and AI understand execution order without rereading every script.

## Data Lineage

`data_lineage.md` is artifact-centered:

```markdown
## result/03-trajectory/04-lineage_choice/04-lineage_choice.seurat.qs

- generated_by:
- input:
- key_params:
- status:
- commit:
```

Record formal outputs and important intermediate objects. Do not document every temporary file.

Document expensive checkpoints when downstream scripts rely on them. A checkpoint is any intermediate result saved to avoid costly recomputation, especially after slow model fitting, integration, imputation, graph construction, format conversion, or external-tool execution.

For expensive checkpoints, include enough information to decide whether the file can be reused:

```markdown
## result/<stage>/<script-id-action>/<checkpoint-file>

- generated_by:
- input:
- key_params:
- expensive_step:
- downstream:
- status:
- commit:
```

## Status Labels

Use a compact vocabulary:

```text
active
stable
exploratory
deprecated
legacy
rejected
```

The user or project owner decides status. AI should not promote exploratory outputs to stable without confirmation.
