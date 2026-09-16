# vendor/webxr-input-profiles

Pico 4 手柄的官方模型，从 [`@webxr-input-profiles/assets@1.0`](https://www.npmjs.com/package/@webxr-input-profiles/assets)
取下来放进库里（MIT）。2026-08-08 用户拍板引入，**它是本仓库第一批二进制资产**。
只装 `pico-4` 一套（左右各约 770KB）。

```
profiles/
  profilesList.json          ← 我们自己写的，与上游那份刻意不同
  pico-4/{profile.json, left.glb, right.glb}
```

⚠️ **动这个目录之前先读 `.claude/rules/手柄模型-vendor资产.md`。**

那里写着两件读代码得不出、而且"修好"了就会坏的事：`profilesList.json` 为什么**故意不收
`oculus-touch-v2`**（收了就拿到 Quest 2 的手柄，还不报错）、以及 `pico-phoenix → pico-4`
这行映射是在补上游缺的什么。加别的头显、以及为什么程序化手柄兜底不许删，也在那条 rule 里。
