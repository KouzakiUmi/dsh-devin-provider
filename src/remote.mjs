export const PLUGIN_NAME = 'dsh-devin-provider';
function wireCodec(type, parse) {
  return { mode: 'strict', typeSymbol: `${PLUGIN_NAME}#${type}`, schema: { parse }, create: () => ({ parse }) };
}
const requestCodec = wireCodec('Request', (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.op !== 'string') throw new Error('请求格式错误');
  return value;
});
const responseCodec = wireCodec('Response', (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('响应格式错误');
  return value;
});
export const devinRemote = {
  package: PLUGIN_NAME,
  descriptors: [
    {
      id: `${PLUGIN_NAME}#devinProvider/invoke`,
      service: 'devinProvider',
      namespace: 'devinProvider',
      method: 'invoke',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: requestCodec }],
      result: responseCodec
    }
  ]
};
