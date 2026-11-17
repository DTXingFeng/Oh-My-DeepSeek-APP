# 构建与开发

## 环境

Node.js 24、JDK 21、Android SDK Platform 35。项目包含 Gradle 8.11.1 Wrapper，使用 AGP 8.7.2。

运行需要 Android 8.0+ 及较新的 Android System WebView / Chrome（构建目标 Chromium 105+）。默认模型是 `deepseek-flash`，服务器是 `https://api.deepseek.com`，没有本项目运营的中转服务器。

## 构建 APK

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run type
npm run lint
npm run build

# 在 android/local.properties 写入本机路径，或配置 ANDROID_HOME
# sdk.dir=C:/Users/yourname/AppData/Local/Android/Sdk
cd android
.\gradlew.bat assembleDebug lintDebug
```

APK：`android/app/build/outputs/apk/debug/app-debug.apk`。这是开发调试签名，正式分发前需要自有签名密钥。GitHub Actions 会运行测试、构建和静态检查，保存 APK artifact。

开发网页：`npm run dev`，访问 `http://localhost:8090`。Android 构建自动将 `dist/` 同步到 APK 资源，不加载线上网页。

## 虚拟机检查

```powershell
adb connect 127.0.0.1:5555
adb -s 127.0.0.1:5555 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s 127.0.0.1:5555 shell am start -n app.ohmydeepseek.android/.MainActivity
node scripts/android-smoke.mjs
```

基础验收脚本只能用于**没有真实密钥、没有历史对话的调试安装**，使用本地模拟 SSE 响应验证客户端并清理自己的测试记录，不调用收费模型接口。可通过 `ANDROID_SERIAL` 指定虚拟机。它验证客户端行为，不能证明官方模型实际回答质量。

导入和记忆集成测试使用独立调试包，与主 App 数据隔离。构建和执行方式见 [验证记录](VALIDATION.md) 与 [记忆说明](MEMORY.md)。

## 数据存储

- Android 版 API Key 使用 AES-GCM 加密，解密密钥保存在 Android Keystore，网页 localStorage 不保存 API Key。系统云备份和设备迁移均排除应用数据。
- 首次在「设置 → 数据管理」填写 API Key 后，应用通过 `GET /models` 验证密钥，再保存。没有内置 API Key，历史导出和 APK 也不包含 API Key。
- 浏览器开发版沿用上游的 localStorage 密钥存储方式；Android 版使用原生加密存储。
- 对话和附件保存在应用私有 WebView 数据目录；记忆使用独立的本机数据库。发送、上传、搜索及语音功能会把所需内容发给 DeepSeek 官方服务。
- 聊天 ZIP 与记忆 JSON 分开备份。导入聊天历史会替换现有本地历史，应用会先显示确认；导入记忆会去重合并。

[返回项目介绍](../README.md)
