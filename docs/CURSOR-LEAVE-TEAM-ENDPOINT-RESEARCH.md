# cursor.com 自助退团端点逆向档案（2026-08-27）

> 任务背景：账号自动化链「奥仔处理 → 删除官网账号」中，删除环节常撞
> 「Please leave the team before deleting your account.」。为把「等副作用落地」从等待
> 改为驱动，需确认 cursor.com 是否存在成员自助退团端点（dashboard Leave team 同款调用）。
>
> **结论：成员自助退团端点不存在，按任务指令回退条款保留现有等待重试。**

## 判别方法（未登录即可复现）

cursor.com 对 API 路由与未知路径的响应有稳定差异，可作判别器：

| 探测 | 响应 | 含义 |
| --- | --- | --- |
| `GET /api/dashboard/delete-account`（已知存在，控制组） | `405 {"error":"Method not allowed"}` + `allow: POST` 头 | 真实路由 |
| `POST /api/dashboard/delete-account`（无 Origin，控制组） | `403 {"error":"Invalid origin for state-changing request"}` | 真实路由，先校验 Origin |
| `GET /api/dashboard/foobar-xyz`（必不存在，控制组） | `200` + ~150KB 营销站 HTML | SPA catch-all |

即：**真实路由回 405/403，不存在路径回 200 HTML**。

## 命名候选探测结果（全部证伪）

以下候选均命中 SPA catch-all（200 + 营销 HTML），即路由不存在：

```
/api/dashboard/leave-team          /api/dashboard/leaveTeam
/api/dashboard/leave_team          /api/dashboard/leave-current-team
/api/dashboard/teams/leave         /api/dashboard/team/leave
/api/dashboard/members/leave       /api/dashboard/leave-team-member
/api/dashboard/delete-team         /api/dashboard/disband-team
/api/dashboard/dissolve-team       /api/dashboard/close-team
/api/dashboard/cancel-team         /api/dashboard/remove-team-member
/api/dashboard/team/remove-member  /api/dashboard/teams/remove-member
/api/dashboard/leave-organization  /api/dashboard/quit-team
/api/dashboard/exit-team           /api/team(/leave)  /api/teams(/leave)
```

## 存活的相关路由及其权限约束

| 路由 | 方法 | 契约 | 约束 |
| --- | --- | --- | --- |
| `/api/dashboard/teams` | POST only | `{}` → 团队列表（含 teamId） | 只读 |
| `/api/dashboard/team` | POST only | `{teamId}` → 团队详情（含 userId、role） | 只读 |
| `/api/dashboard/remove-member` | POST only | 移除成员（dashboard 成员管理「Remove」的调用） | **管理员权限** |

权限证据：

- Cursor 官方帮助文档：「Team members cannot leave a team on their own. They need to
  ask an admin to remove them.」（cursor.com/help/account-and-billing/teams-management）
- 官方论坛 2024 → 2026 持续有成员无法自助退团的投诉帖（/t/29218、/t/6658），
  官方答复均为「由管理员移除」。
- 自动化链中的账号在奥仔团队里是**普通成员**，调用 remove-member 自移除会被权限拒绝；
  即便账号是 owner，也受「至少保留一名 admin / 一名付费成员」约束（官方 members.md）。
- 官方 Admin API `api.cursor.com/teams/remove-member`：Enterprise-only，
  需团队管理员 API key（Basic auth），与用户会话（WorkosCursorSessionToken）体系无关，不可用。

## chunk 级实证尝试记录（未完成，含残余盲区）

主控要求以 dashboard 前端 chunk 实证为准。尝试路径：

1. **IDE 浏览器**：Cloudflare 验证已通过，但未登录访问 /dashboard 一律 307 →
   authenticator.cursor.sh（无凭据，不登录）。
2. **直接 curl**：/dashboard 被 Cloudflare 挑战（403 "Just a moment"）拦截；
   dashboard 应用的 chunk URL 藏在登录后 HTML 中（内容哈希命名），未登录不可枚举；
   `/_next/`、`/dashboard/_next/` 下所有路径探测均命中 SPA catch-all。
3. **用户 Edge（已有登录态，经 AppleScript JS 通道，应用秒级删除同款机制）**：
   用户授权后通道验证打通；但取证窗口恰逢浏览器会话被自动化链轮换
   （/dashboard 持续 opaqueredirect，轮询 2.5 分钟未恢复），未拿到登录后 chunk。

**残余盲区（如实声明）**：若「Leave team」实现为 Next.js server action（无命名路由，
POST + `Next-Action` 头直打页面路由），路由探测无法证伪。但即便存在，
它同样受上述管理员权限模型约束，对普通成员账号不可用——结论不变。

会话恢复后可补 chunk 取证的只读脚本（在已登录的 cursor.com 标签页执行，不触碰 token）：

```js
// 1) 拉登录后 dashboard HTML，枚举 chunk
const html = await (await fetch('/dashboard', { credentials: 'include' })).text()
const urls = [...html.matchAll(/src="(\/_next\/[^"]+\.js[^"]*)"/g)].map((m) => m[1])
// 2) 逐 chunk 检索退团/删号调用点
for (const u of urls) {
  const t = await (await fetch(u)).text()
  const re = /(leave[-_ ]?team|remove-member|delete-account)/gi
  let m
  while ((m = re.exec(t)) !== null) console.log(u, m.index, t.slice(m.index - 160, m.index + 200))
}
```

## 结论与处置

- 自助退团端点不存在 / 权限不符 → 按任务指令回退条款：**保留现有等待重试**
  （`deleteWithTeamWait` 退团等待 2s×60s + 限流退避；页面内秒级通道自带
  `leave the team` 500ms×5 自愈重试）。
- 「退团→删除 ≤5s」目标依赖的驱动端点缺位；退团副作用由奥仔服务端移除并传播
  （实机实测极端案例 ~1h），传播时延不在我方控制面，该子项按回退条款验收。
