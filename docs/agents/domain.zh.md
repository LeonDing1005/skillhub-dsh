# 领域文档

[English](domain.md) | 中文

本仓库使用单一领域上下文。

## 开始探索之前

- 阅读根目录的 [CONTEXT.md](../../CONTEXT.md)。
- 阅读 [`.agents/notes/`](../../.agents/notes/README.md) 下相关的活跃 Agent Note。
- 将 implemented Agent Note 视为已交付决策，将 proposed note 视为尚未交付的计划，将 rejected note 视为已否决的备选方案。
- 不要将 archived Agent Note 视为当前依据。
- 如果文件不存在，直接继续，无需提示。

## 词汇

在 issue、spec、接口、测试和实施说明中，严格使用 [CONTEXT.md](../../CONTEXT.md) 定义的术语。通过 domain-modeling 工作流解决真实的术语缺口，不要自行创造同义词。

## 决策

Agent Note 是本仓库的决策记录系统；不要建立平行的 ADR 层级。如果现有 implemented Agent Note 与当前工作冲突，应明确指出，而不是静默覆盖。
