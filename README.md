# DSH Personal Assistant

DeepSeek Harness 的本地个人助手插件，MIT 许可证。支持长期记忆、跨项目经验关联、自动整理与撤回、日历和 ICS、任务执行、工具管理及微信入口。

对话使用 DSH 内置工作区和会话页面。所有工作区都可生成和召回记忆；“个人助手”工作区承接微信对话、任务与整理报告，“助手管理”提供业务管理界面。

## 安装

适配 DSH `0.2.1-rc.5`，需要 Node.js `24.9` 以上版本。当前版本为 `0.1.0-alpha.2`。

发布包位于 [GitHub Releases](https://github.com/McLinWxl/dsh-personal-assistant/releases)。在 DSH「插件 → 添加插件」中填入对应版本的 `dsh-personal-assistant.tgz` 下载链接。

本地构建安装：

```sh
npm ci --prefix plugins/dsh-personal-assistant
npm run check
npm run build
npm run check:package
npm pack ./plugins/dsh-personal-assistant --ignore-scripts
```

将生成的 `.tgz` 文件添加到 DSH。

## 使用

- 模型和基础助手默认跟随 DSH，目录可通过浏览选择。
- 普通对话归档默认保留 90 天，变更撤回默认保留 72 小时，均可调整。
- 微信点击“连接微信”后扫码；登录凭据保存在本机系统安全存储，新设备重新扫码。
- 迁移时导出业务目录，在新设备选择该目录。DSH 模型账户、外部工具依赖需另行配置。
- 插件在 DSH 运行期间工作，恢复运行后补处理。

源码位于 `plugins/dsh-personal-assistant/`。推送版本标签后，GitHub Actions 在 macOS、Windows 和 Linux 上完成构建与安装包校验，再生成 Release。
