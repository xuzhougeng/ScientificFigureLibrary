<!-- 本文件由 scripts/build-user-guide-index.mjs 从仓库内置目录元数据自动生成,请勿手工编辑。重新生成:npm run docs:index -->

# 图型索引:Open Figure Modules(自动生成)

[返回用户手册目录](../USER_GUIDE.zh-CN.md#4-图型索引按用途) · [返回本页目录](#目录)

## 快照信息

- 目录 schema:`figure-library.module-catalog.v1`
- Provider:`io.github.jarxunlai.personal-figures`(Open Figure Modules)
- 内容仓库:[jarxunlai/ScientificFigureLibrary-personal](https://github.com/jarxunlai/ScientificFigureLibrary-personal)
- 模块数量:36;覆盖的源 commit:`644ab1034ca3`、`7fa4e210e328`、`87c2f52459db`
- 元数据完整性:全部条目均有可用的预览图与缩略图文件

> 本页由内置目录快照生成。插件安装后会通过签名 feed 异步更新本地 overlay,远端可能已有新增或下架模块;以 SFL 搜索结果为准。

## 目录

- [`back_to_back_lollipop`](#back_to_back_lollipop)(1)
- [`benchmark_matrix`](#benchmark_matrix)(1)
- [`circular_umap`](#circular_umap)(1)
- [`clustered_heatmap_annotation`](#clustered_heatmap_annotation)(1)
- [`deg_heatmap_go_combo`](#deg_heatmap_go_combo)(1)
- [`enrichment_bar`](#enrichment_bar)(3)
- [`enrichment_bar_with_genes`](#enrichment_bar_with_genes)(1)
- [`enrichment_comet_facet`](#enrichment_comet_facet)(1)
- [`enrichment_comet_overlay`](#enrichment_comet_overlay)(1)
- [`faceted_horizontal_bar`](#faceted_horizontal_bar)(1)
- [`grouped_bar`](#grouped_bar)(2)
- [`grouped_deg_bar`](#grouped_deg_bar)(1)
- [`heatmap`](#heatmap)(1)
- [`mantel_corrplot`](#mantel_corrplot)(1)
- [`marker_dotplot`](#marker_dotplot)(1)
- [`pca`](#pca)(1)
- [`polar_bar`](#polar_bar)(1)
- [`ranked_nes_scatter`](#ranked_nes_scatter)(1)
- [`ridgeline_heatmap`](#ridgeline_heatmap)(1)
- [`sankey`](#sankey)(2)
- [`stacked_area`](#stacked_area)(1)
- [`stacked_bar`](#stacked_bar)(2)
- [`stacked_proportion_bar`](#stacked_proportion_bar)(1)
- [`umap_density`](#umap_density)(1)
- [`umap_ellipse`](#umap_ellipse)(1)
- [`umap_hulls`](#umap_hulls)(1)
- [`umap_in_situ_labels`](#umap_in_situ_labels)(1)
- [`umap_numbered_legend`](#umap_numbered_legend)(1)
- [`umap_square_axes`](#umap_square_axes)(1)
- [`umap_stroke`](#umap_stroke)(1)
- [`volcano_go_combo`](#volcano_go_combo)(1)

---

### back_to_back_lollipop

#### NC背靠背棒棒图（LHSC）（Nat Commun back-to-back lollipop plot）

**稳定标识:** `nc-backtoback-lollipop` · **分类:** `back_to_back_lollipop` · **语言:** R

[预览图](../../assets/personal-modules/previews/nc-backtoback-lollipop/preview.png) · [缩略图](../../assets/personal-modules/thumbs/nc-backtoback-lollipop.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/nc-backtoback-lollipop)

- **适用科研场景:** Compare marker scores for a selected cell type across two named cohorts.
- **输入数据要求:** Synthetic marker-level rows with celltype, group, marker, impact score, EC score, and specificity.（示例输入: `data/fig5.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "nc-backtoback-lollipop"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### benchmark_matrix

#### HLCA scIB 整合基准总表（HLCA scIB integration benchmark matrix）

**稳定标识:** `hlca-scib-integration-benchmark-matrix` · **分类:** `benchmark_matrix` · **语言:** R

[预览图](../../assets/personal-modules/previews/hlca-scib-integration-benchmark-matrix/preview.png) · [缩略图](../../assets/personal-modules/thumbs/hlca-scib-integration-benchmark-matrix.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/hlca-scib-integration-benchmark-matrix)

- **适用科研场景:** Compare batch-correction and biological-conservation metrics across integration methods and preprocessing settings.
- **输入数据要求:** A newly generated scIB-shaped metrics table used to demonstrate the weighted score display.（示例输入: `data/metrics_scgen_added.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "hlca-scib-integration-benchmark-matrix"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### circular_umap

#### 环形Circos风格UMAP（Circular circos-style UMAP）

**稳定标识:** `umap-style-plot1cell-circlize` · **分类:** `circular_umap` · **语言:** R

[预览图](../../assets/personal-modules/previews/umap-style-plot1cell-circlize/preview.png) · [缩略图](../../assets/personal-modules/thumbs/umap-style-plot1cell-circlize.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/umap-style-plot1cell-circlize)

- **适用科研场景:** Combine a central embedding with categorical rings and group composition arcs.
- **输入数据要求:** Synthetic UMAP coordinates with celltype and group columns.（示例输入: `data/example_umap.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "umap-style-plot1cell-circlize"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### clustered_heatmap_annotation

#### 差异基因聚类热图加GO和KEGG注释（Clustered DEG heatmap with GO and KEGG annotation）

**稳定标识:** `clustergvis-deg-go-kegg-combo` · **分类:** `clustered_heatmap_annotation` · **语言:** R

[预览图](../../assets/personal-modules/previews/clustergvis-deg-go-kegg-combo/preview.png) · [缩略图](../../assets/personal-modules/thumbs/clustergvis-deg-go-kegg-combo.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/clustergvis-deg-go-kegg-combo)

- **适用科研场景:** Present cluster-level expression patterns, marker genes, and pathway annotations in one composite panel.
- **输入数据要求:** Synthetic Z-score and pathway tables are bundled as reproducible example inputs for the plotting layer.（示例输入: `data/go_terms.csv`, `data/kegg_terms.csv`, `data/synthetic_zscore.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "clustergvis-deg-go-kegg-combo"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### deg_heatmap_go_combo

#### 差异表达热图加GO富集组合图（Combined DEG heatmap and GO enrichment panel）

**稳定标识:** `deg-heatmap-go-panel` · **分类:** `deg_heatmap_go_combo` · **语言:** R

[预览图](../../assets/personal-modules/previews/deg-heatmap-go-panel/preview.png) · [缩略图](../../assets/personal-modules/thumbs/deg-heatmap-go-panel.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/deg-heatmap-go-panel)

- **适用科研场景:** Present tissue annotations, differential states, module blocks, and pathway bars in one panel.
- **输入数据要求:** Three synthetic CSV inputs: cell annotations, gene-by-cell regulation states, and GO terms.（示例输入: `data/input_cell_annotation.csv`, `data/input_deg_heatmap.csv`, `data/input_go_enrichment.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "deg-heatmap-go-panel"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### enrichment_bar

#### KEGG变体条形图（蓝黄红柱内标签）（KEGG variant bar with blue-yellow-red inside labels）

**稳定标识:** `kegg-variant-blue-inside-label` · **分类:** `enrichment_bar` · **语言:** R

[预览图](../../assets/personal-modules/previews/kegg-variant-blue-inside-label/preview.png) · [缩略图](../../assets/personal-modules/thumbs/kegg-variant-blue-inside-label.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/kegg-variant-blue-inside-label)

- **适用科研场景:** Display ranked pathway enrichment with readable labels placed inside each bar.
- **输入数据要求:** Fifteen synthetic pathway descriptions with adjusted p-values.（示例输入: `data/kegg_top15.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "kegg-variant-blue-inside-label"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

#### KEGG变体条形图（前三白字）（KEGG variant bar with white-on-dark labels）

**稳定标识:** `kegg-variant-bw-text-classic` · **分类:** `enrichment_bar` · **语言:** R

[预览图](../../assets/personal-modules/previews/kegg-variant-bw-text-classic/preview.png) · [缩略图](../../assets/personal-modules/thumbs/kegg-variant-bw-text-classic.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/kegg-variant-bw-text-classic)

- **适用科研场景:** Compare ranked pathway enrichment while preserving high-contrast labels for the largest bars.
- **输入数据要求:** Fifteen synthetic pathway descriptions with adjusted p-values.（示例输入: `data/kegg_top15.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "kegg-variant-bw-text-classic"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

#### KEGG变体条形图（柱内通路名）（KEGG variant bar with inside-bar pathway labels）

**稳定标识:** `kegg-variant-inside-label-bar` · **分类:** `enrichment_bar` · **语言:** R

[预览图](../../assets/personal-modules/previews/kegg-variant-inside-label-bar/preview.png) · [缩略图](../../assets/personal-modules/thumbs/kegg-variant-inside-label-bar.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/kegg-variant-inside-label-bar)

- **适用科研场景:** Present ranked pathway enrichment in a minimal, label-forward bar layout.
- **输入数据要求:** Fifteen synthetic pathway descriptions with adjusted p-values.（示例输入: `data/kegg_top15.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "kegg-variant-inside-label-bar"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### enrichment_bar_with_genes

#### 单细胞富集分析条形图（通路+基因）（Single-cell enrichment bar plot with pathways and genes）

**稳定标识:** `single-cell-enrichment-bar-pathway-genes` · **分类:** `enrichment_bar_with_genes` · **语言:** R

[预览图](../../assets/personal-modules/previews/single-cell-enrichment-bar-pathway-genes/preview.png) · [缩略图](../../assets/personal-modules/thumbs/single-cell-enrichment-bar-pathway-genes.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/single-cell-enrichment-bar-pathway-genes)

- **适用科研场景:** Compare top enriched pathways across selected cell clusters with direct labels.
- **输入数据要求:** A long-form enrichment table with Cluster, Description, pvalue, geneID, and optional enrichment fields.（示例输入: `data/example.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** example_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "single-cell-enrichment-bar-pathway-genes"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### enrichment_comet_facet

#### 单细胞GO富集彗星图（分面）（Faceted GO enrichment comet plot）

**稳定标识:** `go-enrichment-comet-facet` · **分类:** `enrichment_comet_facet` · **语言:** R

[预览图](../../assets/personal-modules/previews/go-enrichment-comet-facet/preview.png) · [缩略图](../../assets/personal-modules/thumbs/go-enrichment-comet-facet.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/go-enrichment-comet-facet)

- **适用科研场景:** Show cluster-specific pathway enrichment with independent facet scales and count labels.
- **输入数据要求:** A fully synthetic long table with Cluster, Description, Count, pvalue, and -log10(p) fields.（示例输入: `data/enrichment_comet.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "go-enrichment-comet-facet"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### enrichment_comet_overlay

#### 单细胞GO富集彗星图（叠加）（Overlay GO enrichment comet plot）

**稳定标识:** `go-enrichment-comet-combined` · **分类:** `enrichment_comet_overlay` · **语言:** R

[预览图](../../assets/personal-modules/previews/go-enrichment-comet-combined/preview.png) · [缩略图](../../assets/personal-modules/thumbs/go-enrichment-comet-combined.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/go-enrichment-comet-combined)

- **适用科研场景:** Compare enrichment strength and contributing-gene counts for several cell clusters on a shared axis.
- **输入数据要求:** A fully synthetic long table with Cluster, Description, Count, pvalue, and -log10(p) fields.（示例输入: `data/enrichment_comet.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "go-enrichment-comet-combined"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### faceted_horizontal_bar

#### 分组水平条形细胞比例图（Faceted horizontal bars of cell-type proportions）

**稳定标识:** `sc-celltype-grouped-horizontal-bar` · **分类:** `faceted_horizontal_bar` · **语言:** R

[预览图](../../assets/personal-modules/previews/sc-celltype-grouped-horizontal-bar/preview.png) · [缩略图](../../assets/personal-modules/thumbs/sc-celltype-grouped-horizontal-bar.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/87c2f52459db24cb78af73ddbbadc1bc6ce0f3ea/modules/sc-celltype-grouped-horizontal-bar)

- **适用科研场景:** Compare cell-type proportions between groups with side-by-side horizontal facets.
- **输入数据要求:** A sample-level long table with Sample_ID, Group, celltype, and n. All distributed values are newly generated synthetic examples.（示例输入: `data/example-counts-csv.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "sc-celltype-grouped-horizontal-bar"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### grouped_bar

#### 分组细胞绝对数 dodge 柱状图（Grouped dodged bars of absolute cell counts）

**稳定标识:** `sc-celltype-grouped-dodge-count` · **分类:** `grouped_bar` · **语言:** R

[预览图](../../assets/personal-modules/previews/sc-celltype-grouped-dodge-count/preview.png) · [缩略图](../../assets/personal-modules/thumbs/sc-celltype-grouped-dodge-count.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/87c2f52459db24cb78af73ddbbadc1bc6ce0f3ea/modules/sc-celltype-grouped-dodge-count)

- **适用科研场景:** Compare aggregate absolute cell counts between groups for each cell type.
- **输入数据要求:** A sample-level long table with Sample_ID, Group, celltype, and n. All distributed values are newly generated synthetic examples.（示例输入: `data/example-counts-csv.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "sc-celltype-grouped-dodge-count"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

#### 样本细胞绝对数 dodge 柱状图（Sample-level dodged bars of absolute cell counts）

**稳定标识:** `sc-celltype-sample-dodge-count` · **分类:** `grouped_bar` · **语言:** R

[预览图](../../assets/personal-modules/previews/sc-celltype-sample-dodge-count/preview.png) · [缩略图](../../assets/personal-modules/thumbs/sc-celltype-sample-dodge-count.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/87c2f52459db24cb78af73ddbbadc1bc6ce0f3ea/modules/sc-celltype-sample-dodge-count)

- **适用科研场景:** Compare absolute cell counts at sample level, faceted by group.
- **输入数据要求:** A sample-level long table with Sample_ID, Group, celltype, and n. All distributed values are newly generated synthetic examples.（示例输入: `data/example-counts-csv.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "sc-celltype-sample-dodge-count"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### grouped_deg_bar

#### Nature风格分组DEG条形图（Nature-style grouped DEG bar plot）

**稳定标识:** `nature-deg-grouped-barplot` · **分类:** `grouped_deg_bar` · **语言:** R

[预览图](../../assets/personal-modules/previews/nature-deg-grouped-barplot/preview.png) · [缩略图](../../assets/personal-modules/thumbs/nature-deg-grouped-barplot.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/nature-deg-grouped-barplot)

- **适用科研场景:** Compare differential-gene counts across three time points and cell-type groups.
- **输入数据要求:** Synthetic cell-type rows with SNI_3day, SNI_3week, SNI_3month, and Group columns.（示例输入: `data/DEGs.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "nature-deg-grouped-barplot"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### heatmap

#### Cancer Cell通路NES热图（Cancer Cell pathway NES heatmap）

**稳定标识:** `cancercell-pathway-nes-heatmap` · **分类:** `heatmap` · **语言:** R

[预览图](../../assets/personal-modules/previews/cancercell-pathway-nes-heatmap/preview.png) · [缩略图](../../assets/personal-modules/thumbs/cancercell-pathway-nes-heatmap.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/cancercell-pathway-nes-heatmap)

- **适用科研场景:** Compare pathway NES values across A–D subtypes with category annotations and significance marks.
- **输入数据要求:** A pathway table with Pathway, Category, A, B, C, D, and significance-marker columns.（示例输入: `data/pathway_nes.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "cancercell-pathway-nes-heatmap"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### mantel_corrplot

#### Science风格Mantel网络相关热图（Science-style Mantel network correlation heatmap）

**稳定标识:** `science-mantel-corrplot` · **分类:** `mantel_corrplot` · **语言:** R

[预览图](../../assets/personal-modules/previews/science-mantel-corrplot/preview.png) · [缩略图](../../assets/personal-modules/thumbs/science-mantel-corrplot.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/science-mantel-corrplot)

- **适用科研场景:** Relate environmental variables to grouped composition blocks with a compact network overlay.
- **输入数据要求:** Two synthetic numeric tables: a composition matrix and an environmental-variable matrix.（示例输入: `data/varechem.csv`, `data/varespec.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "science-mantel-corrplot"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### marker_dotplot

#### 单细胞marker气泡图加突出框（scRNA marker dotplot with highlight boxes）

**稳定标识:** `sc-marker-dotplot-highlight-boxes` · **分类:** `marker_dotplot` · **语言:** R

[预览图](../../assets/personal-modules/previews/sc-marker-dotplot-highlight-boxes/preview.png) · [缩略图](../../assets/personal-modules/thumbs/sc-marker-dotplot-highlight-boxes.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/sc-marker-dotplot-highlight-boxes)

- **适用科研场景:** Compare marker expression across named cell clusters while emphasizing selected cluster blocks.
- **输入数据要求:** A DotPlot-style table with avg.exp, pct.exp, features.plot, id, and avg.exp.scaled columns.（示例输入: `data/dotplot_dt.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "sc-marker-dotplot-highlight-boxes"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### pca

#### Nature风格四分组PCA（Nature-style four-group PCA）

**稳定标识:** `nature-metabolome-style-pca` · **分类:** `pca` · **语言:** R

[预览图](../../assets/personal-modules/previews/nature-metabolome-style-pca/preview.png) · [缩略图](../../assets/personal-modules/thumbs/nature-metabolome-style-pca.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/nature-metabolome-style-pca)

- **适用科研场景:** Show group separation and sample labels in a clean PCA panel.
- **输入数据要求:** Synthetic sample-level coordinates with sample, group, PC1, and PC2 columns.（示例输入: `data/pca_df.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "nature-metabolome-style-pca"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### polar_bar

#### 南丁格尔玫瑰细胞构成图（Nightingale rose chart of cell composition）

**稳定标识:** `sc-celltype-nightingale-rose` · **分类:** `polar_bar` · **语言:** R

[预览图](../../assets/personal-modules/previews/sc-celltype-nightingale-rose/preview.png) · [缩略图](../../assets/personal-modules/thumbs/sc-celltype-nightingale-rose.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/87c2f52459db24cb78af73ddbbadc1bc6ce0f3ea/modules/sc-celltype-nightingale-rose)

- **适用科研场景:** Display per-sample cell-type proportions as faceted polar stacked bars.
- **输入数据要求:** A sample-level long table with Sample_ID, Group, celltype, and n. All distributed values are newly generated synthetic examples.（示例输入: `data/example-counts-csv.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "sc-celltype-nightingale-rose"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### ranked_nes_scatter

#### GSEA打分排序图（Ranked GSEA NES scatter）

**稳定标识:** `hallmark-gsea-nes-ranked-scatter` · **分类:** `ranked_nes_scatter` · **语言:** R

[预览图](../../assets/personal-modules/previews/hallmark-gsea-nes-ranked-scatter/preview.png) · [缩略图](../../assets/personal-modules/thumbs/hallmark-gsea-nes-ranked-scatter.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/hallmark-gsea-nes-ranked-scatter)

- **适用科研场景:** Show ranked pathway NES values with point size and transparency encoding.
- **输入数据要求:** A pathway table with ID, NES, setSize, and pvalue columns.（示例输入: `data/example_gsea.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "hallmark-gsea-nes-ranked-scatter"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### ridgeline_heatmap

#### HOX前后轴山脊图加热图（HOX A-P ridgeline with average-expression heatmap）

**稳定标识:** `ncb-fig2d-hox-ridge-heatmap` · **分类:** `ridgeline_heatmap` · **语言:** R

[预览图](../../assets/personal-modules/previews/ncb-fig2d-hox-ridge-heatmap/preview.png) · [缩略图](../../assets/personal-modules/thumbs/ncb-fig2d-hox-ridge-heatmap.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/ncb-fig2d-hox-ridge-heatmap)

- **适用科研场景:** Display spatial expression trends along an anterior-posterior axis for HOX groups.
- **输入数据要求:** A synthetic gene-by-position CSV with one expression value for each AP layer.（示例输入: `data/panel-d.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "ncb-fig2d-hox-ridge-heatmap"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### sankey

#### ggsankeyfier 桑基图布局、配色与组合（ggsankeyfier Sankey layout, color, and combo）

**稳定标识:** `ggsankeyfier-layout-color-combo` · **分类:** `sankey` · **语言:** R

[预览图](../../assets/personal-modules/previews/ggsankeyfier-layout-color-combo/preview.png) · [缩略图](../../assets/personal-modules/thumbs/ggsankeyfier-layout-color-combo.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/7fa4e210e3283efea0250e73b43e139c941b478b/modules/ggsankeyfier-layout-color-combo)

- **适用科研场景:** Use as a readable starting point for Sankey layout, node ordering, color mapping, and aligned pathway enrichment bubbles.
- **输入数据要求:** Five small synthetic CSV tables describe cell-class flows, habitat flows, multi-stage land-cover paths, metabolite-pathway links, and pathway enrichment bubbles.（示例输入: `data/brain_subclass_predict.csv`, `data/global_landcover_habitat.csv`, `data/intertidal_habitat.csv`, `data/metabolite_pathway_links.csv`, `data/pathway_enrichment.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "ggsankeyfier-layout-color-combo"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

#### 细胞类型到分组桑基图（Cell type to group Sankey）

**稳定标识:** `sc-celltype-sankey` · **分类:** `sankey` · **语言:** R

[预览图](../../assets/personal-modules/previews/sc-celltype-sankey/preview.png) · [缩略图](../../assets/personal-modules/thumbs/sc-celltype-sankey.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/87c2f52459db24cb78af73ddbbadc1bc6ce0f3ea/modules/sc-celltype-sankey)

- **适用科研场景:** Show aggregate flows from cell types to experimental groups with parallel-set ribbons.
- **输入数据要求:** A sample-level long table with Sample_ID, Group, celltype, and n. All distributed values are newly generated synthetic examples.（示例输入: `data/example-counts-csv.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "sc-celltype-sankey"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### stacked_area

#### 跨样本堆叠面积细胞构成图（Stacked area of cell composition across samples）

**稳定标识:** `sc-celltype-stacked-area` · **分类:** `stacked_area` · **语言:** R

[预览图](../../assets/personal-modules/previews/sc-celltype-stacked-area/preview.png) · [缩略图](../../assets/personal-modules/thumbs/sc-celltype-stacked-area.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/87c2f52459db24cb78af73ddbbadc1bc6ce0f3ea/modules/sc-celltype-stacked-area)

- **适用科研场景:** Show cell-type composition changes across ordered samples as a normalized stacked area chart.
- **输入数据要求:** A sample-level long table with Sample_ID, Group, celltype, and n. All distributed values are newly generated synthetic examples.（示例输入: `data/example-counts-csv.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "sc-celltype-stacked-area"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### stacked_bar

#### 分组堆叠柱状细胞构成图（Grouped 100% stacked bars of cell composition）

**稳定标识:** `sc-celltype-grouped-stacked-bar` · **分类:** `stacked_bar` · **语言:** R

[预览图](../../assets/personal-modules/previews/sc-celltype-grouped-stacked-bar/preview.png) · [缩略图](../../assets/personal-modules/thumbs/sc-celltype-grouped-stacked-bar.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/87c2f52459db24cb78af73ddbbadc1bc6ce0f3ea/modules/sc-celltype-grouped-stacked-bar)

- **适用科研场景:** Compare group-level cell composition with normalized stacked bars.
- **输入数据要求:** A sample-level long table with Sample_ID, Group, celltype, and n. All distributed values are newly generated synthetic examples.（示例输入: `data/example-counts-csv.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "sc-celltype-grouped-stacked-bar"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

#### 样本堆叠比例加总数柱状图（Sample stacked proportions with totals）

**稳定标识:** `sc-celltype-sample-stacked-proportion` · **分类:** `stacked_bar` · **语言:** R

[预览图](../../assets/personal-modules/previews/sc-celltype-sample-stacked-proportion/preview.png) · [缩略图](../../assets/personal-modules/thumbs/sc-celltype-sample-stacked-proportion.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/87c2f52459db24cb78af73ddbbadc1bc6ce0f3ea/modules/sc-celltype-sample-stacked-proportion)

- **适用科研场景:** Show per-sample cell-type proportions with sample totals and group facets.
- **输入数据要求:** A sample-level long table with Sample_ID, Group, celltype, and n. All distributed values are newly generated synthetic examples.（示例输入: `data/example-counts-csv.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "sc-celltype-sample-stacked-proportion"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### stacked_proportion_bar

#### Nature同款空转生态位堆积柱（Nature-style spatial niche stacked bar）

**稳定标识:** `nature-spatial-niche-stacked-bar` · **分类:** `stacked_proportion_bar` · **语言:** R

[预览图](../../assets/personal-modules/previews/nature-spatial-niche-stacked-bar/preview.png) · [缩略图](../../assets/personal-modules/thumbs/nature-spatial-niche-stacked-bar.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/nature-spatial-niche-stacked-bar)

- **适用科研场景:** Compare nine niche proportions across a sample series with a stable palette.
- **输入数据要求:** Long-form sample-by-niche proportions with patient, ctniche, and Proportion columns.（示例输入: `data/niche_proportions.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "nature-spatial-niche-stacked-bar"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### umap_density

#### 暗夜密度热力UMAP（Dark magma density UMAP）

**稳定标识:** `umap-style-density-heatmap` · **分类:** `umap_density` · **语言:** R

[预览图](../../assets/personal-modules/previews/umap-style-density-heatmap/preview.png) · [缩略图](../../assets/personal-modules/thumbs/umap-style-density-heatmap.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/umap-style-density-heatmap)

- **适用科研场景:** Show density hotspots and cluster boundaries in a single-cell embedding.
- **输入数据要求:** Synthetic cell-level coordinates with cell, UMAP_1, UMAP_2, celltype, and group columns.（示例输入: `data/example_umap.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "umap-style-density-heatmap"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### umap_ellipse

#### 半透明椭圆同色标签UMAP（UMAP with translucent ellipses and matching labels）

**稳定标识:** `umap-style-ellipse-labels` · **分类:** `umap_ellipse` · **语言:** R

[预览图](../../assets/personal-modules/previews/umap-style-ellipse-labels/preview.png) · [缩略图](../../assets/personal-modules/thumbs/umap-style-ellipse-labels.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/umap-style-ellipse-labels)

- **适用科研场景:** Show cluster shape and location while removing a separate legend.
- **输入数据要求:** Synthetic cell-level UMAP coordinates and cell-type labels.（示例输入: `data/example_umap.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "umap-style-ellipse-labels"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### umap_hulls

#### 单细胞UMAP大群虚线非凸包（UMAP with dashed non-convex hulls around main cell types）

**稳定标识:** `umap-unchull-main-type-circles` · **分类:** `umap_hulls` · **语言:** R

[预览图](../../assets/personal-modules/previews/umap-unchull-main-type-circles/preview.png) · [缩略图](../../assets/personal-modules/thumbs/umap-unchull-main-type-circles.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/umap-unchull-main-type-circles)

- **适用科研场景:** Show broad cell-type territories around subclusters in a synthetic embedding.
- **输入数据要求:** Synthetic cell-level coordinates with subcluster and main-cell-type columns.（示例输入: `data/example_umap.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "umap-unchull-main-type-circles"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### umap_in_situ_labels

#### 簇内直接标注UMAP（In-situ labelled UMAP）

**稳定标识:** `umap-style-scrnatoolvis-insitu` · **分类:** `umap_in_situ_labels` · **语言:** R

[预览图](../../assets/personal-modules/previews/umap-style-scrnatoolvis-insitu/preview.png) · [缩略图](../../assets/personal-modules/thumbs/umap-style-scrnatoolvis-insitu.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/umap-style-scrnatoolvis-insitu)

- **适用科研场景:** Place cell-type names in the embedding while retaining a small coordinate cue.
- **输入数据要求:** Synthetic cell-level UMAP coordinates and cell-type labels.（示例输入: `data/example_umap.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "umap-style-scrnatoolvis-insitu"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### umap_numbered_legend

#### 编号加侧边图例UMAP（Numbered UMAP with count legend）

**稳定标识:** `umap-style-scp-numbered-legend` · **分类:** `umap_numbered_legend` · **语言:** R

[预览图](../../assets/personal-modules/previews/umap-style-scp-numbered-legend/preview.png) · [缩略图](../../assets/personal-modules/thumbs/umap-style-scp-numbered-legend.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/umap-style-scp-numbered-legend)

- **适用科研场景:** Keep a dense embedding readable with compact numeric labels and counts.
- **输入数据要求:** Synthetic cell-level UMAP coordinates and cell-type labels.（示例输入: `data/example_umap.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "umap-style-scp-numbered-legend"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### umap_square_axes

#### 方形坐标轴UMAP（Square-axis labelled UMAP）

**稳定标识:** `umap-style-scp-square-axes` · **分类:** `umap_square_axes` · **语言:** R

[预览图](../../assets/personal-modules/previews/umap-style-scp-square-axes/preview.png) · [缩略图](../../assets/personal-modules/thumbs/umap-style-scp-square-axes.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/umap-style-scp-square-axes)

- **适用科研场景:** Present a compact, equal-aspect embedding with stable axis limits.
- **输入数据要求:** Synthetic cell-level UMAP coordinates and cell-type labels.（示例输入: `data/example_umap.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "umap-style-scp-square-axes"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### umap_stroke

#### 黑边颗粒风UMAP（Black-stroke granule UMAP）

**稳定标识:** `umap-style-scpubr-stroke` · **分类:** `umap_stroke` · **语言:** R

[预览图](../../assets/personal-modules/previews/umap-style-scpubr-stroke/preview.png) · [缩略图](../../assets/personal-modules/thumbs/umap-style-scpubr-stroke.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/umap-style-scpubr-stroke)

- **适用科研场景:** Emphasize point boundaries and preserve cluster identity in a dense embedding.
- **输入数据要求:** Synthetic cell-level UMAP coordinates and cell-type labels.（示例输入: `data/example_umap.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "umap-style-scpubr-stroke"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

### volcano_go_combo

#### 单细胞百分比差火山图加GO条形组合图（Percentage-difference volcano plot with GO bar chart combination）

**稳定标识:** `cell-fig2h-volcano-go-combo` · **分类:** `volcano_go_combo` · **语言:** R

[预览图](../../assets/personal-modules/previews/cell-fig2h-volcano-go-combo/preview.png) · [缩略图](../../assets/personal-modules/thumbs/cell-fig2h-volcano-go-combo.jpg) · [模块源码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/tree/644ab1034ca358f1584c2ec8666f1036f495f38e/modules/cell-fig2h-volcano-go-combo)

- **适用科研场景:** Show fold-change and percentage-difference signals beside a compact directional pathway panel.
- **输入数据要求:** Two example tables: DEG rows with fold-change/percentage fields and GO rows with direction and bar coordinates.（示例输入: `data/example_de.csv`, `data/example_go.csv`）
- **来源与许可:** jarxunlai/ScientificFigureLibrary-personal（Open Figure Modules 官方频道);代码 MIT,内容 CC BY 4.0,文档 CC BY 4.0
- **可复现性记录:** synthetic_data / passed;完整模块 ZIP 仅在通过 SFL materialize 获取时下载校验

调用示例(复制后替换路径):

```text
在 Scientific Figure Library 中搜索模板 "cell-fig2h-volcano-go-combo"(来源 Open Figure Modules)。
先给我预览,等我确认这张卡之后,再把该模板 materialize 到我指定的空文件夹,文件集用 template。
不要执行绘图代码;先和我确认数据怎么替换成我自己的。
```

[返回用户手册目录](../USER_GUIDE.zh-CN.md#4-图型索引按用途) · [返回本页目录](#目录)
