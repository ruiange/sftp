# 项目协作规则

## 修改后启动

- 每次修改插件后，交付前都要启动 VS Code 扩展开发宿主。已有本项目的开发宿主时，重新加载该窗口，使它加载最新改动。
- TypeScript 有改动时，先执行启动所需的编译。启动入口使用 `.vscode/launch.json` 中的「运行 SFTP / FTP 插件」，或通过 VS Code CLI 的 `--extensionDevelopmentPath` 启动。额外测试、打包和发布按用户当次要求执行。
