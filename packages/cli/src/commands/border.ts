/**
 * border 命令 - 打开网页并为所有元素加上边框
 *
 * 用法：
 *   bb-browser border <url>                # 在新 tab 中打开并加边框
 *   bb-browser border <url> --tab current  # 在当前 tab 中打开并加边框
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface BorderOptions {
  json?: boolean;
  tab?: string;
  tabId?: string | number;
}

/**
 * 为所有元素加上边框的 JavaScript 脚本
 * - 使用 outline 而非 border，避免影响页面布局
 * - 不同层级使用不同颜色，便于区分结构
 */
const BORDER_SCRIPT = `
(() => {
  const colors = [
    'red', 'blue', 'green', 'orange', 'purple',
    'cyan', 'magenta', 'yellow', 'lime', 'pink'
  ];
  const all = document.querySelectorAll('*');
  all.forEach((el, i) => {
    const depth = (() => {
      let d = 0, node = el;
      while (node.parentElement) { d++; node = node.parentElement; }
      return d;
    })();
    el.style.outline = '1px solid ' + colors[depth % colors.length];
  });
  return 'Added borders to ' + all.length + ' elements';
})()
`.trim();

export async function borderCommand(
  url: string | undefined,
  options: BorderOptions = {}
): Promise<void> {
  await ensureDaemonRunning();

  // 如果提供了 URL，先打开网页
  if (url) {
    let normalizedUrl = url;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      normalizedUrl = "https://" + url;
    }

    const openRequest: Request = {
      id: generateId(),
      action: "open",
      url: normalizedUrl,
    };

    if (options.tab !== undefined) {
      if (options.tab === "current") {
        (openRequest as Record<string, unknown>).tabId = "current";
      } else {
        const tabId = parseInt(options.tab, 10);
        if (isNaN(tabId)) {
          throw new Error(`无效的 tabId: ${options.tab}`);
        }
        (openRequest as Record<string, unknown>).tabId = tabId;
      }
    }

    const openResponse: Response = await sendCommand(openRequest);

    if (!openResponse.success) {
      if (options.json) {
        console.log(JSON.stringify(openResponse, null, 2));
      } else {
        console.error(`错误: ${openResponse.error}`);
      }
      process.exit(1);
    }

    // 记录打开的 tabId，后续 eval 使用同一 tab
    if (openResponse.data?.tabId) {
      options.tabId = openResponse.data.tabId as string | number;
    }

    if (!options.json) {
      console.log(`已打开: ${openResponse.data?.url ?? normalizedUrl}`);
      if (openResponse.data?.title) {
        console.log(`标题: ${openResponse.data.title}`);
      }
    }
  }

  // 注入边框脚本
  const evalRequest: Request = {
    id: generateId(),
    action: "eval",
    script: BORDER_SCRIPT,
    tabId: options.tabId,
  };

  const evalResponse: Response = await sendCommand(evalRequest);

  if (options.json) {
    console.log(JSON.stringify(evalResponse, null, 2));
  } else {
    if (evalResponse.success) {
      console.log(evalResponse.data?.result ?? "已为所有元素加上边框");
    } else {
      console.error(`错误: ${evalResponse.error}`);
      process.exit(1);
    }
  }
}
