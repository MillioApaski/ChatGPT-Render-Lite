import { getExportConversations, catalogConversations, extractConversation } from './export-parser.mjs';

const MAX_FILE_BYTES = 250 * 1024 * 1024;
let exportData = null;

self.addEventListener('message', async (event) => {
  const { type, file, index } = event.data || {};
  try {
    if (type === 'open') {
      if (!(file instanceof Blob)) throw new TypeError('请先选择 conversations.json');
      if (file.size > MAX_FILE_BYTES) {
        throw new RangeError('导出文件超过 250MB。原型为避免占满内存暂不加载。');
      }
      exportData = null;
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      getExportConversations(parsed);
      exportData = parsed;
      self.postMessage({ type: 'catalog', catalog: catalogConversations(exportData) });
      return;
    }
    if (type === 'conversation') {
      if (!exportData) throw new Error('请先打开 conversations.json');
      const all = getExportConversations(exportData);
      if (!Number.isInteger(index) || index < 0 || index >= all.length) {
        throw new RangeError('无效的会话序号');
      }
      const messages = extractConversation(all[index]);
      self.postMessage({
        type: 'messages',
        title: String(all[index].title || '无标题对话').slice(0, 160),
        messages,
      });
      return;
    }
    if (type === 'clear') {
      exportData = null;
      self.postMessage({ type: 'cleared' });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : '无法解析导出文件',
    });
  }
});
