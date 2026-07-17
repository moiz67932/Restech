import type { PosConnector } from '@restec/connector-sdk';
import { canonicalRestConnector } from '@restec/connector-canonical-rest';
export const mockPosConnector: PosConnector = {
  ...canonicalRestConnector,
  id: 'mock_pos',
  displayName: 'Mock POS',
  version: '1.0.0',
  async deliverEvent(payload, ctx) {
    const mode = String(ctx.configuration.failure_mode ?? 'success');
    if (mode === 'timeout' || mode === '429' || mode === '500')
      return { outcome: 'retry', errorCode: `mock_${mode}` };
    if (mode === 'permanent') return { outcome: 'permanent_failure', errorCode: 'mock_permanent' };
    return { outcome: 'delivered', status: 202 };
  },
};
