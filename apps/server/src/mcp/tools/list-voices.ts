/** MCP Tool: voice_list（规范第 12 节）。按 conversation_id / message_id / 时间范围查询。
 *  R3″（2026-10-24，RE-16 返修）：整页 ≤8192B（已批唯一总页预算；不再自创 8192×5 之门）——
 *  limit 是上限不是必须塞满；按序列化字节装填可消费页，装不下的留 next_cursor 续读；
 *  坏游标/换过滤器=INVALID_CURSOR（isError，不静默当首页）；游标带快照上界（签发后
 *  同毫秒插入不进进行中的翻页）。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FieldDecryptionError, InvalidCursorError, encodeListCursor, listQueryFingerprint } from '@siren/storage';
import { voiceListInputSchema } from '@siren/contracts';
import { assetListModelView } from '../asset-model-view.ts';
import type { Logger } from '@siren/telemetry';
import type { VoiceService } from '@siren/voice-core';

/** 已批准的模型面总页预算（紧凑 JSON UTF-8 字节；调整须附真实前后样本） */
export const VOICE_LIST_PAGE_BUDGET_BYTES = 8192;

export function registerListVoicesTool(server: McpServer, deps: { voice: VoiceService; logger: Logger }): void {
  server.registerTool(
    'voice_list',
    {
      title: 'Voice List',
      description: '查询语音消息列表，支持 conversation_id / message_id / from / to / limit。',
      inputSchema: {
        conversation_id: voiceListInputSchema.shape.conversation_id,
        message_id: voiceListInputSchema.shape.message_id,
        from: voiceListInputSchema.shape.from,
        to: voiceListInputSchema.shape.to,
        limit: voiceListInputSchema.shape.limit,
        cursor: voiceListInputSchema.shape.cursor
      }
    },
    async (args) => {
      const parsed = voiceListInputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_input', details: parsed.error.issues }) }]
        };
      }
      try {
        const filter = {
          conversationId: parsed.data.conversation_id,
          messageId: parsed.data.message_id,
          fromMs: parsed.data.from ? Date.parse(parsed.data.from) : undefined,
          toMs: parsed.data.to ? Date.parse(parsed.data.to) : undefined
        };
        const pageSize = parsed.data.limit ?? 50;
        const fingerprint = listQueryFingerprint(filter);
        // 快照上界：无游标（首页签发）=当前 MAX(rowid)；带游标由仓储校验 q 与 r
        const snapshotCeiling = deps.voice.listSnapshotCeiling();
        const { items } = await deps.voice.listVoiceMessages({
          ...filter,
          limit: pageSize,
          cursor: parsed.data.cursor
        });
        deps.logger.info('mcp_tool_called', { tool: 'voice_list', count: items.length });
        // 按序列化字节装填：单条恒可入页（列表项摘录 ≤120 字）；预算含包装与游标本体，
        // 超限回退最后一条（页内至少 1 条），剩余走 next_cursor
        const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
        const moreMayExist = (count: number): boolean => count === pageSize || count < items.length;
        const buildPage = (count: number): { payload: string; total: number; nextCursor?: string } => {
          const emitted = items.slice(0, count).map((i) => assetListModelView(i));
          const last = items[Math.min(count, items.length) - 1];
          const nextCursor = moreMayExist(count) && last ? encodeListCursor({ c: last.createdAt, i: last.id, r: snapshotCeiling, q: fingerprint }) : undefined;
          const payload = JSON.stringify({ items: emitted, ...(nextCursor ? { next_cursor: nextCursor } : {}) });
          return { payload, total: bytesOf(JSON.parse(payload)), nextCursor };
        };
        let count = Math.min(items.length, pageSize);
        let page = buildPage(count);
        while (page.total > VOICE_LIST_PAGE_BUDGET_BYTES && count > 1) {
          count -= 1;
          page = buildPage(count);
        }
        if (page.total > VOICE_LIST_PAGE_BUDGET_BYTES) {
          deps.logger.warn('mcp_projection_over_budget', { tool: 'voice_list', bytes: page.total });
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'projection_over_budget', bytes: page.total }) }] };
        }
        return { content: [{ type: 'text', text: page.payload }] };
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'INVALID_CURSOR', message: error.message }) }] };
        }
        if (error instanceof FieldDecryptionError) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'data_unreadable' }) }] };
        }
        throw error;
      }
    }
  );
}
