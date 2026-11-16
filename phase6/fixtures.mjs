const filler = '在真实的长对话里，历史消息长度不一致，包含段落、列表、代码以及较长的解释。这个原型只测量独立渲染层的成本，不执行原站的 React 或滚动事件。';
const code = `function calculate(a, b) {
  const list = Array.from({ length: a }, (_, i) => i * b);
  return list.reduce((sum, value) => sum + value, 0);
}`;

export function syntheticMessage(index, prefix = 'demo') {
  const role = index % 2 ? 'assistant' : 'user';
  const lines = index % 7 === 0 ? 18 : index % 5 === 0 ? 10 : index % 3 === 0 ? 5 : 2;
  const paragraphs = Array.from({ length: lines }, (_, j) =>
    j % 6 === 0 ? '- ' + filler : filler
  ).join('\n');
  const extra = index % 11 === 0 ? '\n\n```js\n' + code + '\n```' : '';
  const content = index % 13 === 0 ? '<script>alert("never execute")</script>\n' : '';
  return {
    id: prefix + '-' + index,
    role,
    text: (role === 'assistant' ? '### 方案 ' : '### 问题 ') +
      (index + 1) + '\n\n' + content + paragraphs + extra,
  };
}

export function syntheticConversation(count, prefix = 'demo') {
  if (!Number.isSafeInteger(count) || count < 0 || count > 20000) {
    throw new RangeError('Synthetic conversation must contain 0–20,000 messages');
  }
  return Array.from({ length: count }, (_, i) => syntheticMessage(i, prefix));
}
