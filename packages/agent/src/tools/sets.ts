import { askUserTool, reportTool } from './control';
import { fileEditTool, fileListTool, fileReadTool, fileWriteTool } from './files';
import { acceptTool, createPlanTool, finishTool, replanTool, reviseTool } from './planner';
import { shellTool } from './shell';
import type { Tool } from './tool';
import { browserClickTool, browserOpenTool, browserScrollTool, browserTypeTool, webSearchTool } from './web';

/** Инструменты исполнителя (спецификация 5.1). */
export const executorTools: readonly Tool[] = [
  shellTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileListTool,
  browserOpenTool,
  browserClickTool,
  browserTypeTool,
  browserScrollTool,
  webSearchTool,
  askUserTool,
  reportTool,
];

/** Планирование (спецификация 5.2): только create_plan плюс вопросы и чтение. */
export const planningTools: readonly Tool[] = [createPlanTool, askUserTool, fileReadTool, fileListTool];

/** Проверка (спецификация 4.1.4, 4.4): revise и replan — только пока не исчерпаны их лимиты. */
export function reviewTools(opts: { canRevise: boolean; canReplan: boolean }): readonly Tool[] {
  return [
    acceptTool,
    ...(opts.canRevise ? [reviseTool] : []),
    ...(opts.canReplan ? [replanTool] : []),
    finishTool,
    askUserTool,
    fileReadTool,
    fileListTool,
  ];
}
