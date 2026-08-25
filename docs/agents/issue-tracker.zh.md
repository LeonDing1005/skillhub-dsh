# Issue 跟踪器：GitHub

[English](issue-tracker.md) | 中文

本工作区的 issue 和 spec 位于 GitHub 仓库 `LeonDing1005/skillhub-dsh`。

所有操作均使用 `gh` CLI，并始终传入 `--repo LeonDing1005/skillhub-dsh`；不要根据本工作区的 `origin` 推断仓库。

## 前置条件

- 安装 `gh`。
- 通过 `gh auth login` 完成认证。
- 确保该账号可以在目标仓库中创建 issue 和添加标签。

## 约定

- 创建：`gh issue create --repo LeonDing1005/skillhub-dsh ...`
- 读取：`gh issue view --repo LeonDing1005/skillhub-dsh <number> --comments`
- 列出：`gh issue list --repo LeonDing1005/skillhub-dsh ...`
- 评论、添加标签、编辑和关闭均使用对应的 `gh issue` 命令，并传入相同的显式 `--repo` 参数。
- 当技能要求“发布到 issue 跟踪器”时，创建一个 GitHub issue。
- 当技能要求“获取相关 ticket”时，读取对应的 GitHub issue 及其评论和标签。

## 将 Pull Request 作为分诊入口

将 PR 作为请求入口：否。
