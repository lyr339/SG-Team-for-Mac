/**
 * Shared user-facing reply policy for every Team Agent surface.
 * Keeping it centralized prevents launch prompts and MCP instructions drifting apart.
 */
export const TEAM_REPLY_STYLE_INSTRUCTION = [
  '用户可见回复默认控制在 1—4 句，先说结论，只补充发生变化的结果、风险或需要用户决定的事项。',
  '不要固定输出“当前结论 / 下一步 / 阻塞项”等章节，不要复述任务板、工具调用或 running/queued 等内部状态；没有阻塞就不要写“暂无”，用户明确要求详情时再展开。'
].join('')
