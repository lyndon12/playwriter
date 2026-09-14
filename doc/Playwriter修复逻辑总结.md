# Playwriter 修复逻辑总结

## 一、问题现象

在当前登录的 Google Chrome 配置中，Playwriter 扩展可以安装，但点击后没有稳定连接。偶尔能够连接到本地中继服务，随后连接又被浏览器关闭。

切换到没有登录账号的 Chrome 配置时，扩展表现相对正常。因此，最初怀疑是当前浏览器账号的缓存、配置或扩展环境造成了影响。

## 二、排查结论

目前没有证据表明 Google 账号数据本身损坏，也没有清理账号、Cookie 或缓存。结合 Chrome 153 的实际表现，问题更接近下面几个因素叠加：

1. Playwriter 使用 Manifest V3 Service Worker 作为后台进程。当前 Chrome 配置中，后台进程可能在 WebSocket 仍然使用时被回收，导致本地中继收到 `1001` 断开。
2. `chrome.storage`、`chrome.identity` 和 `chrome.debugger` 在浏览器启动或已有调试目标较多时，存在长时间不返回的情况。
3. 连接维护循环、旧 WebSocket 和新的连接尝试之间存在竞争，旧连接延迟关闭时可能影响新连接。
4. Chrome 153 的调试器目标清理流程可能进入 `DETACH_STALLED_IN_STOPPING` 状态。

因此，问题不只是“扩展版本太旧”，也不是简单重新安装就能稳定解决。未登录配置之所以更容易成功，主要是因为它的 Service Worker、调试目标和扩展环境更干净。

## 三、源码修改

### `code/extension/src/background.ts`

- 移除高熵 User-Agent 查询，避免浏览器识别 API 在启动阶段阻塞连接。
- 为 Storage、Identity 和 Debugger 相关异步操作增加超时与降级结果。
- 为连接尝试增加代次标识，避免旧的 WebSocket 连接覆盖新的连接。
- 为 WebSocket 增加定时保活，并在连接关闭时正确清理定时器。
- 为 `chrome.debugger.attach` 增加超时，避免点击扩展图标后一直卡住。
- 移除启动时容易触发 Chrome 153 调试器清理异常的重置逻辑。
- 对受限制的扩展页面清理增加有限等待时间，避免清理操作阻塞主连接流程。
- 增加 offscreen 文档创建逻辑，配合心跳尽量保持后台 Service Worker 可用。

### `code/extension/src/offscreen.ts`

- 增加每 2 秒发送一次的后台心跳消息。
- 复用现有 offscreen 文档机制，减少 Chrome 回收后台 Service Worker 的机会。

### `code/extension/manifest.json`

- 本地开发版本固定为 `0.0.126`。
- 后续只在本地修改源码、重新构建和重新加载，不需要每次增加版本号。

## 四、加载与验证

1. 从 GitHub 获取 Playwriter 源码，并将项目代码整理到 `code/`。
2. 修改上述后台连接和 Service Worker 保活逻辑。
3. 构建本地扩展。
4. 在当前登录的 Chrome 中移除旧的本地加载版本，并重新加载本地扩展。
5. 重启本地 Playwriter 中继服务。
6. 点击扩展图标，确认显示 `Connected - Click to disconnect`。
7. 连续观察本地中继状态超过 30 秒，保持 `activeTargets=1`。
8. 使用实际 Playwriter 命令读取测试页面标题和 `h1` 内容，并通过 `page.evaluate` 写入页面属性，成功返回 `ok`。

## 五、当前结果

当前本地版本已经能够在原来的登录 Chrome 配置中稳定连接，并且已验证“读取网页内容”和“操纵网页内容”两类基本能力。

后续修改时，直接在 `code` 目录中改源码，从项目根目录重新构建后到 `chrome://extensions` 点击“重新加载”即可，不需要清理浏览器缓存，也不需要递增扩展版本号。
