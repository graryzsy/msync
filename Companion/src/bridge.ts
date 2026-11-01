import { createRequire } from "node:module";
import { execute, type API, type Request } from "./service.js";

// One JSON request through stdin, one response through stdout. Cookies never enter argv or logs.
async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 1_048_576) throw new Error("请求过大");
  }
  const request = JSON.parse(input) as Request;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  const api = createRequire(import.meta.url)("@neteasecloudmusicapienhanced/api") as API;
  process.stdout.write(JSON.stringify(await execute(request, api)));
}

main().catch(() => {
  // Upstream error objects may contain cookies/headers. Return no raw upstream diagnostics.
  process.stdout.write(JSON.stringify({ error: "网易云连接或数据读取失败，请检查登录、网络与辅助模块版本后重试" }));
  process.exitCode = 0;
});
