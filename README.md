# SFTP / FTP Uploader

在 VS Code 中上传项目文件、管理远程目录和使用 SSH 终端。支持 SFTP、FTP 和 FTPS，可为测试和生产分别保存连接环境。

*以下截图使用示例连接。*

## 连接与目录映射

每个环境独立配置服务器、登录方式和部署目录。SFTP 支持密码和私钥登录，也可按环境设置排除规则和保存时自动上传。

![连接配置页，显示 SFTP 协议和登录方式](https://raw.githubusercontent.com/ruiange/sftp/7e64ae2f2621d6cd751142ae4ad29a5f84bd1ca3/docs/images/config-connection.png)

![映射配置页，显示本地目录与服务器部署目录的对应关系](https://raw.githubusercontent.com/ruiange/sftp/7e64ae2f2621d6cd751142ae4ad29a5f84bd1ca3/docs/images/config-mapping.png)

## 文件上传

传输控制面板支持上传整个映射目录或当前文件。资源管理器也支持上传选中的文件和目录。

![传输控制面板，显示示例环境和两个上传按钮](https://raw.githubusercontent.com/ruiange/sftp/50a7962e64316ad3c0f02e814cdcb8eeacf51529/docs/images/transfer-control.png)

## 远程文件

在部署目录和服务器根目录之间切换，浏览、预览、上传、替换和删除文件。部署目录支持新建、重命名和直接编辑。

![远程文件管理器，显示文件列表和预览区域](https://raw.githubusercontent.com/ruiange/sftp/7e64ae2f2621d6cd751142ae4ad29a5f84bd1ca3/docs/images/remote-files.png)

## SSH 终端

SSH 会话在编辑区独立打开。会话底部的「快捷命令」内置 12 条 Linux 查看命令，也支持保存常用命令到工作区。

![SSH 终端及底部的快捷命令输入区，已填入一条文件列表命令](https://raw.githubusercontent.com/ruiange/sftp/50a7962e64316ad3c0f02e814cdcb8eeacf51529/docs/images/ssh-quick-commands.png)
