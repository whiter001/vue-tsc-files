// 由 --require 预加载进被测进程，退出时把自身峰值 RSS 追加到 BENCH_RSS_FILE。
// 只覆盖这个进程自身的内存：wrapper 还会 spawn vue-tsc 子进程，那部分不在其中，
// 报告里必须写明，避免把两边的数字当成同口径比较。
const { appendFileSync } = require("node:fs");

process.on("exit", () => {
  const file = process.env.BENCH_RSS_FILE;
  if (!file) return;
  try {
    appendFileSync(file, `${process.resourceUsage().maxRSS}\n`);
  } catch {
    // 基准辅助文件写不进去就放弃测量，不干扰被测进程
  }
});
