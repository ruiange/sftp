# SFTP / FTP Uploader

在 VS Code 中直接把工作区文件上传到 SFTP、FTP 或 FTPS 服务器。插件保留本地目录结构，适合网站发布、测试环境同步和轻量部署。

## 功能

- 支持 SFTP、FTP、显式 FTPS 和隐式 FTPS。
- 支持上传当前文件、资源管理器中的文件/目录、多选资源及整个工作区。
- 支持多个上传环境并可从状态栏快速切换。
- 提供可视化配置页面，可新增、删除、重命名环境并直接测试连接。
- 在 VS Code 最左侧提供独立传输菜单，可查看当前环境并快速执行上传操作。
- 支持保存文件时自动上传。
- 登录方式简化为密码登录和 SFTP 密钥登录，密码支持环境变量。
- 每个环境可配置项目上传目录和远程目录，并按两者的根路径进行映射。
- 左侧“远程文件”视图可浏览当前环境的服务器目录，并支持删除远程文件或目录。
- 提供连接测试、可取消的上传进度和独立输出日志。

## 快速开始

1. 打开命令面板，执行 `SFTP / FTP: 初始化配置`。
2. 在自动打开的配置页面中填写服务器信息并保存，也可以点击“原始 JSON”直接编辑配置文件。
3. 在配置页面测试连接成功后，在资源管理器中右键文件或目录，选择 `SFTP / FTP` → `上传文件或目录`。

`localPath` 是当前项目内的上传目录，`remotePath` 是对应的服务器目录。例如 `localPath` 为 `dist`、`remotePath` 为 `/var/www/site` 时，本地文件 `dist/assets/app.js` 会上传到 `/var/www/site/assets/app.js`。需要上传整个项目时，将 `localPath` 设置为 `.`。

## SFTP 登录方式

SFTP 提供两种明确的登录方式，在配置页面中二选一。

### 密码登录

```json
{
  "defaultProfile": "production",
  "profiles": {
    "production": {
      "protocol": "sftp",
      "host": "server.example.com",
      "port": 22,
      "username": "deploy",
      "authType": "password",
      "password": "${env:SFTP_PASSWORD}",
      "localPath": "dist",
      "remotePath": "/var/www/site",
      "uploadOnSave": false
    }
  }
}
```

### 密钥登录

```json
{
  "protocol": "sftp",
  "host": "server.example.com",
  "port": 22,
  "username": "deploy",
  "authType": "privateKey",
  "privateKeyPath": "~/.ssh/id_rsa",
  "passphrase": "${env:SFTP_KEY_PASSPHRASE}",
  "localPath": "dist",
  "remotePath": "/var/www/site"
}
```

`passphrase` 只在私钥本身设置了口令时填写。

## FTP / FTPS 配置

```json
{
  "defaultProfile": "ftp-production",
  "profiles": {
    "ftp-production": {
      "protocol": "ftp",
      "host": "ftp.example.com",
      "port": 21,
      "username": "ftp-user",
      "authType": "password",
      "password": "${env:FTP_PASSWORD}",
      "localPath": "dist",
      "remotePath": "/public_html",
      "secure": true,
      "rejectUnauthorized": true,
      "uploadOnSave": false
    }
  }
}
```

`secure` 的取值：

- `false`：普通 FTP。
- `true`：显式 FTPS。
- `"implicit"`：隐式 FTPS，通常使用 990 端口。

## 多环境

`profiles` 中可以配置任意数量的环境。执行 `SFTP / FTP: 切换上传环境`，或点击状态栏中的环境名称即可切换。当前选择会按工作区保存。

```json
{
  "defaultProfile": "test",
  "profiles": {
    "test": {
      "protocol": "sftp",
      "host": "test.example.com",
      "username": "deploy",
      "authType": "password",
      "password": "${env:TEST_SFTP_PASSWORD}",
      "localPath": "dist",
      "remotePath": "/var/www/test"
    },
    "production": {
      "protocol": "sftp",
      "host": "prod.example.com",
      "username": "deploy",
      "authType": "privateKey",
      "privateKeyPath": "~/.ssh/prod_deploy",
      "localPath": "dist",
      "remotePath": "/var/www/production"
    }
  }
}
```

## 忽略规则

根级 `ignore` 对所有环境生效，环境内的 `ignore` 仅对当前环境生效，两者会合并。规则相对于 `localPath`，使用 glob 语法；以 `!` 开头的后置规则可以重新包含此前忽略的路径。

插件默认忽略 Git、SVN、Mercurial 元数据、`node_modules`、系统缩略图和自身连接配置，并始终跳过符号链接。

## 远程文件

点击 VS Code 最左侧的 SFTP / FTP 图标，在“远程文件”视图中可以从当前环境的 `remotePath` 开始浏览服务器目录。文件夹按需展开，文件会显示大小和修改时间。

鼠标悬停在远程文件或目录上时，可以点击删除按钮，也可以通过右键菜单选择“删除远程文件或目录”。删除文件前会弹出确认提示；删除目录时会明确提示该目录及其全部内容将被递归删除。配置的 `remotePath` 根目录本身不允许删除。

## 命令

- `SFTP / FTP: 上传文件或目录`
- `SFTP / FTP: 上传当前文件`
- `SFTP / FTP: 上传整个工作区`
- `SFTP / FTP: 初始化配置`
- `SFTP / FTP: 打开配置页面`
- `SFTP / FTP: 编辑原始 JSON 配置`
- `SFTP / FTP: 切换上传环境`
- `SFTP / FTP: 测试当前连接`
- `SFTP / FTP: 显示上传日志`
- `SFTP / FTP: 刷新远程目录`
- `SFTP / FTP: 删除远程文件或目录`

打包产物统一生成在项目的 `release/` 目录中，文件名格式为 `sftp-ftp-uploader-版本号.vsix`。

## 安全建议

不要把真实密码或私钥提交到代码仓库。优先使用 `${env:变量名}` 引用系统环境变量，并确保 `.vscode/sftp-sync.json` 不会被提交。FTPS 默认校验证书；只应在完全了解风险时关闭 `rejectUnauthorized`。
