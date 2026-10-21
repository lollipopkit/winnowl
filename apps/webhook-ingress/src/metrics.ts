import client from 'prom-client';

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'webhook-ingress' });
client.collectDefaultMetrics({ register: registry });

export const webhookReceivedTotal = new client.Counter({
  name: 'webhook_received_total',
  help: '收到的 webhook 总数',
  labelNames: ['provider'],
  registers: [registry],
});

export const webhookProcessedTotal = new client.Counter({
  name: 'webhook_processed_total',
  help: '按结果分类的 webhook 处理数',
  labelNames: ['provider', 'result'],
  registers: [registry],
});

export const webhookInvalidTotal = new client.Counter({
  name: 'webhook_invalid_total',
  help: '验签失败的 webhook 总数',
  labelNames: ['provider'],
  registers: [registry],
});
