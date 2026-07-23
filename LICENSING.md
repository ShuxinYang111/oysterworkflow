# OysterWorkflow Licensing / OysterWorkflow 许可证说明

OysterWorkflow uses a multi-license model: an Apache-2.0 open core and a
source-available desktop product under PolyForm Noncommercial 1.0.0. This
document defines the license boundary for this repository.

OysterWorkflow 采用多许可证模式：开放核心使用 Apache-2.0，桌面产品使用
PolyForm Noncommercial 1.0.0，以源码可见但限制商业使用的方式发布。本文件定义
仓库内各部分的许可证边界。

## At a Glance

| Scope                         | License                                                                 | Commercial use                                 |
| ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| Open-core files               | [Apache License 2.0](./LICENSE)                                         | Allowed under Apache-2.0                       |
| Desktop-product files         | [PolyForm Noncommercial 1.0.0](./legal/PolyForm-Noncommercial-1.0.0.md) | Requires a separate written commercial license |
| Third-party code and binaries | Their respective licenses                                               | Determined by each third-party license         |

GitHub identifies the repository as Apache-2.0 from the canonical root
`LICENSE` file. That repository-level label describes the default open-core
license; it does not override the PolyForm scopes listed below.

GitHub 会根据根目录中的标准 `LICENSE` 文件将仓库识别为 Apache-2.0。这个仓库级
标签表示默认的开放核心许可证，不会覆盖下方明确列出的 PolyForm 范围。

## Apache-2.0 Open-Core Scope

Unless a file is listed in the PolyForm or third-party scopes below, original
OysterWorkflow code, tests, documentation, configuration, plugins, and
integration code in this repository are licensed under Apache-2.0.

This includes the reusable workflow capture and extraction pipeline, ingest,
normalization, deduplication, segmentation, Screenpipe client, skill and
workflow-graph extraction, quality evaluation, harness generation, common
contracts, CLI utilities, and shared helpers that are outside the desktop
product scopes.

除下方 PolyForm 或第三方范围明确列出的文件外，本仓库中由 OysterWorkflow 原创的
代码、测试、文档、配置、插件和集成代码默认使用 Apache-2.0。开放核心包括可复用
的采集与提取管线、ingest、标准化、去重、分段、Screenpipe 客户端、skill 与工作流
图提取、质量评分、harness 生成、公共契约、CLI 工具及桌面产品范围之外的共享模块。

## PolyForm Desktop-Product Scope

The following paths are licensed under PolyForm Noncommercial 1.0.0, unless a
file contains a more specific license notice:

- `desktop/**`
- `ui/**`
- `src/cloud/**`
- `src/codex-workflow/**`
- `src/desktop-update/**`
- `src/lab-api/**`
- `src/observability/**`
- `src/product/**`
- `src/runtime/**`
- `src/cli/commands/oyster-browser.ts`
- `supabase/**`
- `brand/**`
- `assets/**`
- `oyster-demo-video/**`

These files may be viewed, used, modified, and distributed only for purposes
permitted by PolyForm Noncommercial 1.0.0. Commercial use requires a separate
written license from the OysterWorkflow copyright holder.

上述路径属于桌面产品及其产品服务、云端控制面、桌面运行时和品牌资产，除非文件中
另有更具体的许可证声明，否则均适用 PolyForm Noncommercial 1.0.0。用户只能在该
许可证允许的非商业用途内查看、使用、修改和分发；商业使用必须取得 OysterWorkflow
版权所有者的单独书面授权。

## Combined Desktop Distributions

An official OysterWorkflow desktop build is a multi-license distribution. The
Apache-2.0 open-core components remain Apache-2.0, the desktop-product components
remain PolyForm Noncommercial, and bundled third-party components retain their
own licenses. No component is relicensed merely because it is packaged with
another component.

官方 OysterWorkflow 桌面安装包属于多许可证组合发行物：Apache-2.0 开放核心仍为
Apache-2.0，桌面产品组件仍为 PolyForm Noncommercial，打包的第三方组件继续保留各自
许可证。任何组件都不会因为与其他组件一起打包而自动变更许可证。

## Third-Party Components

Dependencies, Git submodules, vendored code, Screenpipe, Hermes Agent, FFmpeg,
ffprobe, and other bundled third-party materials are not relicensed by this
document. See [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) and any license
files shipped with those components.

依赖项、Git submodule、vendor 代码、Screenpipe、Hermes Agent、FFmpeg、ffprobe
以及其他第三方材料不因本文件而重新授权。具体条款请查看
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) 及组件随附的许可证文件。

## Trademarks

Neither Apache-2.0 nor PolyForm grants permission to use OysterWorkflow names,
logos, icons, trade dress, or other brand identifiers in a way that suggests
endorsement or an official build. Descriptive references remain allowed as
provided by applicable law and license terms.

Apache-2.0 和 PolyForm 均不授予以暗示官方认可或冒充官方版本的方式使用
OysterWorkflow 名称、Logo、图标、产品外观或其他品牌标识的权利。法律和许可证允许
的描述性引用不受影响。

## Contributions and Commercial Licensing

Contributions follow the license of the target file or directory. Maintainers
may require a separate contributor agreement before accepting contributions to
PolyForm-covered desktop-product code so that official commercial licensing
remains possible.

贡献内容默认沿用目标文件或目录的许可证。对于 PolyForm 覆盖的桌面产品代码，维护者
可能在接受贡献前要求单独签署贡献者协议，以确保官方商业授权可以继续进行。

For commercial desktop-product licensing, contact `shuxin.y.97@gmail.com`.

如需桌面产品商业授权，请联系 `shuxin.y.97@gmail.com`。

This summary is intended to make the repository boundary explicit. The full
license texts and any file-specific notices control if there is a conflict.

本说明用于明确仓库内的许可证边界。如有冲突，以许可证完整文本和文件内更具体的声明
为准。
