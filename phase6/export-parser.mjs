// Minimal, read-only adapter for ChatGPT's exported conversations.json.
// Works on local export objects. Never fetches account endpoints or evaluates content.

export function getExportConversations(input) {
  const conversations = Array.isArray(input) ? input : input?.conversations;
  if (!Array.isArray(conversations)) throw new TypeError('Expected conversations.json (array of conversations)');
  return conversations;
}

export function catalogConversations(input) {
  return getExportConversations(input)
    .map((c, index) => ({
      index,
      id: String(c.id ?? index),
      title: String(c.title || '无标题对话').slice(0, 160),
      updatedAt: Number(c.update_time || c.create_time || 0),
      graphSize: Object.keys(c.mapping || {}).length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function extractPart(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  const kind = String(part.content_type || part.type || '');
  if (kind.includes('image')) return '[图片附件，原型暂不渲染]';
  if (kind.includes('audio')) return '[音频附件，原型暂不渲染]';
  if (kind.includes('video')) return '[视频附件，原型暂不渲染]';
  return '[非文本内容，原型暂不渲染]';
}

export function extractMessageText(message) {
  const content = message?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content.parts)) return content.parts.map(extractPart).filter(Boolean).join('\n');
  if (typeof content.text === 'string') return content.text;
  if (typeof content.result === 'string') return content.result;
  return '';
}

export function extractConversation(conversation) {
  if (!conversation || typeof conversation !== 'object') throw new TypeError('Invalid conversation');
  const mapping = conversation.mapping || {};
  let nodeId = conversation.current_node;
  if (!nodeId || !mapping[nodeId]) {
    const entries = Object.entries(mapping);
    const latest = entries
      .filter(([, node]) => node?.message)
      .sort((a, b) => (Number(b[1].message?.create_time) || 0) - (Number(a[1].message?.create_time) || 0))[0];
    nodeId = latest?.[0];
  }
  const chain = [];
  const seen = new Set();
  while (nodeId && mapping[nodeId] && !seen.has(nodeId) && chain.length < 100000) {
    seen.add(nodeId);
    const node = mapping[nodeId];
    chain.push([nodeId, node]);
    nodeId = node.parent;
  }
  chain.reverse();

  const result = [];
  for (const [id, node] of chain) {
    const message = node.message;
    if (!message || message.metadata?.is_visually_hidden_from_conversation) continue;
    const role = message.author?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    // Tool-directed assistant calls are not visible conversation messages.
    if (message.recipient && message.recipient !== 'all') continue;
    const text = extractMessageText(message);
    if (!text) continue;
    result.push({ id: String(id), role, text });
  }
  return result;
}
