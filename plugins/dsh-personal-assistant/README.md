# DSH Personal Assistant

DeepSeek Harness 的本地个人助手插件，版本 `0.1.0-alpha.1`，MIT。适配 DSH `0.2.1-rc.5`，需要 Node.js `24.9` 以上版本。

支持长期记忆、跨项目经验关联、自动整理与撤回、日历与 ICS、任务执行、工具管理和微信入口。所有工作区共享记忆能力；对话使用 DSH 原生页面，“助手管理”提供业务管理界面。

模型和基础助手默认跟随 DSH。数据目录可浏览选择，普通对话归档默认保留 90 天，撤回默认保留 72 小时，均可调整。

微信直接扫码连接，凭据存入本机系统安全存储。迁移时导出业务目录，在新设备选择该目录并重新扫码。DSH 模型账户与外部工具依赖需另行配置。插件只在 DSH 运行期间工作，恢复后补处理。

源码与下载：[McLinWxl/dsh-personal-assistant](https://github.com/McLinWxl/dsh-personal-assistant)。依赖许可见 `THIRD_PARTY_NOTICES.md`。
